import {test} from "node:test";
import assert from "node:assert/strict";
import {CapabilityRegistry,type ProviderContext} from "../../src/capabilities/registry.js";
import {registerCoreCapabilities,type CommerceProvider} from "../../src/capabilities/core.js";
import type {Principal} from "../../src/grants/service.js";
const p:Principal={clientId:"c",grantId:"g",userId:"u",expiresAt:new Date(Date.now()+60000),authority:{scopes:["money.balance","telecom.airtime.purchase","location.context"],capabilities:["money.balance","telecom.airtime.purchase","location.context"],contextTypes:[],resources:["wallet:self","telecom:08031234567"],financial:{asset:"NGN",perActionMinor:"100000",totalMinor:"100000"},requireApproval:false,modes:["LIVE","SANDBOX"]}};
const ctx:ProviderContext={actionId:"stable-action",idempotencyKey:"stable-action",userId:"derived-user",context:[]};
test("missing providers stay unavailable; live airtime cannot bypass the missing debit-bound contract",()=>{
 const empty=new CapabilityRegistry();registerCoreCapabilities(empty,{env:{}});
 for(const id of ["money.balance","money.transfer","telecom.airtime.purchase","location.search","commerce.search","commerce.quote"])assert.equal(empty.get(id)?.mode,"UNAVAILABLE");
 const live=new CapabilityRegistry();registerCoreCapabilities(live,{env:{ONBOARDING_URL:"https://custody.example",INTERNAL_API_TOKEN:"test-only",AXIS_ONBOARDING_MODE:"LIVE"}});
 assert.equal(live.get("money.balance")?.mode,"LIVE");assert.equal(live.get("telecom.airtime.purchase")?.mode,"UNAVAILABLE");
 assert.ok(!live.search(p).some(d=>d.id==="telecom.airtime.purchase"));
 assert.ok(!live.search({...p,authority:{...p.authority,resources:[]}}).some(d=>d.id==="money.balance"));
});
test("sandbox custody preserves action identity and requires final money state and receipt",async()=>{
 const r=new CapabilityRegistry();registerCoreCapabilities(r,{env:{ONBOARDING_URL:"https://custody.example",INTERNAL_API_TOKEN:"test-only",AXIS_ONBOARDING_MODE:"SANDBOX"}});
 const dispatch=r.bindExecution(async()=>{throw new Error("test uses trusted dispatch only");});
 const old=globalThis.fetch;const args={network:"mtn",phone:"08031234567",amount:100};let calls=0;
 try {
  globalThis.fetch=(async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.owner,"derived-user");assert.equal(body.idempotencyKey,"stable-action");return new Response(JSON.stringify({status:"delivered",moneyState:"SETTLED",requestId:"provider-ref",chargedBaseUnits:"100"}));}) as typeof fetch;
  const delivered=await dispatch("telecom.airtime.purchase",args,ctx);assert.equal(delivered.outcome,"succeeded");assert.equal(delivered.providerRef,"provider-ref");
  globalThis.fetch=(async()=>new Response(JSON.stringify({success:true,status:"delivered"}))) as typeof fetch;
  assert.equal((await dispatch("telecom.airtime.purchase",args,ctx)).outcome,"unknown");
  globalThis.fetch=(async(url)=>{assert.match(String(url),/idempotencyKey=stable-action/);return new Response(JSON.stringify({status:"failed",moneyState:"RELEASED"}));}) as typeof fetch;
  assert.equal((await dispatch("telecom.airtime.purchase",args,ctx,true)).moneyState,"RELEASED");assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});
test("merchant quote adapter rejects stale or mismatched offers; it never fabricates cost",async()=>{
 const offer={quoteId:"q",merchantId:"m",productId:"p",quantity:1,asset:"NGN",amountMinor:"1200",expiresAt:new Date(Date.now()+60000).toISOString()};
 const provider:CommerceProvider={mode:"SANDBOX",search:async()=>({products:[]}),quote:async()=>({...offer})};
 const r=new CapabilityRegistry();registerCoreCapabilities(r,{env:{},commerce:provider});const dispatch=r.bindExecution(async()=>null);
 const args={merchantId:"m",productId:"p",quantity:1};const result=await dispatch("commerce.quote",args,ctx);assert.equal(result.data.amountMinor,"1200");assert.equal(result.data.authoritativeQuote,true);
 offer.expiresAt=new Date(0).toISOString();await assert.rejects(dispatch("commerce.quote",args,ctx),/invalid_quote/);
 offer.expiresAt=new Date(Date.now()+60000).toISOString();offer.productId="different";await assert.rejects(dispatch("commerce.quote",args,ctx),/invalid_quote/);
});
