import { z } from "zod";
import { digest } from "../core/digest.js";
import { AxisError } from "../grants/service.js";
import { CapabilityRegistry,type CapabilityDescriptor,type ProviderResult } from "../capabilities/registry.js";
export interface ExternalTool { id:string;description:string;inputSchema:Record<string,unknown>;outputSchema:Record<string,unknown>;version:string }
export interface ExternalCapabilitySource {
 readonly id:string;
 discover(toolId:string):Promise<ExternalTool>;
 connection(accountId:string):Promise<{active:boolean;userId:string}>;
 invoke(toolId:string,version:string,accountId:string,userId:string,args:Record<string,unknown>):Promise<{data:Record<string,unknown>;successful:boolean}>;
}
/** REST adapter only: no vendor sessions/planning, proxies or credential export. */
export class ComposioSource implements ExternalCapabilitySource {
 readonly id="composio";
 constructor(private apiKey:string,private transport:typeof fetch=fetch){}
 private async request(path:string,body?:Record<string,unknown>){
  const r=await this.transport(`https://backend.composio.dev/api/v3.1${path}`,{method:body?"POST":"GET",headers:{"x-api-key":this.apiKey,"content-type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new AxisError("catalog_unavailable");return r.json() as Promise<unknown>;
 }
 async discover(toolId:string):Promise<ExternalTool>{
  const t=z.object({slug:z.string(),description:z.string(),input_parameters:z.record(z.unknown()),output_parameters:z.record(z.unknown()).optional(),version:z.string()}).parse(await this.request(`/tools/${encodeURIComponent(toolId)}?toolkit_versions=latest`));
  if(t.slug!==toolId)throw new AxisError("catalog_tool_mismatch");
  return {id:t.slug,description:t.description,inputSchema:normalizeSchema(t.input_parameters),outputSchema:normalizeSchema(t.output_parameters??{type:"object"}),version:t.version};
 }
 async connection(accountId:string){
  const a=z.object({id:z.string(),status:z.string(),user_id:z.string(),is_disabled:z.boolean().optional()}).parse(await this.request(`/connected_accounts/${encodeURIComponent(accountId)}`));
  if(a.id!==accountId)throw new AxisError("catalog_account_mismatch");return {active:a.status==="ACTIVE"&&!a.is_disabled,userId:a.user_id};
 }
 async invoke(toolId:string,version:string,accountId:string,userId:string,args:Record<string,unknown>){
  return z.object({data:z.record(z.unknown()),successful:z.boolean()}).parse(await this.request(`/tools/execute/${encodeURIComponent(toolId)}`,{arguments:args,connected_account_id:accountId,user_id:userId,version}));
 }
}
export interface CatalogAllowance {capabilityId:string;toolId:string;accountId:string;userId:string;scopes:string[];risk:"read"|"write"|"external_commitment";mode:"LIVE"|"SANDBOX";verification?:{toolId:string;arguments:Record<string,unknown>;field:string;expected:unknown;referenceField:string}}
export async function registerExternalSource(registry:CapabilityRegistry,source:ExternalCapabilitySource,allowances:CatalogAllowance[]):Promise<void>{
 for(const allowed of allowances){
  const tool=await source.discover(allowed.toolId),connection=await source.connection(allowed.accountId);
  const resource=`catalog:${source.id}:${allowed.accountId}`;
  const d:CapabilityDescriptor={id:allowed.capabilityId,version:tool.version,provider:{id:source.id,kind:"external_api"},description:tool.description,inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,mode:allowed.mode,risk:allowed.risk,requiredScopes:allowed.scopes,reversible:allowed.risk==="read",contextTypes:[],health:connection.active&&connection.userId===allowed.userId?"healthy":"unhealthy",metadata:{remoteTool:tool.id,source:source.id,requiredResources:[resource],authorizedUserId:allowed.userId,connectionRequired:true}};
  const verify=allowed.verification?await source.discover(allowed.verification.toolId):undefined;
  registry.register(d,{async health(){const c=await source.connection(allowed.accountId);return c.active&&c.userId===allowed.userId?"healthy":"unhealthy";},resources:()=>[resource],async execute(args,c):Promise<ProviderResult>{
   if(c.userId!==allowed.userId)throw new AxisError("catalog_connection_owner");
   const current=await source.connection(allowed.accountId);
   if(!current.active||current.userId!==c.userId){registry.setHealth(d.id,"unhealthy");throw new AxisError("catalog_connection_unavailable");}
   if(digest(await source.discover(tool.id))!==digest(tool)){registry.setHealth(d.id,"unhealthy");throw new AxisError("catalog_schema_changed");}
   const r=await source.invoke(tool.id,tool.version,allowed.accountId,c.userId,args);
   if(!r.successful)return {outcome:allowed.risk==="read"?"failed":"unknown",data:r.data};
   if(allowed.risk==="read")return {outcome:"succeeded",data:r.data};
   // A separate authoritative read must prove the configured target state.
   // Vendor successful:true by itself leaves this write VERIFYING.
   if(verify&&allowed.verification){
    const evidence=await source.invoke(verify.id,verify.version,allowed.accountId,c.userId,allowed.verification.arguments);
    const ref=evidence.data[allowed.verification.referenceField];
    if(evidence.successful&&digest(evidence.data[allowed.verification.field])===digest(allowed.verification.expected)&&typeof ref==="string")return {outcome:"succeeded",data:r.data,providerRef:ref,targetState:"verified external state"};
   }
   return {outcome:"succeeded",data:r.data};
  }});
 }
}

function normalizeSchema(raw:Record<string,unknown>):Record<string,unknown>{
 if(raw.type==="object")return raw;
 const properties:Record<string,unknown>={},required:string[]=[];
 for(const [name,value] of Object.entries(raw)){
  const field=z.record(z.unknown()).parse(value);if(field.required===true)required.push(name);
  const cleaned={...field};delete cleaned.required;properties[name]=cleaned;
 }
 return {type:"object",properties,required,additionalProperties:false};
}
export async function registerConfiguredCatalog(registry:CapabilityRegistry,env:NodeJS.ProcessEnv=process.env):Promise<void>{
 const config=z.array(z.object({capabilityId:z.string(),toolId:z.string(),accountId:z.string(),userId:z.string(),scopes:z.array(z.string()),risk:z.enum(["read","write","external_commitment"]),mode:z.enum(["LIVE","SANDBOX"])}).strict()).max(20).parse(JSON.parse(env.AXIS_COMPOSIO_TOOLS??"[]"));
 if(!config.length)return;
 if(!env.COMPOSIO_API_KEY)throw new AxisError("composio_not_configured");
 await registerExternalSource(registry,new ComposioSource(env.COMPOSIO_API_KEY),config);
}
