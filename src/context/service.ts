import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { Principal } from "../grants/service.js";
import { AxisError } from "../grants/service.js";

export const contextTypes = ["location.coarse", "location.exact", "preferred_currency", "spendable_balance", "commerce.preferences"] as const;
export type ContextType = typeof contextTypes[number];
const coordinate = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict();
const validators = {
  "location.coarse": z.object({ region: z.string(), country: z.string().length(2) }).strict(),
  "location.exact": coordinate,
  preferred_currency: z.string().min(3).max(12),
  spendable_balance: z.object({ asset: z.string(), availableMinor: z.string().regex(/^\d+$/), accountId: z.string() }).strict(),
  "commerce.preferences": z.object({ categories: z.array(z.string()).max(20) }).strict(),
};
export interface ContextItem {
  id: string; type: ContextType; value: unknown; source: string; observedAt: string;
  expiresAt: string; sensitivity: "standard" | "sensitive"; requiredScope: string; caseId: string | null;
}
export class ContextService {
  constructor(private pool: Pool) {}
  /** Trusted ingestion, with provenance. An agent cannot write its own facts. */
  async put(userId: string, item: Omit<ContextItem, "id" | "requiredScope">): Promise<string> {
    if(item.caseId && !(await this.pool.query("SELECT 1 FROM cases WHERE id=$1 AND user_id=$2",[item.caseId,userId])).rowCount) throw new AxisError("context_scope");
    const value = validators[item.type].parse(item.value);
    if (!item.source || !Number.isFinite(Date.parse(item.observedAt)) || !Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.observedAt) > Date.now()) throw new AxisError("invalid_context");
    const id = randomUUID();
    await this.pool.query(`INSERT INTO scoped_context(id,user_id,type,value,source,observed_at,expires_at,sensitivity,required_scope,case_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, userId, item.type, JSON.stringify(value), item.source, item.observedAt, item.expiresAt, item.sensitivity, `context:${item.type}`, item.caseId]);
    return id;
  }
  async read(principal: Principal, types: readonly string[], caseId?: string): Promise<ContextItem[]> {
    if(caseId && !(await this.pool.query("SELECT 1 FROM cases WHERE id=$1 AND user_id=$2",[caseId,principal.userId])).rowCount) return [];
    const allowed = types.filter(t => principal.authority.contextTypes.includes(t) && principal.authority.scopes.includes(`context:${t}`));
    if (!allowed.length) return [];
    const result = await this.pool.query(`SELECT DISTINCT ON(type) * FROM scoped_context
      WHERE user_id=$1 AND type=ANY($2) AND expires_at>now() AND (case_id IS NULL OR case_id=$3)
      ORDER BY type,observed_at DESC`, [principal.userId, allowed, caseId ?? null]);
    return result.rows.filter(r => r.type !== "spendable_balance" || principal.authority.resources.includes(r.value.accountId)).map(r => ({
      id: r.id, type: r.type, value: r.value, source: r.source, observedAt: new Date(r.observed_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(), sensitivity: r.sensitivity, requiredScope: r.required_scope, caseId: r.case_id,
    }));
  }
}
