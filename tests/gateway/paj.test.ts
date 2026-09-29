import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHmac} from "node:crypto";
import {Pool} from "pg";
import {PajClient,type PajConfig} from "../../src/providers/paj/client.js";
import {PajProvider} from "../../src/providers/paj/provider.js";
import {CapabilityRegistry} from "../../src/capabilities/registry.js";
import {AxisGateway} from "../../src/gateway/service.js";
import {migrate,closePool} from "../../src/db/pool.js";
import {resetConfigForTests} from "../../src/core/config.js";

const url=process.env.TEST_DATABASE_URL;
if(!url)test("PAJ durability requires PostgreSQL",{skip:true},()=>{});
else{
 const pool=new Pool({connectionString:url,max:15});
 const cfg:PajConfig={apiKey:"test-key",environment:"staging",webhookSecret:"test-webhook-secret",webhookOrigin:"https://axis.test",mint:"test-usdc",enabled:["ramp.on","ramp.off","ramp.quote","bank.resolve","ramp.status"]};
 const rate=(type:string)=>({id:type,rate:1500,type,baseCurrency:"USD",targetCurrency:"NGN",createdAt:"2026-09-29T00:00:00Z"});
 const rates={onRampRate:rate("onRamp"),offRampRate:rate("offRamp")};
 const recipient="11111111111111111111111111111111";
 let calls:{url:string;body:Record<string,unknown>}[]=[],loseResponse=false,rateChanged=false;
 const orders=new Map<string,Record<string,unknown>>();
 const transport:typeof fetch=async(input,init)=>{
  const u=String(input);assert.equal((init?.headers as Record<string,string>)["x-api-key"],cfg.apiKey);
  if(u.includes("/rate?"))return Response.json(rateChanged?{...rates,offRampRate:{...rates.offRampRate,rate:1600}}:rates);
  if(u.includes("/bank-account?"))return Response.json({id:"bank-id",accountName:"Resolved by PAJ",accountNumber:"0123456789",bank:"Verified Bank",address:"permanent-address"});
  const body=JSON.parse(String(init?.body));calls.push({url:u,body});const on=u.endsWith("/onramp");
  const t={id:randomUUID(),status:"INIT",transactionType:on?"ON_RAMP":"OFF_RAMP",chain:"SOLANA",mint:cfg.mint,currency:"NGN",usdcAmount:1,fiatAmount:1500,fee:0,rate:1500,recipient,accountNumber:on?"9876543210":"0123456789",accountName:"Paj pay exact amount",bank:"Funding Bank",address:"temporary-deposit-address",signature:"",createdAt:new Date().toISOString()};
  orders.set(String(body.webhookURL),t);if(loseResponse)throw new Error("accepted then timeout");return Response.json(t,{status:201});
 };
 const registry=new CapabilityRegistry(),provider=new PajProvider(pool,cfg,new PajClient(cfg,transport));let gateway:AxisGateway;
 before(async()=>{process.env.DATABASE_URL=url;resetConfigForTests();await migrate();await provider.register(registry);gateway=new AxisGateway(pool,registry);});
 after(async()=>{await pool.end();await closePool();});
 async function credentials(){return gateway.grants.issue({clientId:randomUUID(),clientName:"paj test",userId:randomUUID(),expiresAt:new Date(Date.now()+600000),authority:{scopes:cfg.enabled,capabilities:cfg.enabled,contextTypes:[],resources:[`wallet:SOLANA:${recipient}`,"bank:0123456789"],financial:{asset:"USDC",perActionMinor:"2000000",totalMinor:"4000000",allowedAssets:["USDC"],allowedCurrencies:["NGN"],allowedDestinations:["123:0123456789",recipient]},requireApproval:false,modes:["SANDBOX"]}});}
 function args(on=false){return {asset:"USDC",network:"SOLANA",currency:"NGN",amountMinor:on?"150000":"1000000",maxDebitMinor:on?"150000":"1000000",...(on?{recipient}:{accountNumber:"0123456789",bankCode:"123"})};}
 async function prepare(token:string,on=false){return gateway.prepare(token,{goal:"PAJ ramp",constraints:{capabilityId:on?"ramp.on":"ramp.off",arguments:args(on)}});}
 async function run(work:unknown){await pool.query("UPDATE cases SET status='running' WHERE id=$1 AND status IN ('waiting_timeout','in_doubt')",[work]);await gateway.runner.advance(String(work));}
 async function deliver(callback:string,payload:Record<string,unknown>){const parts=new URL(callback).pathname.split('/');const raw=Buffer.from(JSON.stringify(payload));const ts=String(Math.floor(Date.now()/1000));const sig="v1="+createHmac("sha256",cfg.webhookSecret!).update(ts+".").update(raw).digest("hex");await provider.webhook(parts[3],parts[4],raw,sig,ts);}
 test("PAJ capabilities have independent availability and precise semantics",async()=>{
  assert.equal(registry.get("ramp.off")?.mode,"SANDBOX");assert.equal(registry.get("money.transfer.bank")?.mode,"UNAVAILABLE");assert.equal(registry.get("ramp.quote")?.provider.id,"paj");
  const disabled=new CapabilityRegistry();await new PajProvider(pool,undefined).register(disabled);assert.equal(disabled.get("ramp.on")?.mode,"UNAVAILABLE");
 });
 test("quote and bank lookup use authenticated authoritative PAJ responses",async()=>{
  const {token}=await credentials();for(const [id,input] of [["ramp.quote",{currency:"NGN"}],["bank.resolve",{accountNumber:"0123456789"}]] as const){
   const p=await gateway.prepare(token,{goal:id,constraints:{capabilityId:id,arguments:input}});await gateway.execute(token,{preparationId:p.preparationId});await run(p.workId);
   const s=await gateway.status(token,{workId:p.workId});assert.equal(s.status,"COMPLETED");
   if(id==="ramp.quote"){assert.equal((s.result as Record<string,unknown>).binding,false);assert.deepEqual((s.result as Record<string,unknown>).offRampRate,rates.offRampRate);}else assert.equal((s.result as Record<string,unknown>).accountName,"Resolved by PAJ");
  }
 });
 test("offramp creates once, waits externally, deduplicates webhook and requires payout proof",async()=>{
  const {token}=await credentials();const count=calls.length;const p=await prepare(token);assert.equal(calls.length,count,"prepare only reads rate and bank");
  await Promise.all([gateway.execute(token,{preparationId:p.preparationId}),gateway.execute(token,{preparationId:p.preparationId})]);await run(p.workId);
  const waiting=await gateway.status(token,{workId:p.workId});assert.equal(waiting.status,"WAITING_EXTERNAL");assert.equal(waiting.verification,"UNVERIFIED");assert.equal(calls.length,count+1);
  const callback=String(calls.at(-1)!.body.webhookURL),t=orders.get(callback)!;
  const final={...t,status:"COMPLETED",signature:"provider-chain-signature"};
  await Promise.all([deliver(callback,final),deliver(callback,final)]);await run(p.workId);
  const done=await gateway.status(token,{workId:p.workId});assert.equal(done.status,"COMPLETED");assert.equal(done.verification,"VERIFIED");assert.equal((done.money as {state:string}).state,"SETTLED");
  assert.equal((await pool.query("SELECT count(*)::int n FROM paj_webhooks WHERE action_id=$1",[done.actionId])).rows[0].n,1);
  await gateway.execute(token,{preparationId:p.preparationId});assert.equal(calls.length,count+1);
 });
 test("timeout after acceptance retains identity and reconciles a lost creation response by signed callback",async()=>{
  const {token}=await credentials();const p=await prepare(token);await gateway.execute(token,{preparationId:p.preparationId});loseResponse=true;await run(p.workId);loseResponse=false;
  const s=await gateway.status(token,{workId:p.workId});assert.equal(s.status,"IN_DOUBT");assert.equal((s.money as {state:string}).state,"IN_DOUBT");
  const count=calls.length;await run(p.workId);assert.equal(calls.length,count);
  const callback=String(calls.at(-1)!.body.webhookURL);await deliver(callback,{...orders.get(callback)!,status:"COMPLETED",signature:"receipt"});await run(p.workId);
  assert.equal((await gateway.status(token,{workId:p.workId})).status,"COMPLETED");assert.equal(calls.length,count);
 });
 test("onramp needs crypto delivery evidence; order-created success is insufficient",async()=>{
  const c=await credentials();await pool.query("UPDATE agent_grants SET authority=jsonb_set(authority,'{financial,asset}','\"NGN\"') WHERE id=$1",[c.grantId]);
  const p=await prepare(c.token,true);await gateway.execute(c.token,{preparationId:p.preparationId});await run(p.workId);
  const callback=String(calls.at(-1)!.body.webhookURL),t=orders.get(callback)!;
  await deliver(callback,{...t,status:"COMPLETED",signature:""});await run(p.workId);assert.equal((await gateway.status(c.token,{workId:p.workId})).status,"IN_DOUBT");
  await deliver(callback,{...t,status:"COMPLETED",signature:"delivery"});await run(p.workId);assert.equal((await gateway.status(c.token,{workId:p.workId})).status,"COMPLETED");
 });
 test("grant ceiling, destination, unsupported network and other client fail closed",async()=>{
  const a=await credentials(),b=await credentials();const p=await prepare(a.token);
  await assert.rejects(gateway.execute(b.token,{preparationId:p.preparationId}),/not_found/);
  for(const patch of [{maxDebitMinor:"3000000"},{network:"UNKNOWN"},{bankCode:"999"},{asset:"ETH"}]){
   const bad=await gateway.prepare(a.token,{goal:"bad",constraints:{capabilityId:"ramp.off",arguments:{...args(),...patch}}});assert.equal(bad.executionPossible,false);
  }
 });
 test("changed quote is not silently executed; confirmed ERROR is not assumed to mean refunded",async()=>{
  const {token}=await credentials();const p=await prepare(token);await gateway.execute(token,{preparationId:p.preparationId});const count=calls.length;rateChanged=true;await run(p.workId);rateChanged=false;
  assert.equal(calls.length,count);assert.equal((await gateway.status(token,{workId:p.workId})).status,"FAILED");
  const next=await prepare(token);await gateway.execute(token,{preparationId:next.preparationId});await run(next.workId);
  const callback=String(calls.at(-1)!.body.webhookURL);await deliver(callback,{...orders.get(callback)!,status:"ERROR"});await run(next.workId);
  const s=await gateway.status(token,{workId:next.workId});assert.equal(s.status,"IN_DOUBT");assert.equal((s.money as {state:string}).state,"IN_DOUBT");
  await assert.rejects(provider.webhook(String(s.actionId),"0".repeat(64),Buffer.from('{}'),"v1="+"0".repeat(64),String(Math.floor(Date.now()/1000))),/invalid_webhook/);
 });
 test("expired provider quote prevents order submission",async t=>{
  const {token}=await credentials();const p=await prepare(token);await gateway.execute(token,{preparationId:p.preparationId});const count=calls.length;
  t.mock.timers.enable({apis:["Date"],now:Date.now()+121000});
  try {await run(p.workId);assert.equal(calls.length,count);assert.equal((await gateway.status(token,{workId:p.workId})).status,"FAILED");}
  finally {t.mock.timers.reset();}
 });
 test("wrong recipient and unauthorized status cannot prove another user's order",async()=>{
  const a=await credentials(),b=await credentials();const p=await prepare(a.token);await gateway.execute(a.token,{preparationId:p.preparationId});await run(p.workId);
  const callback=String(calls.at(-1)!.body.webhookURL);await deliver(callback,{...orders.get(callback)!,accountNumber:"9999999999",status:"COMPLETED",signature:"receipt"});await run(p.workId);
  const state=await gateway.status(a.token,{workId:p.workId});assert.equal(state.status,"IN_DOUBT");
  const query=await gateway.prepare(b.token,{goal:"status",constraints:{capabilityId:"ramp.status",arguments:{actionId:state.actionId}}});
  await gateway.execute(b.token,{preparationId:query.preparationId});await run(query.workId);assert.equal((await gateway.status(b.token,{workId:query.workId})).status,"FAILED");
 });

}
