import { digest } from "../core/digest.js";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import { childEnv } from "./bootstrap.js";

const tool=z.object({capabilityId:z.string(),risk:z.enum(["read","write","external_commitment"]),requiredScopes:z.array(z.string()).min(1),outputSchema:z.record(z.unknown()),resources:z.array(z.string()).default([]),proof:z.object({stateField:z.string(),expectedState:z.string(),referenceField:z.string()}).strict().optional()}).strict();
const common={id:z.string().regex(/^[a-zA-Z0-9_-]+$/),executionMode:z.enum(["LIVE","SANDBOX"]),allowedTools:z.record(tool),timeoutMs:z.number().int().min(100).max(30000).default(10000)};
export const upstreamSchema=z.discriminatedUnion("transport",[
 z.object({...common,transport:z.literal("stdio"),command:z.string(),args:z.array(z.string()).default([]),passEnv:z.array(z.string()).default([])}).strict(),
 z.object({...common,transport:z.literal("http"),url:z.string().url(),tokenEnv:z.string().optional()}).strict(),
]);
export type UpstreamConfig=z.infer<typeof upstreamSchema>;
/** Explicit server AND tool allowlists. MCP annotations cannot confer authority.
 * Protocol, pagination, cancellation and reconnection remain SDK responsibilities. */
export async function connectUpstream(registry:CapabilityRegistry,raw:unknown):Promise<{close:()=>Promise<void>;registered:string[]}> {
 const config=upstreamSchema.parse(raw);
 if(process.env.NODE_ENV==="production"&&config.executionMode!=="LIVE") throw new Error("sandbox upstream is not enabled in production");
 if(config.transport==="http") {
  const url=new URL(config.url);
  if(url.username||url.password||url.hash||url.search) throw new Error("upstream URL must not contain credentials, query or fragment");
  if(url.protocol!=="https:" && !(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname))) throw new Error("remote MCP requires HTTPS");
 }
 const client=new Client({name:"axis-upstream",version:"1.0.0"});
 const transport=config.transport==="stdio"?
  new StdioClientTransport({command:config.command,args:config.args,env:childEnv({name:config.id,command:config.command,passEnv:config.passEnv},process.env),stderr:"pipe"}):
  new StreamableHTTPClientTransport(new URL(config.url),{requestInit:config.tokenEnv?{headers:{authorization:`Bearer ${requiredEnv(config.tokenEnv)}`}}:undefined});
 const registered:string[]=[];
 client.onclose=()=>{for(const id of registered)registry.setHealth(id,"unhealthy");};
 try {
  await client.connect(transport,{timeout:Math.max(10000,config.timeoutMs)});
  if(transport instanceof StdioClientTransport) transport.stderr?.on("data",()=>{});
  let cursor:string|undefined;
  const seen=new Set<string>();
  do {
   const page=await client.listTools(cursor?{cursor}:{},{timeout:Math.max(10000,config.timeoutMs)});
   for(const discovered of page.tools) {
    const allowed=config.allowedTools[discovered.name];if(!allowed) continue;
    const id=allowed.capabilityId;
    registry.register({id,version:"1",provider:{id:config.id,kind:"upstream_mcp"},description:discovered.description??discovered.name,inputSchema:discovered.inputSchema,outputSchema:allowed.outputSchema,mode:"UPSTREAM_MCP",risk:allowed.risk,requiredScopes:allowed.requiredScopes,reversible:allowed.risk==="read",contextTypes:[],health:"healthy",metadata:{serverId:config.id,origin:config.transport==="http"?config.url:`stdio:${config.command}`,toolName:discovered.name,executionMode:config.executionMode,requiredResources:allowed.resources}}, {
     resources:()=>allowed.resources,
     async execute(args) {
      // An upstream can change tools without restarting Axis. Revalidate the
      // advertised contract before allowing any effect under a prepared schema.
      let currentCursor:string|undefined;let currentSchema:unknown;
      const cursors=new Set<string>();
      do {
        const current=await client.listTools(currentCursor?{cursor:currentCursor}:{},{timeout:Math.max(10000,config.timeoutMs)});
        const found=current.tools.find(t=>t.name===discovered.name);
        if(found) {currentSchema={input:found.inputSchema,output:found.outputSchema};break;}
        currentCursor=current.nextCursor;
        if(currentCursor&&cursors.has(currentCursor))throw new Error("upstream repeated discovery cursor");
        if(currentCursor)cursors.add(currentCursor);
      }while(currentCursor);
      if(!currentSchema || digest(currentSchema)!==digest({input:discovered.inputSchema,output:discovered.outputSchema})) {
        registry.setHealth(id,"unhealthy");throw new Error("upstream schema changed; operator refresh required");
      }
      const result=await client.callTool({name:discovered.name,arguments:args},undefined,{timeout:config.timeoutMs});
      if(JSON.stringify(result).length>65536)throw new Error("upstream result too large");
      let data:Record<string,unknown>;
      if(result.structuredContent && typeof result.structuredContent==="object") data=result.structuredContent as Record<string,unknown>;
      else {
       const content=Array.isArray(result.content)?result.content:[];
       const text=content.filter((c:unknown):c is {type:"text";text:string}=>!!c&&typeof c==="object"&&(c as {type?:string}).type==="text"&&typeof(c as {text?:unknown}).text==="string").map(c=>c.text).join("\n");
       data={text:text.slice(0,16000)};
      }
      // isError cannot establish a definitive external write failure.
      if(result.isError) return {outcome:allowed.risk==="read"?"failed":"unknown",data};
      const proof=allowed.proof;
      const ref=proof?data[proof.referenceField]:undefined;
      const confirmed=proof && data[proof.stateField]===proof.expectedState && typeof ref==="string" && ref.length>0;
      return {outcome:"succeeded",data,...(confirmed?{targetState:proof.expectedState,providerRef:ref as string}:{})};
     },
    });registered.push(id);
   }
   cursor=page.nextCursor;
   if(cursor&&seen.has(cursor)) throw new Error("upstream repeated discovery cursor");
   if(cursor) seen.add(cursor);
  }while(cursor);
  return {registered,close:async()=>{for(const id of registered)registry.setHealth(id,"unhealthy");await client.close();}};
 }catch(error){for(const id of registered)registry.setHealth(id,"unhealthy");await client.close().catch(()=>{});throw error;}
}
function requiredEnv(name:string):string{const value=process.env[name];if(!value)throw new Error(`missing upstream credential: ${name}`);return value;}
