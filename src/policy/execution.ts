import type { CapabilityDescriptor, MoneyRequirement } from "../capabilities/registry.js";
import { permitted } from "../capabilities/registry.js";
import { AxisError, type Principal } from "../grants/service.js";
import type { ContextItem } from "../context/service.js";
export type CapabilityRisk = CapabilityDescriptor["risk"];
export function authorizeExecution(p: Principal, d: CapabilityDescriptor, context: readonly ContextItem[], requiredContext: readonly string[], money?: MoneyRequirement, region?: string): void {
  if(!permitted(p,d)) throw new AxisError("capability_unavailable");
  if(d.regions?.length && (!region || !d.regions.includes(region))) throw new AxisError("region_not_allowed");
  if(!requiredContext.every(t=>context.some(c=>c.type===t && Date.parse(c.expiresAt)>Date.now()))) throw new AxisError("context_unavailable");
  if(d.risk==="financial" || money) {
    const limit=p.authority.financial;
    if(!money || !/^\d+$/.test(money.amountMinor) || BigInt(money.amountMinor)<=0n || !limit || limit.asset!==money.asset || BigInt(money.amountMinor)>BigInt(limit.perActionMinor)) throw new AxisError("financial_limit");
  }
}
