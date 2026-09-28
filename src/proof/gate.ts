import { randomUUID } from "node:crypto";
import type { CaseStore } from "../cases/store.js";
import type { CapabilityRisk } from "../policy/execution.js";

/** Proof comes from persisted, action-correlated provider evidence and money
 * state. Neither a playbook transition nor a provider's success boolean suffices. */
export async function verifyCompletion(store: CaseStore, caseId: string, defaultRisk?: CapabilityRisk): Promise<boolean> {
  const actions=await store.listActions(caseId);
  const evidence=await store.listEvidence(caseId);
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
      if(money?.status!=="captured" || !(response.providerStatus==="delivered" || (response.moneyState==="SETTLED" && typeof response.targetState==="string"))) return false;
      if(action.input.verificationRisk && (response.moneyState!=="SETTLED" || !last.providerRef)) return false;
    } else if(risk!=="read") {
      if(typeof last.response?.targetState!=="string" || !last.providerRef) return false;
    }
  }
  await store.addEvidence({id:randomUUID(),caseId,kind:"verification",payload:{verified:true,actionIds:actions.map(a=>a.id),rule:"action-evidence-money-v1"}});
  return true;
}
