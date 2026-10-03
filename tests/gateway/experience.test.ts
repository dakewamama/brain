import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {createServer,type Server} from "node:http";
import {Pool} from "pg";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CapabilityRegistry} from "../../src/capabilities/registry.js";
import {registerExternalSource,type ExternalCapabilitySource} from "../../src/catalog/source.js";
import {PlaywrightBrowserProvider,registerBrowser} from "../../src/browser/provider.js";
import {HumanTaskService} from "../../src/human/service.js";
import {AxisGateway} from "../../src/gateway/service.js";
import {createMcpApp} from "../../src/mcp/server.js";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";
const url=process.env.TEST_DATABASE_URL;
if(!url)test("experience acceptance requires PostgreSQL",{skip:true},()=>{});
else{
 const schema=`test_${randomUUID().replaceAll("-","")}`,admin=new Pool({connectionString:url});
 const isolated=new URL(url);isolated.searchParams.set("options",`-c search_path=${schema}`);
 const pool=new Pool({connectionString:isolated.toString(),max:20}),userId=randomUUID(),registry=new CapabilityRegistry();
 const browser=new PlaywrightBrowserProvider(pool,"/tmp/axis-experience-browser",5000),human=new HumanTaskService(pool);
 let gateway:AxisGateway,website:Server,mcp:Server,origin:string,endpoint:URL,operator:string,title="",readCalls=0;
 const capabilities=["apps.documents.lookup","browser.act","browser.verify","human.request"];
 const source:ExternalCapabilitySource={id:"composio",async discover(id){return {id,description:"lookup document structured availability",version:"test-contract-v1",inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false},outputSchema:{type:"object"}};},async connection(){return {active:true,userId};},async invoke(){readCalls++;return {successful:true,data:{structuredEditAvailable:false,reason:"sandbox has no edit API"}};}};
 before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);process.env.DATABASE_URL=isolated.toString();resetConfigForTests();await migrate();
  await registerExternalSource(registry,source,[{capabilityId:capabilities[0],toolId:"DOCUMENT_LOOKUP",accountId:"learning",userId,scopes:["documents.read"],risk:"read",mode:"SANDBOX"}]);registerBrowser(registry,browser,"SANDBOX");human.register(registry);gateway=new AxisGateway(pool,registry);
  operator=(await human.issueOperator(userId,new Date(Date.now()+600000))).token;
  website=createServer(async(req,res)=>{if(req.method==="POST"){const chunks=[];for await(const c of req)chunks.push(c);title=new URLSearchParams(Buffer.concat(chunks).toString()).get("title")??"";res.writeHead(303,{location:"/"});res.end();return;}res.setHeader("content-type","text/html");res.end(`<form method="post"><input name="title" id="title"><button id="save">Save</button></form><div id="result">${title}</div>`);});await new Promise<void>(r=>website.listen(0,"127.0.0.1",r));origin=`http://127.0.0.1:${(website.address() as {port:number}).port}`;
  mcp=createMcpApp(gateway).listen(0,"127.0.0.1");await new Promise<void>(r=>mcp.once("listening",r));endpoint=new URL(`http://127.0.0.1:${(mcp.address() as {port:number}).port}/mcp`);
 });
 after(async()=>{website?.closeAllConnections();mcp?.closeAllConnections();if(website)await new Promise<void>(r=>website.close(()=>r()));if(mcp)await new Promise<void>(r=>mcp.close(()=>r()));await pool.end();await closePool();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 async function run(value:string,steps?:unknown[]){
  const sessionId=await browser.createSession({userId,origin,paths:["/"],selectors:["#title","#save","#result"],mode:"SANDBOX",expiresAt:new Date(Date.now()+600000)});
  const token=(await gateway.grants.issue({clientId:randomUUID(),clientName:"experience client",userId,expiresAt:new Date(Date.now()+600000),authority:{scopes:["documents.read","browser.act","browser.verify","human.request"],capabilities,resources:[`browser:${sessionId}`,"catalog:composio:learning"],contextTypes:[],financial:null,requireApproval:false,modes:["LIVE","SANDBOX"]}})).token;
  const client=new Client({name:"learning-acceptance",version:"1"});await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{authorization:`Bearer ${token}`}}}));
  async function call(name:string,arguments_:Record<string,unknown>){const r=await client.callTool({name,arguments:arguments_});assert.ok(!r.isError,JSON.stringify(r));return (r.structuredContent as {result:Record<string,unknown>}).result;}
  try{
   const parameters={session:sessionId,path:"/",field:"#title",button:"#save",result:"#result",title:value,initialRevision:0,afterRevision:1,purpose:"Human review needed because this sandbox has no automated editorial approval"};
   const started=performance.now();
   const prep=await call("axis.prepare",{goal:"Update and verify a document with editorial review",constraints:{taskShape:"document_update_review_v1",parameters,...(steps?{steps}:{})}});
   await call("axis.execute",{preparationId:prep.preparationId});await gateway.runner.wakeDueCases(new Date(Date.now()+1000));
   const waiting=await call("axis.status",{workId:prep.workId});assert.equal(waiting.status,"WAITING_HUMAN");
   const restarted=new HumanTaskService(pool);await restarted.resolve(operator,String(waiting.actionId),{decision:"confirm",evidence:{reference:"sandbox-editorial-review",description:"Reviewed current sandbox document"}});
   await gateway.runner.wakeDueCases(new Date(Date.now()+1000));const complete=await call("axis.status",{workId:prep.workId});assert.equal(complete.status,"COMPLETED");assert.equal(complete.verification,"VERIFIED");assert.equal(title,value);
   const trace=(await pool.query("SELECT * FROM experience_traces WHERE case_id=$1",[prep.workId])).rows[0];assert.ok(trace);trace.metrics.monotonicDurationMs=Math.round(performance.now()-started);return {prep,complete,trace};
  }finally{await client.close();}
 }
 test("external MCP first run learns; second run reuses; repeated verified runs compile with explicit evaluation",{timeout:60000},async()=>{
  const steps=[
   {query:"lookup document",bindings:{query:"title"}},
   {capabilityId:"apps.documents.edit.unavailable",fallback:["browser.act"],bindings:{sessionId:"session",path:"path",selector:"field",clickSelector:"button",verifySelector:"result",expected:"title",value:"title",revision:"initialRevision"}},
   {capabilityId:"human.request",bindings:{purpose:"purpose"}},
   {capabilityId:"browser.verify",bindings:{sessionId:"session",path:"path",selector:"result",expected:"title",revision:"afterRevision"}},
  ];
  const first=await run("Private first document",steps);assert.equal(first.trace.metrics.capabilitySearches,1);assert.equal(first.trace.metrics.level,"DISCOVERY");assert.equal(first.trace.metrics.executionSteps,4);
  const book=(await pool.query("SELECT * FROM experience_playbooks WHERE user_id=$1",[userId])).rows[0];assert.equal(book.stage,"CANDIDATE");
  assert.ok(!JSON.stringify(book.structure).includes("Private first document"));assert.ok(!JSON.stringify(book.structure).includes(origin));assert.ok(!JSON.stringify(book.structure).includes(userId));
  await assert.rejects(gateway.experience.promote(operator,book.id,"COMPILED"),/invalid_promotion/);
  await gateway.experience.promote(operator,book.id,"VERIFIED");await assert.rejects(gateway.experience.promote(operator,book.id,"PROVEN"),/insufficient_verified_runs/);
  const second=await run("Different private document");assert.equal(second.trace.metrics.capabilitySearches,0);assert.equal(second.trace.metrics.level,"PLAYBOOK");assert.equal(second.trace.metrics.executionSteps,4);
  await gateway.experience.promote(operator,book.id,"PROVEN");await run("Third verified document");await gateway.experience.promote(operator,book.id,"COMPILED_CANDIDATE");await gateway.experience.promote(operator,book.id,"COMPILED");
  const fourth=await run("Compiled document");assert.equal(fourth.trace.metrics.level,"COMPILED");assert.equal(fourth.trace.metrics.capabilitySearches,0);assert.equal(readCalls,4);
  const metrics={first:first.trace.metrics,second:second.trace.metrics,compiled:fourth.trace.metrics,claim:"reduced capability rediscovery; no LLM was called in either run",vendor:"Composio adapter contract fixture; no live account configured",browser:"real Chromium local sandbox"};
  await writeFile('/tmp/axis-experience-acceptance.json',JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics));
 });
}
