import {spawn} from "node:child_process";
import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {HumanTaskService} from "../../src/human/service.js";
import {CapabilityRegistry} from "../../src/capabilities/registry.js";
import {AxisGateway} from "../../src/gateway/service.js";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";
const url=process.env.TEST_DATABASE_URL;
if(!url)test("human tasks require PostgreSQL",{skip:true},()=>{});
else{
 const schema=`test_${randomUUID().replaceAll("-","")}`,admin=new Pool({connectionString:url});
 const isolated=new URL(url);isolated.searchParams.set("options",`-c search_path=${schema}`);
 const pool=new Pool({connectionString:isolated.toString()}),registry=new CapabilityRegistry(),human=new HumanTaskService(pool);human.register(registry);const gateway=new AxisGateway(pool,registry);let token:string,operator:string,userId:string;
 before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);process.env.DATABASE_URL=isolated.toString();resetConfigForTests();await migrate();userId=randomUUID();token=(await gateway.grants.issue({clientId:randomUUID(),clientName:"human test",userId,expiresAt:new Date(Date.now()+600000),authority:{scopes:["human.request","context:location.coarse"],capabilities:["human.request"],contextTypes:["location.coarse"],resources:[],financial:null,requireApproval:false,modes:["LIVE"]}})).token;operator=(await human.issueOperator(userId,new Date(Date.now()+600000))).token;await gateway.context.put(userId,{type:"location.coarse",value:{country:"NG",region:"Lagos"},source:"user",observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),sensitivity:"standard",caseId:null});});
 after(async()=>{await pool.end();await closePool();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 async function request(timeoutSeconds=3600){const p=await gateway.invokeCapability(token,{capabilityId:"human.request",arguments:{purpose:"Check selected information",contextTypes:["location.coarse"],timeoutSeconds},idempotencyKey:randomUUID()}) as {workId:string};await gateway.runner.wakeDueCases(new Date(Date.now()+1000));const s=await gateway.status(token,{workId:p.workId});assert.equal(s.status,"WAITING_HUMAN");return {workId:p.workId,taskId:String(s.actionId)};}
 const response={decision:"confirm",evidence:{reference:"operator-inspection",description:"Confirmed requested decision"}};
 test("durable task, scoped context, operator authorization, idempotent resolution and one resume",async()=>{
  const p=await request();const restarted=new HumanTaskService(pool);const task=await restarted.read(operator,p.taskId);assert.equal(task.allowed_context.length,1);assert.equal(task.allowed_context[0].type,"location.coarse");
  const other=(await human.issueOperator("another-user",new Date(Date.now()+600000))).token;await assert.rejects(human.resolve(other,p.taskId,response),/not_found/);await assert.rejects(human.resolve(token,p.taskId,response),/unauthorized_operator/);
  const child=spawn(process.execPath,["--import","tsx","tests/fixtures/human-resolve.ts"],{env:{...process.env,TEST_DATABASE_URL:isolated.toString(),AXIS_OPERATOR_TOKEN:operator,TASK_ID:p.taskId,TASK_RESPONSE:JSON.stringify(response)},stdio:["ignore","ignore","pipe"]});
  let errors="";child.stderr.on("data",b=>{errors+=b;});await new Promise<void>((ok,no)=>{child.once("error",no);child.once("exit",code=>code===0?ok():no(new Error(errors)));});
  await restarted.resolve(operator,p.taskId,response);assert.notEqual((await gateway.status(token,{workId:p.workId})).status,"COMPLETED");
  await gateway.runner.wakeDueCases(new Date(Date.now()+1000));assert.equal((await gateway.status(token,{workId:p.workId})).status,"COMPLETED");assert.equal((await pool.query("SELECT count(*)::int n FROM human_audit WHERE task_id=$1",[p.taskId])).rows[0].n,1);
  await assert.rejects(human.resolve(operator,p.taskId,{...response,decision:"reject"}),/resolution_conflict/);
 });
 test("cancellation invalidates unresolved task; deadline expires without resolution",async t=>{
  const p=await request();assert.equal((await gateway.cancel(token,{workId:p.workId})).result,"CANCELLED");assert.equal((await human.read(operator,p.taskId)).status,"CANCELLED");await assert.rejects(human.resolve(operator,p.taskId,response),/human_task_inactive/);
  const expired=await request(1);t.mock.timers.enable({apis:["Date"],now:Date.now()+2000});try{await gateway.runner.wakeDueCases();assert.equal((await gateway.status(token,{workId:expired.workId})).status,"FAILED");assert.equal((await human.read(operator,expired.taskId)).status,"EXPIRED");}finally{t.mock.timers.reset();}
 });
}
