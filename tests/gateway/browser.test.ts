import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {Pool} from "pg";
import {PlaywrightBrowserProvider,registerBrowser} from "../../src/browser/provider.js";
import {CapabilityRegistry} from "../../src/capabilities/registry.js";
import {AxisGateway} from "../../src/gateway/service.js";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";
const url=process.env.TEST_DATABASE_URL;
if(!url)test("browser durability requires PostgreSQL",{skip:true},()=>{});
else{
 const pool=new Pool({connectionString:url});const registry=new CapabilityRegistry();const provider=new PlaywrightBrowserProvider(pool,"/tmp/axis-browser-tests",700);registerBrowser(registry,provider,"SANDBOX");const gateway=new AxisGateway(pool,registry);
 let server:Server,origin:string,sessionId:string,token:string,title="Before";
 before(async()=>{process.env.DATABASE_URL=url;resetConfigForTests();await migrate();
  server=createServer(async(req,res)=>{if(req.url==="/slow")return;if(req.method==="POST"){const chunks=[];for await(const c of req)chunks.push(c);title=new URLSearchParams(Buffer.concat(chunks).toString()).get("title")??title;res.writeHead(303,{location:"/"});res.end();return;}res.setHeader("content-type","text/html");res.end(`<form method="post"><input id="title" name="title"><button id="save">Save</button></form><div id="result">${title}</div>`);});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const userId=randomUUID();sessionId=await provider.createSession({userId,origin,paths:["/","/slow"],selectors:["#title","#save","#result"],mode:"SANDBOX",expiresAt:new Date(Date.now()+600000)});
  token=(await gateway.grants.issue({userId,clientId:randomUUID(),clientName:"browser test",expiresAt:new Date(Date.now()+600000),authority:{scopes:["browser.observe","browser.act","browser.extract","browser.verify"],capabilities:["browser.observe","browser.act","browser.extract","browser.verify"],contextTypes:[],resources:[`browser:${sessionId}`],financial:null,requireApproval:false,modes:["SANDBOX"]}})).token;
 });
 after(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(r=>server.close(()=>r()));await pool.end();await closePool();});
 async function invoke(capabilityId:string,extra:Record<string,unknown>={}){const p=await gateway.invokeCapability(token,{capabilityId,arguments:{sessionId,path:"/",selector:"#result",revision:0,...extra},idempotencyKey:randomUUID()}) as {workId:string};await pool.query("UPDATE cases SET status='running' WHERE id=$1",[p.workId]);await gateway.runner.advance(p.workId);return gateway.status(token,{workId:p.workId});}
 test("real Chromium observes then changes website state with exact persisted evidence",async()=>{
  const read=await invoke("browser.observe");assert.equal(read.status,"COMPLETED");assert.equal((read.result as {text:string}).text,"Before");
  const changed=await invoke("browser.act",{selector:"#title",value:"Verified",clickSelector:"#save",verifySelector:"#result",expected:"Verified"});assert.equal(changed.status,"COMPLETED");assert.equal(title,"Verified");
  const evidence=await gateway.store.listEvidence(String(changed.workId));const receipt=evidence.find(e=>e.kind==="provider_receipt")!;assert.equal((receipt.payload.data as {text:string}).text,"Verified");assert.equal((receipt.payload.data as {url:string}).url,origin+"/");
 });
 test("stale session, unknown session, timeout, and missing postcondition cannot report completion",async()=>{
  assert.equal((await invoke("browser.observe")).status,"FAILED");
  assert.equal((await invoke("browser.observe",{revision:1,path:"/slow"})).status,"FAILED");
  const absent=await invoke("browser.act",{revision:1,selector:"#title",value:"Changed",clickSelector:"#save",verifySelector:"#result",expected:"Absent"});assert.equal(absent.status,"VERIFYING");
  const principal=await gateway.grants.authenticate(token);
  await assert.rejects(provider.perform("observe",{sessionId:"missing",path:"/",selector:"#result",revision:0},{actionId:"x",idempotencyKey:"x",userId:principal.userId,context:[]}),/browser_session_unavailable/);
  await assert.rejects(gateway.invokeCapability(token,{capabilityId:"browser.observe",arguments:{sessionId:"ungranted",path:"/",selector:"#result",revision:0},idempotencyKey:"denied"}),/resource_not_allowed/);
 });
}
