import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {CapabilityRegistry} from "../../src/capabilities/registry.js";
import {registerExternalSource,ComposioSource,type ExternalCapabilitySource} from "../../src/catalog/source.js";
import {AxisGateway} from "../../src/gateway/service.js";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";
const url=process.env.TEST_DATABASE_URL;
if(!url)test("catalog requires PostgreSQL",{skip:true},()=>{});
else{
 const schema=`test_${randomUUID().replaceAll("-","")}`,admin=new Pool({connectionString:url});
 const isolated=new URL(url);isolated.searchParams.set("options",`-c search_path=${schema}`);
 const pool=new Pool({connectionString:isolated.toString()}),userId=randomUUID();let active=true,calls=0,timeout=false;
 const source:ExternalCapabilitySource={id:"composio",async discover(id){return {id,version:"v1",description:"document operation",inputSchema:{type:"object",properties:{title:{type:"string"}},required:["title"],additionalProperties:false},outputSchema:{type:"object"}};},async connection(){return {active,userId};},async invoke(){calls++;if(timeout)throw new Error("network timeout");return {successful:true,data:{success:true}};}};
 const registry=new CapabilityRegistry();let gateway:AxisGateway,token:string;
 before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);process.env.DATABASE_URL=isolated.toString();resetConfigForTests();await migrate();await registerExternalSource(registry,source,[{capabilityId:"apps.documents.create",toolId:"DOC_CREATE",accountId:"connection",userId,scopes:["documents.write"],risk:"write",mode:"SANDBOX"}]);gateway=new AxisGateway(pool,registry);token=(await gateway.grants.issue({clientId:randomUUID(),clientName:"catalog test",userId,expiresAt:new Date(Date.now()+600000),authority:{scopes:["documents.write"],capabilities:["apps.documents.create"],contextTypes:[],resources:["catalog:composio:connection"],financial:null,requireApproval:false,modes:["SANDBOX"]}})).token;});
 after(async()=>{await pool.end();await closePool();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 async function run(id:string){await pool.query("UPDATE cases SET status='running' WHERE id=$1 AND status='waiting_timeout'",[id]);await gateway.runner.advance(id);}
 test("connection and grant filtering; invalid arguments never invoke vendor",async()=>{
  const p=await gateway.grants.authenticate(token);assert.equal(registry.listAuthorized({...p,authority:{...p.authority,scopes:[]}}).length,0);assert.equal(registry.listAuthorized({...p,userId:"another-user"}).length,0);
  assert.equal((await gateway.searchCapabilities(token,{})).length,1);active=false;assert.equal((await gateway.searchCapabilities(token,{})).length,0);
  await assert.rejects(gateway.invokeCapability(token,{capabilityId:"apps.documents.create",arguments:{title:"x"},idempotencyKey:"disabled"}));active=true;
  await assert.rejects(gateway.invokeCapability(token,{capabilityId:"apps.documents.create",arguments:{title:12},idempotencyKey:"bad"}));assert.equal(calls,0);
 });
 test("duplicate invoke has one Action; vendor success alone cannot prove write",async()=>{
  const input={capabilityId:"apps.documents.create",arguments:{title:"private"},idempotencyKey:"one"};
  const a=await gateway.invokeCapability(token,input) as {workId:string};const b=await gateway.invokeCapability(token,input) as {workId:string};assert.equal(a.workId,b.workId);await run(a.workId);
  assert.equal(calls,1);assert.equal((await gateway.store.listActions(a.workId)).length,1);assert.equal((await gateway.status(token,{workId:a.workId})).status,"VERIFYING");
 });
 test("external write timeout stays IN_DOUBT without replay",async()=>{
  timeout=true;const p=await gateway.invokeCapability(token,{capabilityId:"apps.documents.create",arguments:{title:"timeout"},idempotencyKey:"timeout"}) as {workId:string};await run(p.workId);timeout=false;
  assert.equal((await gateway.status(token,{workId:p.workId})).status,"IN_DOUBT");const before=calls;await gateway.runner.reconcileInDoubt();assert.equal(calls,before);
 });
}

test("Composio v3.1 contract normalizes schemas and pins account, user and version",async()=>{
 const requests:{url:string;body:unknown}[]=[];
 const source=new ComposioSource("private-project-key",async(input,init)=>{
  const url=String(input);assert.equal((init?.headers as Record<string,string>)["x-api-key"],"private-project-key");requests.push({url,body:init?.body?JSON.parse(String(init.body)):null});
  if(url.includes("connected_accounts"))return Response.json({id:"ca_test",user_id:"axis-user",status:"ACTIVE",is_disabled:false,state:{secret:"never-return"}});
  if(url.includes("/execute/"))return Response.json({data:{text:"actual response"},successful:true});
  return Response.json({slug:"DOC_READ",description:"read document",input_parameters:{document:{type:"string",required:true}},output_parameters:{text:{type:"string"}},version:"20261003_00"});
 });
 const t=await source.discover("DOC_READ");assert.deepEqual(t.inputSchema,{type:"object",properties:{document:{type:"string"}},required:["document"],additionalProperties:false});
 assert.deepEqual(await source.connection("ca_test"),{active:true,userId:"axis-user"});
 await source.invoke(t.id,t.version,"ca_test","axis-user",{document:"doc"});assert.deepEqual(requests.at(-1)?.body,{arguments:{document:"doc"},connected_account_id:"ca_test",user_id:"axis-user",version:"20261003_00"});assert.ok(requests.every(r=>r.url.startsWith("https://backend.composio.dev/api/v3.1/")));
});
