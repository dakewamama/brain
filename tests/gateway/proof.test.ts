import {test} from "node:test";
import assert from "node:assert/strict";
import {InMemoryCaseStore} from "../../src/cases/store.js";
import {CaseRunner} from "../../src/cases/runtime.js";
import {verifyCompletion} from "../../src/proof/gate.js";
test("generic completion without evidence stays VERIFYING and direct completion is refused",async()=>{
 const store=new InMemoryCaseStore();const runner=new CaseRunner(store);
 runner.registerPlaybook({id:"unproven",initialState:"run",states:{run:{async onEnter(){return {complete:{summary:"trust me"}};}}}});
 const result=await runner.start({userId:"u",channel:"test",goal:"g",playbookId:"unproven"});
 assert.equal(result.status,"verifying");await assert.rejects(store.updateCase(result.caseId,{status:"completed"}));
});
test("success:true is not proof of an external write or financial settlement",async()=>{
 const store=new InMemoryCaseStore();await store.createCase({id:"c",userId:"u",channel:"test",goal:"g",playbook:"p",state:"s"});
 await store.createAction({id:"a",caseId:"c",capability:"write",idempotencyKey:"a",input:{verificationRisk:"write"}});
 await store.updateActionStatus("a","settled");
 await store.appendAttempt({id:"t",actionId:"a",provider:"remote",mode:"UPSTREAM_MCP",request:{},outcome:"ok",response:{success:true}});
 await store.addEvidence({id:"e",caseId:"c",actionId:"a",kind:"provider_receipt",payload:{success:true}});
 assert.equal(await verifyCompletion(store,"c"),false);
 store.actions.get("a")!.input.verificationRisk="financial";
 assert.equal(await verifyCompletion(store,"c"),false);
});
test("a stale wake snapshot cannot revive a cancelled Case",async()=>{
 const store=new InMemoryCaseStore();const runner=new CaseRunner(store);let calls=0;
 runner.registerPlaybook({id:"timer",initialState:"run",states:{run:{async onEnter(){calls++;return {fail:{reason:"test"}};}}}});
 const c=await store.createCase({id:"timer",userId:"u",channel:"test",goal:"g",playbook:"timer",state:"run"});
 await store.updateCase(c.id,{status:"waiting_timeout",wakeAt:new Date(0)});
 const original=store.listWakeable.bind(store);
 store.listWakeable=async now=>{const snapshot=await original(now);await store.updateCase(c.id,{status:"cancelled"});return snapshot;};
 await runner.wakeDueCases();assert.equal(calls,0);assert.equal((await store.getCase(c.id))?.status,"cancelled");
});
test("a later attempt invalidates earlier proof and cannot silently complete again",async()=>{
 const store=new InMemoryCaseStore();await store.createCase({id:"c",userId:"u",channel:"test",goal:"g",playbook:"p",state:"s"});
 await store.createAction({id:"a",caseId:"c",capability:"read",idempotencyKey:"a",input:{verificationRisk:"read"}});
 await store.updateActionStatus("a","settled");
 await store.appendAttempt({id:"t",actionId:"a",provider:"read",mode:"LIVE",request:{},outcome:"ok",response:{value:1}});
 await store.addEvidence({id:"e",caseId:"c",actionId:"a",kind:"provider_receipt",payload:{value:1}});
 assert.equal(await verifyCompletion(store,"c"),true);await store.updateCase("c",{status:"completed"});
 await store.appendAttempt({id:"t2",actionId:"a",provider:"read",mode:"LIVE",request:{},outcome:"unknown"});
 await assert.rejects(store.updateCase("c",{status:"completed"}),/current Axis proof/);
 assert.equal(await verifyCompletion(store,"c"),false);
});
test("graceful shutdown drains an active sweep instead of closing providers early",async()=>{
 const {CaseWorker}=await import("../../src/cases/worker.js");
 const store=new InMemoryCaseStore(),runner=new CaseRunner(store),worker=new CaseWorker(runner,store);
 let release!:()=>void,entered!:()=>void;const entry=new Promise<void>(r=>{entered=r;});const finish=new Promise<void>(r=>{release=r;});let calls=0;
 runner.registerPlaybook({id:"drain",initialState:"run",states:{run:{async onEnter(){calls++;entered();await finish;return {fail:{reason:"finished safely"}};}}}});
 await store.createCase({id:"drain",userId:"u",channel:"test",goal:"g",playbook:"drain",state:"run"});
 const active=worker.tick();await entry;const duplicate=worker.tick();let drained=false;const stopped=worker.stopAndDrain().then(()=>{drained=true;});
 await Promise.resolve();assert.equal(drained,false);release();await Promise.all([active,duplicate,stopped]);assert.equal(drained,true);assert.equal(calls,1);
});
