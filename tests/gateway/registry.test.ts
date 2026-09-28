import {test} from "node:test";
import assert from "node:assert/strict";
import { CapabilityRegistry, type CapabilityDescriptor } from "../../src/capabilities/registry.js";
import type { Principal } from "../../src/grants/service.js";
const p:Principal={clientId:"c",grantId:"g",userId:"u",expiresAt:new Date(Date.now()+60000),authority:{scopes:["read"],capabilities:["test.read"],contextTypes:[],resources:[],financial:null,requireApproval:false,modes:["LIVE"]}};
const d:CapabilityDescriptor={id:"test.read",version:"1",provider:{id:"native",kind:"native"},description:"read data",inputSchema:{type:"object",properties:{q:{type:"string"}},additionalProperties:false},outputSchema:{type:"object"},mode:"LIVE",risk:"read",requiredScopes:["read"],reversible:true,contextTypes:[],health:"healthy"};
test("catalog visibility filters authority/mode/health before ranking, and invoke cannot bypass execution",async()=>{
 const r=new CapabilityRegistry();let calls=0;r.register(d,{execute:async()=>{calls++;return {outcome:"succeeded",data:{}};}});
 assert.equal(r.search(p,{query:"read"}).length,1);
 assert.equal(r.search({...p,authority:{...p.authority,scopes:[]}}).length,0);
 assert.equal(r.search({...p,authority:{...p.authority,capabilities:[]}}).length,0);
 assert.equal(r.search({...p,authority:{...p.authority,modes:["SANDBOX"]}}).length,0);
 await assert.rejects(r.invoke(p,{capabilityId:d.id,arguments:{},idempotencyKey:"k"}));assert.equal(calls,0);
 r.bindExecution(async()=>({workId:"durable-case"}));
 assert.deepEqual(await r.invoke(p,{capabilityId:d.id,arguments:{},idempotencyKey:"k"}),{workId:"durable-case"});assert.equal(calls,0);
 assert.throws(()=>r.validate(d.id,{approved:true}));assert.throws(()=>r.validate(d.id,{q:12}));
 r.setHealth(d.id,"unhealthy");assert.equal(r.search(p).length,0);
});
