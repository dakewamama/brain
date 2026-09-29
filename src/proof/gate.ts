import { digest } from "../core/digest.js";
import { randomUUID } from "node:crypto";
import type { CaseStore } from "../cases/store.js";
import type { CapabilityRisk } from "../policy/execution.js";

/** Proof comes from persisted, action-correlated provider evidence and money
 * state. Neither a playbook transition nor a provider's success boolean suffices. */
export async function verifyCompletion(store: CaseStore, caseId: string, defaultRisk?: CapabilityRisk): Promise<boolean> {
  const actions=await store.listActions(caseId);
  const evidence=await store.listEvidence(caseId);
  const owner=(await store.getCase(caseId))?.userId;
  if(!actions.length) return false;
  for(const action of actions) {
    const risk=action.input.verificationRisk ?? defaultRisk;
    if(!risk || action.status !== "settled") return false;
    const attempts=await store.attemptsFor(action.id);
    const last=attempts.at(-1);
    if(!last || last.outcome !== "ok" || ["HANDOFF","UNAVAILABLE"].includes(last.mode)) return false;
    const receipt=evidence.find(e=>e.actionId===action.id && e.kind==="provider_receipt");
    if(!receipt) return false;
    if(risk==="financial") {
      const money=await store.getReservationByAction(action.id);
      const response=last.response ?? {};
      if(money?.owner!==owner || money?.status!=="captured" || !(response.providerStatus==="delivered" || (response.moneyState==="SETTLED" && typeof response.targetState==="string"))) return false;
      const expected=action.input.moneyRequirement as {amountMinor?:string;asset?:string}|undefined;
      if(expected && (expected.amountMinor!==money.amountMinor.toString() || expected.asset!==money.asset)) return false;
      if(action.input.verificationRisk && (response.moneyState!=="SETTLED" || !last.providerRef)) return false;
    } else if(risk!=="read") {
      if(typeof last.response?.targetState!=="string" || !last.providerRef) return false;
    }
  }
  await store.addEvidence({id:randomUUID(),caseId,kind:"verification",payload:{verified:true,actionIds:actions.map(a=>a.id),rule:"action-evidence-money-v2",snapshot:await proofSnapshot(store,caseId)}});
  return true;
}

/** Bind verification to the exact persisted facts it examined. Later attempts,
 * action/result changes or money transitions invalidate old proof. */
export async function proofSnapshot(store:CaseStore,caseId:string):Promise<string> {
 const actions=(await store.listActions(caseId)).sort((a,b)=>a.id.localeCompare(b.id));
 const receipts=(await store.listEvidence(caseId)).filter(e=>e.kind!=="verification").sort((a,b)=>a.id.localeCompare(b.id));
 const facts=[];
 for(const action of actions) {
  const last=(await store.attemptsFor(action.id)).at(-1);
  const money=await store.getReservationByAction(action.id);
  facts.push({id:action.id,status:action.status,input:action.input,result:action.result,last:last?{id:last.id,seq:last.seq,outcome:last.outcome,response:last.response,ref:last.providerRef,mode:last.mode}:null,money:money?{owner:money.owner,amount:money.amountMinor.toString(),asset:money.asset,status:money.status}:null});
 }
 return digest({facts,receipts:receipts.map(e=>({id:e.id,actionId:e.actionId,kind:e.kind,payload:e.payload}))});
}
export async function hasCurrentProof(store:CaseStore,caseId:string):Promise<boolean> {
 const snapshot=await proofSnapshot(store,caseId);
 return (await store.listEvidence(caseId)).some(e=>e.kind==="verification"&&e.payload.verified===true&&e.payload.snapshot===snapshot);
}
