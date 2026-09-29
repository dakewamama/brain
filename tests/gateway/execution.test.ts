import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {AxisGateway,digest} from "../../src/gateway/service.js";
import {CapabilityRegistry,type CapabilityDescriptor} from "../../src/capabilities/registry.js";
import type {Authority} from "../../src/grants/service.js";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";
const url=process.env.TEST_DATABASE_URL;
if(!url) test("gateway execution requires PostgreSQL",{skip:true},()=>{});
else {
 const pool=new Pool({connectionString:url,max:20});
 const registry=new CapabilityRegistry();let reads=0,purchases=0;let sawContext:string[]=[];
 const descriptor=(id:string,risk:CapabilityDescriptor["risk"]="read"):CapabilityDescriptor=>({id,version:"1",provider:{id:"test",kind:"native"},description:id,inputSchema:{type:"object",properties:{amount:{type:"integer",minimum:1}},additionalProperties:false},outputSchema:{type:"object"},mode:"MOCK",risk,requiredScopes:["test"],reversible:risk==="read",contextTypes:[],health:"healthy"});
 registry.register(descriptor("test.read"),{execute:async(_a,c)=>{reads++;sawContext=c.context.map(i=>i.type);return {outcome:"succeeded",data:{value:42}};}});
 registry.register({...descriptor("test.context"),contextTypes:["location.coarse"]},{execute:async(_a,c)=>{sawContext=c.context.map(i=>i.type);return {outcome:"succeeded",data:{location:c.context[0].value}};}});
 registry.register(descriptor("test.financial","financial"),{money:a=>({asset:"NGN",amountMinor:String(a.amount??10)}),execute:async()=>{purchases++;throw new Error("accepted then timeout");},requery:async()=>({outcome:"succeeded",data:{},targetState:"delivered",providerRef:"receipt",moneyState:"SETTLED"})});
 registry.register(descriptor("test.write","write"),{execute:async()=>({outcome:"succeeded",data:{success:true}})});
 const gateway=new AxisGateway(pool,registry);
 const authority:Authority={scopes:["test","context:location.coarse"],capabilities:["test.read","test.context","test.financial","test.write"],contextTypes:["location.coarse"],resources:[],financial:{asset:"NGN",perActionMinor:"100",totalMinor:"100"},requireApproval:false,modes:["MOCK"]};
 before(async()=>{process.env.DATABASE_URL=url;resetConfigForTests();await migrate();});after(async()=>{await pool.end();await closePool();});
 async function credentials(patch:Partial<Authority>={}){return gateway.grants.issue({clientId:randomUUID(),clientName:"test",userId:randomUUID(),authority:{...authority,...patch},expiresAt:new Date(Date.now()+60000)});}
 async function prepare(token:string,capabilityId="test.read",args:Record<string,unknown>={}){return gateway.prepare(token,{goal:"test",constraints:{capabilityId,arguments:args}});}
 async function run(workId:unknown){await pool.query("UPDATE cases SET status='running' WHERE id=$1 AND status='waiting_timeout'",[workId]);await gateway.runner.advance(String(workId));}
 test("prepare has no external effect, persists immutable digest, rejects controls and stale execution",async()=>{
  const {token}=await credentials();const count=reads;const p=await prepare(token);assert.equal(reads,count);assert.equal(p.knownCost,null);
  assert.notEqual(digest({amount:1}),digest({amount:2}));
  await assert.rejects(pool.query("UPDATE preparations SET proposal='{}' WHERE id=$1",[p.preparationId]),/immutable/);
  await assert.rejects(gateway.prepare(token,{goal:"x",approved:true}));
  await assert.rejects(gateway.prepare(token,{goal:"x",constraints:{arguments:{skipPolicy:true}}}));
  const raw=await pool.query("SELECT * FROM preparations WHERE id=$1",[p.preparationId]);
  // A fresh process clock can find an expired immutable preparation; no UPDATE bypass.
  const expired={...raw.rows[0],id:randomUUID(),case_id:randomUUID()};
  await pool.query("INSERT INTO cases SELECT $1,user_id,channel,goal,playbook,state,status,context,budget_minor,deadline_at,wake_at,created_at,updated_at FROM cases WHERE id=$2",[expired.case_id,p.workId]);
  await pool.query("INSERT INTO preparations SELECT $1,$2,grant_id,client_id,user_id,NULL,request_digest,digest,proposal,now()-interval '1 second' FROM preparations WHERE id=$3",[expired.id,expired.case_id,p.preparationId]);
  await assert.rejects(gateway.execute(token,{preparationId:expired.id}),/stale_preparation/);
 });
 test("duplicate execute/invoke create one durable action and one provider effect",async()=>{
  const {token}=await credentials();const p=await prepare(token);const before=reads;
  await Promise.all(Array.from({length:5},()=>gateway.execute(token,{preparationId:p.preparationId})));
  await Promise.all([run(p.workId),run(p.workId)]);
  const status=await gateway.status(token,{workId:p.workId});assert.equal(status.status,"COMPLETED");assert.equal(status.verification,"VERIFIED");assert.equal(reads,before+1);
  assert.equal((await gateway.store.listActions(String(p.workId))).length,1);
  const a=await gateway.invokeCapability(token,{capabilityId:"test.read",arguments:{},idempotencyKey:"one"}) as {workId:string};
  const b=await gateway.invokeCapability(token,{capabilityId:"test.read",arguments:{},idempotencyKey:"one"}) as {workId:string};assert.equal(a.workId,b.workId);
  await assert.rejects(gateway.invokeCapability(token,{capabilityId:"test.read",arguments:{amount:1},idempotencyKey:"one"}),/idempotency_conflict/);
 });
 test("grant/user/client ownership and dispatch-time revocation enforced",async()=>{
  const a=await credentials(),b=await credentials();const p=await prepare(a.token);
  await assert.rejects(gateway.execute(b.token,{preparationId:p.preparationId}),/not_found/);
  await assert.rejects(gateway.status(b.token,{workId:p.workId}),/not_found/);
  await gateway.execute(a.token,{preparationId:p.preparationId});const count=reads;
  await gateway.grants.revoke(a.grantId);await run(p.workId);assert.equal(reads,count);assert.equal((await gateway.store.getCase(String(p.workId)))?.status,"failed");
  await assert.rejects(gateway.execute(a.token,{preparationId:p.preparationId}),/unauthorized/);
 });
 test("scope and financial ceilings are enforced; concurrent reservations cannot exceed grant",async()=>{
  const denied=await credentials({scopes:[]});assert.deepEqual(await gateway.searchCapabilities(denied.token,{}),[]);await assert.rejects(prepare(denied.token));
  const {token}=await credentials();const over=await prepare(token,"test.financial",{amount:101});assert.equal(over.executionPossible,false);
  const proposals=await Promise.all([prepare(token,"test.financial",{amount:60}),prepare(token,"test.financial",{amount:60})]);
  const results=await Promise.allSettled(proposals.map(p=>gateway.execute(token,{preparationId:p.preparationId})));assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 });
 test("timeout retains money, requery settles under the same identity, retry never purchases again",async()=>{
  const {token}=await credentials();const p=await prepare(token,"test.financial",{amount:20});const before=purchases;
  await gateway.execute(token,{preparationId:p.preparationId});await run(p.workId);
  const pending=await gateway.status(token,{workId:p.workId});assert.equal(pending.status,"IN_DOUBT");assert.equal((pending.money as {state:string}).state,"IN_DOUBT");
  await gateway.execute(token,{preparationId:p.preparationId});
  await pool.query("UPDATE cases SET status='running' WHERE id=$1",[p.workId]);await gateway.runner.advance(String(p.workId));
  assert.equal((await gateway.status(token,{workId:p.workId})).status,"COMPLETED");assert.equal(purchases,before+1);
  assert.equal((await gateway.cancel(token,{workId:p.workId})).result,"CANNOT_CANCEL");
 });
 test("missing write proof stays VERIFYING, not COMPLETED",async()=>{
  const {token}=await credentials();const p=await prepare(token,"test.write");await gateway.execute(token,{preparationId:p.preparationId});await run(p.workId);
  assert.equal((await gateway.status(token,{workId:p.workId})).status,"VERIFYING");
 });
 test("prepared, waiting-approval, and queued reservations cancel safely",async()=>{
  const a=await credentials({requireApproval:true});const p=await prepare(a.token);await gateway.execute(a.token,{preparationId:p.preparationId});
  assert.equal((await gateway.status(a.token,{workId:p.workId})).status,"WAITING_APPROVAL");assert.equal((await gateway.cancel(a.token,{workId:p.workId})).result,"CANCELLED");
  const {token}=await credentials();const prepared=await prepare(token);assert.equal((await gateway.cancel(token,{workId:prepared.workId})).result,"CANCELLED");
  const reserved=await prepare(token,"test.financial",{amount:50});await gateway.execute(token,{preparationId:reserved.preparationId});
  assert.equal((await gateway.cancel(token,{workId:reserved.workId})).result,"CANCELLED");
  assert.equal(((await gateway.status(token,{workId:reserved.workId})).money as {state:string}).state,"RELEASED");
 });
 test("capabilities receive minimal scoped context and stale facts cannot execute",async()=>{
  const {token}=await credentials();const p=await gateway.grants.authenticate(token);
  await gateway.context.put(p.userId,{type:"location.coarse",value:{country:"NG",region:"Lagos"},source:"user",observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),sensitivity:"standard",caseId:null});
  const prep=await prepare(token,"test.context");await gateway.execute(token,{preparationId:prep.preparationId});await run(prep.workId);assert.deepEqual(sawContext,["location.coarse"]);
  const read=await prepare(token);await gateway.execute(token,{preparationId:read.preparationId});await run(read.workId);assert.deepEqual(sawContext,[]);
  const stale=await prepare(token,"test.context");await pool.query("UPDATE scoped_context SET expires_at=now()-interval '1 second' WHERE user_id=$1",[p.userId]);
  await assert.rejects(gateway.execute(token,{preparationId:stale.preparationId}),/stale_context/);
 });
}
