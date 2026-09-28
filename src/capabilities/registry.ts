import Ajv, { type ValidateFunction } from "ajv";
import { z } from "zod";
import type { Principal } from "../grants/service.js";
import { AxisError } from "../grants/service.js";
import type { ContextItem } from "../context/service.js";

export const modes = ["LIVE", "SANDBOX", "MOCK", "HANDOFF", "UPSTREAM_MCP", "UNAVAILABLE"] as const;
export const risks = ["read", "write", "financial", "external_commitment"] as const;
export const descriptorSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]+$/), version: z.string().min(1),
  provider: z.object({ id: z.string(), kind: z.enum(["native","external_api","upstream_mcp"]) }).strict(),
  description: z.string(), inputSchema: z.unknown(), outputSchema: z.unknown(),
  mode: z.enum(modes), risk: z.enum(risks), requiredScopes: z.array(z.string()), reversible: z.boolean(),
  regions: z.array(z.string()).optional(), metadata: z.record(z.unknown()).optional(),
  contextTypes: z.array(z.string()).default([]), health: z.enum(["healthy","unhealthy"]).default("healthy"),
}).strict();
export type CapabilityDescriptor = z.infer<typeof descriptorSchema>;
export type MoneyState = "AVAILABLE" | "RESERVED" | "IN_FLIGHT" | "IN_DOUBT" | "SETTLED" | "RELEASED" | "REVERSED" | "REFUNDED";
export interface MoneyRequirement { asset: string; amountMinor: string }
export interface ProviderResult {
  outcome: "succeeded" | "pending" | "unknown" | "failed" | "handoff";
  data: Record<string, unknown>;
  providerRef?: string;
  /** A trusted adapter's normalized verdict, never read directly from model args. */
  targetState?: string;
  moneyState?: MoneyState;
}
export interface ProviderContext {
  actionId: string; idempotencyKey: string; userId: string; context: readonly ContextItem[];
}
export interface CapabilityAdapter {
  execute(args: Record<string, unknown>, context: ProviderContext): Promise<ProviderResult>;
  requery?(args: Record<string, unknown>, context: ProviderContext): Promise<ProviderResult>;
  money?(args: Record<string, unknown>): MoneyRequirement;
  requiredContext?(args: Record<string, unknown>): string[];
}
export interface Invocation { capabilityId: string; arguments: Record<string, unknown>; idempotencyKey: string }
export interface Discovery { query?: string; region?: string; modes?: CapabilityDescriptor["mode"][]; risks?: CapabilityDescriptor["risk"][]; limit?: number }
export function permitted(p: Principal, d: CapabilityDescriptor): boolean {
  return p.authority.capabilities.includes(d.id) && d.requiredScopes.every(s => p.authority.scopes.includes(s)) &&
    d.mode !== "UNAVAILABLE" && p.authority.modes.includes(d.mode) && d.health === "healthy";
}
export function rejectAuthorityControls(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(rejectAuthorityControls); return; }
  if (value && typeof value === "object") for (const [key,v] of Object.entries(value)) {
    if (["approved","skipPolicy","admin","userId","clientId","grantId","owner","__proto__","constructor","prototype"].includes(key)) throw new AxisError("invalid_arguments");
    rejectAuthorityControls(v);
  }
}
/** Only Axis execution receives this closure. Registry.invoke never calls a provider. */
export type Dispatch = (id: string, args: Record<string,unknown>, context: ProviderContext, requery?: boolean) => Promise<ProviderResult>;
export class CapabilityRegistry {
  private entries = new Map<string, { descriptor: CapabilityDescriptor; adapter: CapabilityAdapter; input: ValidateFunction; output: ValidateFunction }>();
  private ajv = new Ajv({ strict: false, allErrors: true });
  private execution?: (principal: Principal, invocation: Invocation) => Promise<unknown>;
  register(descriptor: CapabilityDescriptor, adapter: CapabilityAdapter): void {
    const d = descriptorSchema.parse(structuredClone(descriptor));
    if (this.entries.has(d.id)) throw new AxisError("duplicate_capability");
    if (!d.inputSchema || !d.outputSchema) throw new AxisError("missing_schema");
    this.entries.set(d.id, { descriptor: d, adapter, input: this.ajv.compile(d.inputSchema as object), output: this.ajv.compile(d.outputSchema as object) });
  }
  get(id: string): CapabilityDescriptor | undefined { const d=this.entries.get(id)?.descriptor; return d && structuredClone(d); }
  setHealth(id: string, health: CapabilityDescriptor["health"]): void { const e=this.entries.get(id); if(e) e.descriptor.health=health; }
  listAuthorized(p: Principal): CapabilityDescriptor[] { return [...this.entries.values()].map(e=>e.descriptor).filter(d=>permitted(p,d)).map(d=>structuredClone(d)); }
  search(p: Principal, filters: Discovery = {}, availableContext: readonly string[] = []): CapabilityDescriptor[] {
    const words=(filters.query ?? "").toLowerCase().split(/\W+/).filter(Boolean);
    return this.listAuthorized(p).filter(d=>(!d.regions?.length || (!!filters.region && d.regions.includes(filters.region))) &&
      (!filters.modes || filters.modes.includes(d.mode)) && (!filters.risks || filters.risks.includes(d.risk)) &&
      d.contextTypes.every(t=>availableContext.includes(t)))
      .map(d=>({d,score:words.reduce((n,w)=>n+(`${d.id} ${d.description}`.toLowerCase().includes(w)?1:0),0)}))
      .filter(x=>!words.length||x.score>0).sort((a,b)=>b.score-a.score||a.d.id.localeCompare(b.d.id))
      .slice(0,Math.min(5,Math.max(1,filters.limit??5))).map(x=>x.d);
  }
  validate(id: string, args: Record<string,unknown>): void {
    rejectAuthorityControls(args);
    const e=this.entries.get(id);
    if(!e || !e.input(args)) throw new AxisError("invalid_arguments");
  }
  requirements(id: string, args: Record<string,unknown>): { context: string[]; money?: MoneyRequirement } {
    const e=this.entries.get(id); if(!e) throw new AxisError("capability_unavailable");
    return {context:[...new Set([...e.descriptor.contextTypes,...(e.adapter.requiredContext?.(args)??[])])], money:e.adapter.money?.(args)};
  }
  /** One-time wiring to the trusted execution service. Provider dispatch is not
   * returned by get/search and is never part of the external tool interface. */
  bindExecution(execute: (p: Principal, i: Invocation) => Promise<unknown>): Dispatch {
    if(this.execution) throw new AxisError("execution_already_bound");
    this.execution=execute;
    return async (id,args,ctx,requery=false) => {
      this.validate(id,args);
      const e=this.entries.get(id)!;
      if(e.descriptor.mode === "UNAVAILABLE" || e.descriptor.health !== "healthy") throw new AxisError("capability_unavailable");
      if(requery && !e.adapter.requery) return {outcome:"unknown",data:{}};
      const result=await (requery ? e.adapter.requery!(args,ctx) : e.adapter.execute(args,ctx));
      if(!e.output(result.data)) throw new AxisError("invalid_provider_output");
      return result;
    };
  }
  async invoke(p: Principal, input: Invocation): Promise<unknown> {
    if(!this.execution) throw new AxisError("execution_not_configured");
    return this.execution(p,input);
  }
}
