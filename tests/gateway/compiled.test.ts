import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn,type ChildProcess} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve,join} from "node:path";
import {createServer} from "node:http";
import {Pool} from "pg";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {GrantService} from "../../src/grants/service.js";
const base=process.env.TEST_DATABASE_URL;
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
test("two compiled MCP processes migrate, execute one action, enforce filesystem grants and survive restart",{skip:!base,timeout:90000},async()=>{
 const schema=`compiled_${randomUUID().replaceAll("-","")}`,admin=new Pool({connectionString:base});await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(base!);url.searchParams.set("options",`-c search_path=${schema}`);const db=new Pool({connectionString:url.toString()});
 const directory=await mkdtemp(join(tmpdir(),"axis-approved-docs-"));const path=join(directory,"guide.txt");await writeFile(path,"Axis approved document: durable execution with scoped authority.\n");
 const processes:ChildProcess[]=[],clients:Client[]=[];
 const upstream=[{id:"approved-docs",transport:"stdio",command:process.execPath,args:[resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js"),directory],executionMode:"LIVE",allowedTools:{read_text_file:{capabilityId:"apps.documents.read",risk:"read",requiredScopes:["documents.read"],resources:["documents:approved"],outputSchema:{type:"object",properties:{content:{type:"string"}},required:["content"],additionalProperties:false}}}}];
 async function start(){const port=await freePort();const child=spawn(process.execPath,["dist/mcp/main.js"],{env:{PATH:process.env.PATH,DATABASE_URL:url.toString(),PORT:String(port),MCP_HOST:"127.0.0.1",NODE_ENV:"test",CASE_WORKER_POLL_MS:"100",AXIS_UPSTREAM_MCP:JSON.stringify(upstream)},stdio:["ignore","pipe","pipe"]});processes.push(child);let logs="";
  await new Promise<void>((ok,no)=>{const timer=setTimeout(()=>no(new Error(`compiled startup timed out: ${logs}`)),20000);child.stdout!.on("data",b=>{logs+=b;if(logs.includes("Axis MCP ready")){clearTimeout(timer);ok();}});child.stderr!.on("data",b=>{logs+=b;});child.once("exit",code=>{clearTimeout(timer);no(new Error(`compiled server exited ${code}: ${logs}`));});});return {child,endpoint:new URL(`http://127.0.0.1:${port}/mcp`)};
 }
 async function connect(endpoint:URL,token:string){const c=new Client({name:"compiled-external-client",version:"1"});await c.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{authorization:`Bearer ${token}`}}}));clients.push(c);return c;}
 async function call(c:Client,name:string,args:Record<string,unknown>){const r=await c.callTool({name,arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r));return (r.structuredContent as {result:Record<string,unknown>}).result;}
 async function completed(c:Client,workId:unknown){for(let i=0;i<100;i++){const s=await call(c,"axis.status",{workId});if(s.status==="COMPLETED")return s;assert.ok(!["FAILED","IN_DOUBT"].includes(String(s.status)),JSON.stringify(s));await new Promise(r=>setTimeout(r,100));}throw new Error("case did not complete");}
 async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const stopped=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");await stopped;}
 try {
  // Fresh database, simultaneous startup: migration serialization is exercised.
  const [a,b]=await Promise.all([start(),start()]);
  const grants=new GrantService(db);const authority={scopes:["documents.read"],capabilities:["apps.documents.read"],contextTypes:[],resources:["documents:approved"],financial:null,requireApproval:false,modes:["UPSTREAM_MCP" as const]};
  const issued=await grants.issue({clientId:"external",clientName:"documents client",userId:"document-owner",authority,expiresAt:new Date(Date.now()+600000)});
  const c1=await connect(a.endpoint,issued.token),c2=await connect(b.endpoint,issued.token);
  const search=await call(c1,"axis.capabilities.search",{});assert.ok(JSON.stringify(search).includes("apps.documents.read"));assert.ok(!JSON.stringify(search).includes("write_file"));
  const prepared=await call(c1,"axis.prepare",{goal:"Read approved documentation",constraints:{capabilityId:"apps.documents.read",arguments:{path}}});
  await Promise.all(Array.from({length:6},(_,i)=>call(i%2?c1:c2,"axis.execute",{preparationId:prepared.preparationId})));
  const status=await completed(c1,prepared.workId);assert.match(JSON.stringify(status.result),/scoped authority/);assert.equal(status.providerMode,"LIVE");
  const count=await db.query("SELECT COUNT(*)::int AS n FROM provider_attempts");assert.equal(count.rows[0].n,2,"one submission and one result, no duplicate effect");
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM actions")).rows[0].n,1);
  await assert.rejects(db.query("UPDATE evidence SET payload='{}'"),/immutable/);
  await assert.rejects(db.query("UPDATE actions SET idempotency_key='another-intent'"),/immutable/);
  const denied=await grants.issue({clientId:"other",clientName:"unconnected",userId:"another-user",authority:{...authority,resources:[]},expiresAt:new Date(Date.now()+600000)});
  const noResource=await connect(a.endpoint,denied.token);assert.deepEqual(await call(noResource,"axis.capabilities.search",{}),[]);
  const deniedInvoke=await noResource.callTool({name:"axis.capabilities.invoke",arguments:{capabilityId:"apps.documents.read",arguments:{path},idempotencyKey:"denied"}});assert.equal(deniedInvoke.isError,true);
  const hidden=await c1.callTool({name:"axis.capabilities.invoke",arguments:{capabilityId:"write_file",arguments:{path,content:"bad"},idempotencyKey:"write"}});assert.equal(hidden.isError,true);
  const escape=await call(c1,"axis.capabilities.invoke",{capabilityId:"apps.documents.read",arguments:{path:resolve("package.json")},idempotencyKey:"escape"});
  for(let i=0;i<100;i++){const state=await call(c1,"axis.status",{workId:escape.workId});if(state.status==="FAILED")break;if(i===99)assert.fail("directory escape did not fail");await new Promise(r=>setTimeout(r,100));}
  // Restart the actual compiled application; completed work remains durable.
  await c1.close();await stop(a.child);const restarted=await start();const c3=await connect(restarted.endpoint,issued.token);
  const replay=await call(c3,"axis.execute",{preparationId:prepared.preparationId});assert.equal(replay.status,"COMPLETED");assert.equal(replay.actionId,status.actionId);
  assert.equal((await call(c3,"axis.cancel",{workId:prepared.workId})).result,"CANNOT_CANCEL");
  const cancel=await call(c3,"axis.prepare",{goal:"cancel race",constraints:{capabilityId:"apps.documents.read",arguments:{path}}});
  const [,cancelled]=await Promise.all([call(c2,"axis.execute",{preparationId:cancel.preparationId}),call(c3,"axis.cancel",{workId:cancel.workId})]);
  if(cancelled.result==="CANCELLED") {
   await new Promise(r=>setTimeout(r,300));assert.equal((await call(c3,"axis.status",{workId:cancel.workId})).status,"CANCELLED");
   assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM provider_attempts p JOIN actions a ON a.id=p.action_id WHERE a.case_id=$1",[cancel.workId])).rows[0].n,0);
  }else assert.equal(cancelled.result,"CANNOT_CANCEL");
 } finally {
  await Promise.all(clients.map(c=>c.close().catch(()=>{})));await Promise.all(processes.map(stop));await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});
 }
});
