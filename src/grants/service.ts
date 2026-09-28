import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export class AxisError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}
const names = z.array(z.string().min(1)).max(100);
export const authoritySchema = z.object({
  scopes: names,
  capabilities: names,
  contextTypes: names,
  resources: names,
  financial: z.object({ asset: z.string(), perActionMinor: z.string().regex(/^\d+$/), totalMinor: z.string().regex(/^\d+$/) }).strict().nullable(),
  requireApproval: z.boolean(),
  modes: z.array(z.enum(["LIVE", "SANDBOX", "MOCK", "HANDOFF", "UPSTREAM_MCP"])),
}).strict();
export type Authority = z.infer<typeof authoritySchema>;
export interface Principal { clientId: string; grantId: string; userId: string; authority: Authority; expiresAt: Date }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export class GrantService {
  constructor(readonly pool: Pool) {}
  /** Trusted administration only: never exposed as an agent tool. Token is
   * returned once; only its hash is stored. No caller-selectable subject. */
  async issue(input: { clientId: string; clientName: string; userId: string; authority: Authority; expiresAt: Date }): Promise<{ token: string; grantId: string }> {
    const authority = authoritySchema.parse(input.authority);
    if (!input.userId || !input.clientId || input.expiresAt <= new Date()) throw new AxisError("invalid_grant");
    const token = randomBytes(32).toString("base64url");
    const grantId = randomUUID();
    await this.pool.query("INSERT INTO agent_clients(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [input.clientId, input.clientName]);
    await this.pool.query("INSERT INTO agent_grants(id,client_id,user_id,token_hash,authority,expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [grantId, input.clientId, input.userId, hash(token), authority, input.expiresAt]);
    return { token, grantId };
  }
  async authenticate(token: string): Promise<Principal> {
    if (token.length < 32 || token.length > 512) throw new AxisError("unauthorized");
    const result = await this.pool.query("SELECT id,client_id FROM agent_grants WHERE token_hash=$1", [hash(token)]);
    if (!result.rows[0]) throw new AxisError("unauthorized");
    return this.resolve(result.rows[0].id, result.rows[0].client_id);
  }
  async resolve(grantId: string, clientId: string, db: Pool | PoolClient = this.pool): Promise<Principal> {
    const result = await db.query(`SELECT g.* FROM agent_grants g JOIN agent_clients c ON c.id=g.client_id
      WHERE g.id=$1 AND g.client_id=$2 AND g.revoked_at IS NULL AND c.revoked_at IS NULL AND g.expires_at>now()`, [grantId, clientId]);
    const row = result.rows[0];
    if (!row) throw new AxisError("unauthorized");
    return { grantId: row.id, clientId: row.client_id, userId: row.user_id, authority: authoritySchema.parse(row.authority), expiresAt: new Date(row.expires_at) };
  }
  async revoke(grantId: string): Promise<void> {
    await this.pool.query("UPDATE agent_grants SET revoked_at=now() WHERE id=$1", [grantId]);
  }
}
