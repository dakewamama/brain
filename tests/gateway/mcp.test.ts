import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {spawn,type ChildProcess} from "node:child_process";
import {createServer,type Server} from "node:http";
import {Pool} from "pg";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CapabilityRegistry} from "../../src/capabilities/registry.js";
import {registerCoreCapabilities} from "../../src/capabilities/core.js";
import {AxisGateway} from "../../src/gateway/service.js";
import {createMcpApp} from "../../src/mcp/server.js";
import {connectUpstream} from "../../src/mcp/upstream.js";
import {CaseWorker} from "../../src/cases/worker.js";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";
const url=process.env.TEST_DATABASE_URL;
if(!url)test("MCP integration requires PostgreSQL",{skip:true},()=>{});
else {
 const schema=`mcp_${randomUUID().replaceAll("-","")}`;
 const admin=new Pool({connectionString:url});
 const isolated=new URL(url);isolated.searchParams.set("options",`-c search_path=${schema}`);
 const pool=new Pool({connectionString:isolated.toString(),max:20});const registry=new CapabilityRegistry();
 registerCoreCapabilities(registry,{env:{}});const gateway=new AxisGateway(pool,registry);const worker=new CaseWorker(gateway.runner,gateway.store);
 let server:Server,reference:ChildProcess,endpoint:string,token:string;let upstream:{close:()=>Promise<void>},stdio:{close:()=>Promise<void>};
 async function port():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
 before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);process.env.DATABASE_URL=isolated.toString();resetConfigForTests();await migrate();
  const referencePort=await port();
  reference=spawn(process.execPath,["node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js"],{env:{PATH:process.env.PATH,MCP_PORT:String(referencePort)},stdio:["ignore","pipe","pipe"]});
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error("reference MCP did not start")),10000);
   reference.stdout?.on("data",b=>{if(String(b).includes("listening")){clearTimeout(timer);resolve();}});
   reference.once("exit",code=>{clearTimeout(timer);reject(new Error(`reference MCP exited ${code}`));});
  });
  upstream=await connectUpstream(registry,{id:"sdk-reference",transport:"http",url:`http://127.0.0.1:${referencePort}/mcp`,executionMode:"SANDBOX",allowedTools:{greet:{capabilityId:"apps.reference.greet",risk:"read",requiredScopes:["apps.reference.read"],outputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false}}}});
  stdio=await connectUpstream(registry,{id:"fixture",transport:"stdio",command:process.execPath,args:["--import","tsx","tests/fixtures/upstream.ts"],executionMode:"SANDBOX",timeoutMs:1000,allowedTools:{read:{capabilityId:"apps.fixture.read",risk:"read",requiredScopes:["fixture"],outputSchema:{type:"object"}},slow:{capabilityId:"apps.fixture.slow",risk:"write",requiredScopes:["fixture"],outputSchema:{type:"object"}}}});
  const credentials=await gateway.grants.issue({clientId:randomUUID(),clientName:"external SDK client",userId:randomUUID(),authority:{scopes:["location.context","context:location.coarse","apps.reference.read","fixture"],capabilities:["location.context","apps.reference.greet","apps.fixture.read","apps.fixture.slow"],contextTypes:["location.coarse"],resources:[],financial:null,requireApproval:false,modes:["LIVE","UPSTREAM_MCP"]},expiresAt:new Date(Date.now()+600000)});token=credentials.token;
  const p=await gateway.grants.authenticate(token);await gateway.context.put(p.userId,{type:"location.coarse",value:{country:"NG",region:"Lagos"},source:"authenticated user",observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),sensitivity:"standard",caseId:null});
  server=createMcpApp(gateway).listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`;
 });
 after(async()=>{await upstream?.close();await stdio?.close();reference?.kill();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();await closePool();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 async function client(){const c=new Client({name:"external-test",version:"1"});await c.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{authorization:`Bearer ${token}`}}}));return c;}
 async function call(c:Client,name:string,args:Record<string,unknown>){const result=await c.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return (result.structuredContent as {result:Record<string,unknown>}).result;}
 test("external SDK client authenticates, searches, prepares, executes, sees durable proof and scoped context",async()=>{
  const c=await client();try {
   assert.deepEqual((await c.listTools()).tools.map(t=>t.name).sort(),["axis.prepare","axis.execute","axis.status","axis.cancel","axis.capabilities.search","axis.capabilities.invoke"].sort());
   const search=await call(c,"axis.capabilities.search",{});assert.ok(JSON.stringify(search).includes("location.context"));assert.ok(!JSON.stringify(search).includes("hidden"));
   const prepared=await call(c,"axis.prepare",{goal:"Where am I?",constraints:{capabilityId:"location.context",arguments:{precision:"coarse"}}});
   assert.equal(prepared.executionPossible,true);
   await call(c,"axis.execute",{preparationId:prepared.preparationId});await worker.tick();
   const status=await call(c,"axis.status",{workId:prepared.workId});assert.equal(status.status,"COMPLETED");assert.equal(status.verification,"VERIFIED");assert.ok(!JSON.stringify(status.result).includes("latitude"));
   const exact=await call(c,"axis.prepare",{goal:"exact",constraints:{capabilityId:"location.context",arguments:{precision:"exact"}}});assert.equal(exact.executionPossible,false);
   const cancelled=await call(c,"axis.cancel",{workId:exact.workId});assert.equal(cancelled.result,"CANCELLED");
  }finally{await c.close();}
 });
 test("real SDK reference upstream follows discover-normalize-grant-invoke-evidence-proof",async()=>{
  const c=await client();try {
   const first=await call(c,"axis.capabilities.invoke",{capabilityId:"apps.reference.greet",arguments:{name:"Axis"},idempotencyKey:"reference-greeting"});
   await worker.tick();const result=await call(c,"axis.status",{workId:first.workId});assert.equal(result.status,"COMPLETED");assert.equal(result.mode,"UPSTREAM_MCP");assert.equal(result.providerMode,"SANDBOX");assert.match(JSON.stringify(result.result),/Axis/);
   const replay=await call(c,"axis.capabilities.invoke",{capabilityId:"apps.reference.greet",arguments:{name:"Axis"},idempotencyKey:"reference-greeting"});assert.equal(replay.workId,first.workId);
   assert.equal((await gateway.store.listActions(String(first.workId))).length,1);
   assert.ok((await gateway.store.listEvidence(String(first.workId))).some(e=>e.kind==="verification"));
   const stdioResult=await call(c,"axis.capabilities.invoke",{capabilityId:"apps.fixture.read",arguments:{query:"via stdio"},idempotencyKey:"stdio"});await worker.tick();assert.equal((await call(c,"axis.status",{workId:stdioResult.workId})).status,"COMPLETED");
   const slow=await call(c,"axis.capabilities.invoke",{capabilityId:"apps.fixture.slow",arguments:{},idempotencyKey:"slow"});await worker.tick();assert.equal((await call(c,"axis.status",{workId:slow.workId})).status,"IN_DOUBT");assert.equal((await call(c,"axis.cancel",{workId:slow.workId})).result,"CANNOT_CANCEL");
  }finally{await c.close();}
 });
 test("oversized output is rejected and changed upstream schema becomes unavailable",async()=>{
  const c=await client();try {
   const large=await call(c,"axis.capabilities.invoke",{capabilityId:"apps.fixture.read",arguments:{query:"__oversize__"},idempotencyKey:"large"});await worker.tick();assert.equal((await call(c,"axis.status",{workId:large.workId})).status,"FAILED");
   const change=await call(c,"axis.capabilities.invoke",{capabilityId:"apps.fixture.read",arguments:{query:"__change_schema__"},idempotencyKey:"change"});await worker.tick();assert.equal((await call(c,"axis.status",{workId:change.workId})).status,"COMPLETED");
   const stale=await call(c,"axis.capabilities.invoke",{capabilityId:"apps.fixture.read",arguments:{query:"old schema"},idempotencyKey:"drift"});await worker.tick();assert.equal((await call(c,"axis.status",{workId:stale.workId})).status,"FAILED");
   assert.equal(registry.get("apps.fixture.read")?.health,"unhealthy");
   assert.ok(!JSON.stringify(await call(c,"axis.capabilities.search",{})).includes("apps.fixture.read"));
  }finally{await c.close();}
 });
 test("unauthorized clients, malformed requests, foreign origins and authorization controls fail safely",async()=>{
  assert.equal((await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,401);
  assert.equal((await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer wrong"},body:"{}"})).status,401);
  assert.equal((await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:"{"})).status,400);
  assert.equal((await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`,origin:"https://evil.example"},body:"{}"})).status,403);
  const c=await client();try {
   const result=await c.callTool({name:"axis.prepare",arguments:{goal:"x",userId:"someone-else",approved:true}});assert.equal(result.isError,true);
   const hidden=await c.callTool({name:"axis.capabilities.invoke",arguments:{capabilityId:"fixture.hidden",arguments:{},idempotencyKey:"hidden"}});assert.equal(hidden.isError,true);
  }finally{await c.close();}
 });
}
