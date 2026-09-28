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
