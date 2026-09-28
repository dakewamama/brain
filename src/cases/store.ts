/**
 * CaseStore — the durable state behind the runtime. Two implementations behind
 * one interface: Postgres (authoritative) and in-memory (tests / no-DB fallback).
 *
 * Exactly-once boundaries live HERE, not in callers:
 *  - createAction(): an idempotency_key that already exists returns the existing
 *    action instead of inserting (UNIQUE constraint; the race loser reads).
 *  - claimInbound(): a (channel, provider_message_id) replay returns false — the
 *    first arrival owns processing.
 * Unique inserts decide ownership; a fresh snapshot reads a concurrent winner.
 */
import { hasCurrentProof } from "../proof/gate.js";
import type { Pool, PoolClient } from "pg";
import {
  type CaseRecord,
  type CaseStatus,
  type ActionRecord,
  type ActionStatus,
  type ProviderAttempt,
  type ExecutionMode,
  type AttemptOutcome,
  type Reservation,
  type ReservationStatus,
  type Evidence,
  type EvidenceKind,
  type Decision,
  type CaseEvent,
} from "./types.js";

export interface CreateCaseInput {
  id: string;
  userId: string;
  channel: string;
  goal: string;
  playbook: string;
  state: string;
  budgetMinor?: bigint | null;
  deadlineAt?: Date | null;
  context?: Record<string, unknown>;
}

export interface CaseStore {
  exclusive<T>(caseId: string, fn: () => Promise<T>): Promise<T>;
  listActions(caseId: string): Promise<ActionRecord[]>;
  attemptsFor(actionId: string): Promise<ProviderAttempt[]>;
  createCase(input: CreateCaseInput): Promise<CaseRecord>;
  getCase(id: string): Promise<CaseRecord | null>;
  updateCase(
    id: string,
    patch: Partial<Pick<CaseRecord, "state" | "status" | "context" | "wakeAt" | "deadlineAt">>,
  ): Promise<CaseRecord | null>;
  appendEvent(caseId: string, type: string, payload?: Record<string, unknown>): Promise<CaseEvent>;
  listEvents(caseId: string): Promise<CaseEvent[]>;

  /** Returns { action, created } — created=false means a replay hit the same idempotency key. */
  createAction(input: {
    id: string;
    caseId: string;
    capability: string;
    idempotencyKey: string;
    input: Record<string, unknown>;
  }): Promise<{ action: ActionRecord; created: boolean }>;
  getAction(id: string): Promise<ActionRecord | null>;
  getActionByIdempotencyKey(key: string): Promise<ActionRecord | null>;
  updateActionStatus(id: string, status: ActionStatus, result?: Record<string, unknown>): Promise<void>;
  appendAttempt(input: {
    id: string;
    actionId: string;
    provider: string;
    mode: ExecutionMode;
    request: Record<string, unknown>;
    outcome: AttemptOutcome;
    response?: Record<string, unknown> | null;
    providerRef?: string | null;
    error?: string | null;
  }): Promise<ProviderAttempt>;

  putReservation(input: {
    id: string;
    actionId: string;
    owner: string;
    amountMinor: bigint;
    asset: string;
    status: ReservationStatus;
  }): Promise<Reservation>;
  getReservationByAction(actionId: string): Promise<Reservation | null>;
  setReservationStatus(actionId: string, status: ReservationStatus): Promise<void>;

  addEvidence(input: {
    id: string;
    caseId: string;
    actionId?: string | null;
    kind: EvidenceKind;
    payload: Record<string, unknown>;
  }): Promise<Evidence>;
  listEvidence(caseId: string): Promise<Evidence[]>;

  openDecision(input: {
    id: string;
    caseId: string;
    question: string;
    options: string[];
  }): Promise<Decision>;
  answerDecision(decisionId: string, answer: string): Promise<boolean>;
  getDecision(id: string): Promise<Decision | null>;
  getOpenDecisionForCase(caseId: string): Promise<Decision | null>;

  /** True if THIS call owns processing (first arrival for the message). */
  claimInbound(input: {
    id: string;
    channel: string;
    providerMessageId: string;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
  markInboundProcessed(id: string): Promise<void>;
  /** Persisted but never processed (crash between ack and completion). */
  listUnprocessedInbound(limit: number): Promise<{ id: string; payload: Record<string, unknown> }[]>;

  /** Cases parked on a timer whose wake_at has passed. */
  listWakeable(now: Date): Promise<CaseRecord[]>;
  claimWake(id: string, now: Date): Promise<boolean>;
  /** Open cases for a user on a channel (newest first) — signal routing. */
  listOpenCases(userId: string, channel: string): Promise<CaseRecord[]>;
  /** All open cases with a given status (worker sweeps: in_doubt). */
  listByStatus(status: CaseStatus): Promise<CaseRecord[]>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

function rowToCase(r: Record<string, unknown>): CaseRecord {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    channel: r.channel as string,
    goal: r.goal as string,
    playbook: r.playbook as string,
    state: r.state as string,
    status: r.status as CaseStatus,
    context: (r.context ?? {}) as Record<string, unknown>,
    budgetMinor: r.budget_minor == null ? null : BigInt(r.budget_minor as string),
    deadlineAt: r.deadline_at ? new Date(r.deadline_at as string) : null,
    wakeAt: r.wake_at ? new Date(r.wake_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function rowToAction(r: Record<string, unknown>): ActionRecord {
  return {
    id: r.id as string,
    caseId: r.case_id as string,
    capability: r.capability as string,
    status: r.status as ActionStatus,
    input: (r.input ?? {}) as Record<string, unknown>,
    result: (r.result ?? null) as Record<string, unknown> | null,
    idempotencyKey: r.idempotency_key as string,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

export class PgCaseStore implements CaseStore {
  constructor(private pool: Pool) {}
  async exclusive<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
    // Never occupy the pool with blocked advisory-lock waiters: the owner needs
    // other connections to persist work while holding this session lock.
    for (;;) {
      const client = await this.pool.connect();
      const r = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [caseId]);
      if (!r.rows[0].acquired) { client.release(); await new Promise(resolve => setTimeout(resolve, 10)); continue; }
      try { return await fn(); }
      finally { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [caseId]); client.release(); }
    }
  }
  async listActions(caseId: string): Promise<ActionRecord[]> {
    return (await this.pool.query("SELECT * FROM actions WHERE case_id=$1 ORDER BY created_at", [caseId])).rows.map(rowToAction);
  }
  async attemptsFor(actionId: string): Promise<ProviderAttempt[]> {
    return (await this.pool.query("SELECT * FROM provider_attempts WHERE action_id=$1 ORDER BY seq", [actionId])).rows.map(r => ({ id:r.id,actionId:r.action_id,seq:r.seq,provider:r.provider,mode:r.mode,request:r.request,outcome:r.outcome,response:r.response,providerRef:r.provider_ref,error:r.error,at:new Date(r.at) }));
  }


  async createCase(input: CreateCaseInput): Promise<CaseRecord> {
    const r = await this.pool.query(
      `INSERT INTO cases (id, user_id, channel, goal, playbook, state, status, context, budget_minor, deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9) RETURNING *`,
      [
        input.id, input.userId, input.channel, input.goal, input.playbook, input.state,
        JSON.stringify(input.context ?? {}),
        input.budgetMinor == null ? null : input.budgetMinor.toString(),
        input.deadlineAt ?? null,
      ],
    );
    return rowToCase(r.rows[0]);
  }

  async getCase(id: string): Promise<CaseRecord | null> {
    const r = await this.pool.query("SELECT * FROM cases WHERE id = $1", [id]);
    return r.rows[0] ? rowToCase(r.rows[0]) : null;
  }

  async updateCase(
    id: string,
    patch: Partial<Pick<CaseRecord, "state" | "status" | "context" | "wakeAt" | "deadlineAt">>,
  ): Promise<CaseRecord | null> {
    if(patch.status === "completed" && !await hasCurrentProof(this,id)) throw new Error("completion requires current Axis proof");
    const sets: string[] = [];
    const vals: unknown[] = [];
    let n = 1;
    if (patch.state !== undefined) { sets.push(`state = $${n++}`); vals.push(patch.state); }
    if (patch.status !== undefined) { sets.push(`status = $${n++}`); vals.push(patch.status); }
    if (patch.context !== undefined) { sets.push(`context = $${n++}`); vals.push(JSON.stringify(patch.context)); }
    if (patch.wakeAt !== undefined) { sets.push(`wake_at = $${n++}`); vals.push(patch.wakeAt); }
    if (patch.deadlineAt !== undefined) { sets.push(`deadline_at = $${n++}`); vals.push(patch.deadlineAt); }
    if (sets.length === 0) return this.getCase(id);
    sets.push(`updated_at = now()`);
    vals.push(id);
    const r = await this.pool.query(
      `UPDATE cases SET ${sets.join(", ")} WHERE id = $${n} RETURNING *`, vals,
    );
    return r.rows[0] ? rowToCase(r.rows[0]) : null;
  }

  async appendEvent(caseId: string, type: string, payload: Record<string, unknown> = {}): Promise<CaseEvent> {
    return this.locked("cases", caseId, async client => {
      const r = await client.query(
        `INSERT INTO case_events (case_id, seq, type, payload)
         SELECT $1, COALESCE(MAX(seq),0)+1, $2, $3 FROM case_events WHERE case_id = $1
         RETURNING seq, at`, [caseId, type, JSON.stringify(payload)],
      );
      return { caseId, type, payload, seq: Number(r.rows[0].seq), at: new Date(r.rows[0].at) };
    });
  }

  /** Serialize sequence allocation on its parent row. The insert uses a fresh
   * READ COMMITTED snapshot after acquiring the lock; no bounded retry race. */
  private async locked<T>(table: "cases" | "actions", id: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const parent = await client.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
      if (!parent.rowCount) throw new Error(`unknown ${table} parent`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async listEvents(caseId: string): Promise<CaseEvent[]> {
    const r = await this.pool.query(
      "SELECT type, payload, seq, at FROM case_events WHERE case_id = $1 ORDER BY seq", [caseId],
    );
    return r.rows.map((row) => ({
      caseId, type: row.type, payload: row.payload, seq: Number(row.seq), at: new Date(row.at),
    }));
  }

  async createAction(input: {
    id: string; caseId: string; capability: string; idempotencyKey: string; input: Record<string, unknown>;
  }): Promise<{ action: ActionRecord; created: boolean }> {
    const r = await this.pool.query(
      `INSERT INTO actions (id, case_id, capability, status, input, idempotency_key)
       VALUES ($1,$2,$3,'proposed',$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [input.id, input.caseId, input.capability, JSON.stringify(input.input), input.idempotencyKey],
    );
    if (r.rows[0]) return { action: rowToAction(r.rows[0]), created: true };
    // A conflicting transaction may commit AFTER the insert's snapshot. Read
    // in a new statement, which sees that commit; a same-statement CTE cannot.
    const action = await this.getActionByIdempotencyKey(input.idempotencyKey);
    if (!action) throw new Error("conflicting action disappeared");
    return { action, created: false };
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    const r = await this.pool.query("SELECT * FROM actions WHERE id = $1", [id]);
    return r.rows[0] ? rowToAction(r.rows[0]) : null;
  }

  async getActionByIdempotencyKey(key: string): Promise<ActionRecord | null> {
    const r = await this.pool.query("SELECT * FROM actions WHERE idempotency_key = $1", [key]);
    return r.rows[0] ? rowToAction(r.rows[0]) : null;
  }

  async updateActionStatus(id: string, status: ActionStatus, result?: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE actions SET status = $2,
         result = COALESCE($3::jsonb, result), updated_at = now() WHERE id = $1`,
      [id, status, result ? JSON.stringify(result) : null],
    );
  }

  async appendAttempt(input: {
    id: string; actionId: string; provider: string; mode: ExecutionMode;
    request: Record<string, unknown>; outcome: AttemptOutcome;
    response?: Record<string, unknown> | null; providerRef?: string | null; error?: string | null;
  }): Promise<ProviderAttempt> {
    return this.locked("actions", input.actionId, async client => {
    const r = await client.query(
      `INSERT INTO provider_attempts (id, action_id, seq, provider, mode, request, outcome, response, provider_ref, error)
       SELECT $1,$2,COALESCE(MAX(seq),0)+1,$3,$4,$5,$6,$7,$8,$9 FROM provider_attempts WHERE action_id = $2
       RETURNING seq, at`,
      [input.id, input.actionId, input.provider, input.mode, JSON.stringify(input.request),
       input.outcome, input.response ? JSON.stringify(input.response) : null,
       input.providerRef ?? null, input.error ?? null],
    );
    return { ...input, response: input.response ?? null, providerRef: input.providerRef ?? null,
             error: input.error ?? null, seq: Number(r.rows[0].seq), at: new Date(r.rows[0].at) };
    });
  }

  async putReservation(input: {
    id: string; actionId: string; owner: string; amountMinor: bigint; asset: string; status: ReservationStatus;
  }): Promise<Reservation> {
    const r = await this.pool.query(
      `INSERT INTO reservations (id, action_id, owner, amount_minor, asset, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (action_id) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [input.id, input.actionId, input.owner, input.amountMinor.toString(), input.asset, input.status],
    );
    const row = r.rows[0];
    return {
      id: row.id, actionId: row.action_id, owner: row.owner,
      amountMinor: BigInt(row.amount_minor), asset: row.asset, status: row.status,
      createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    };
  }

  async getReservationByAction(actionId: string): Promise<Reservation | null> {
    const r = await this.pool.query("SELECT * FROM reservations WHERE action_id = $1", [actionId]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      id: row.id, actionId: row.action_id, owner: row.owner,
      amountMinor: BigInt(row.amount_minor), asset: row.asset, status: row.status,
      createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
    };
  }

  async setReservationStatus(actionId: string, status: ReservationStatus): Promise<void> {
    await this.pool.query(
      "UPDATE reservations SET status = $2, updated_at = now() WHERE action_id = $1", [actionId, status],
    );
  }

  async addEvidence(input: {
    id: string; caseId: string; actionId?: string | null; kind: EvidenceKind; payload: Record<string, unknown>;
  }): Promise<Evidence> {
    const r = await this.pool.query(
      `INSERT INTO evidence (id, case_id, action_id, kind, payload) VALUES ($1,$2,$3,$4,$5) RETURNING at`,
      [input.id, input.caseId, input.actionId ?? null, input.kind, JSON.stringify(input.payload)],
    );
    return { ...input, actionId: input.actionId ?? null, at: new Date(r.rows[0].at) };
  }

  async listEvidence(caseId: string): Promise<Evidence[]> {
    const r = await this.pool.query(
      "SELECT id, action_id, kind, payload, at FROM evidence WHERE case_id = $1 ORDER BY at", [caseId],
    );
    return r.rows.map((row) => ({
      id: row.id, caseId, actionId: row.action_id, kind: row.kind,
      payload: row.payload, at: new Date(row.at),
    }));
  }

  async openDecision(input: { id: string; caseId: string; question: string; options: string[] }): Promise<Decision> {
    const r = await this.pool.query(
      `INSERT INTO decisions (id, case_id, question, options, status) VALUES ($1,$2,$3,$4,'open') RETURNING created_at`,
      [input.id, input.caseId, input.question, JSON.stringify(input.options)],
    );
    return { ...input, status: "open", answer: null, answeredAt: null, createdAt: new Date(r.rows[0].created_at) };
  }

  async answerDecision(decisionId: string, answer: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE decisions SET status='answered', answer=$2, answered_at=now()
       WHERE id=$1 AND status='open'`,
      [decisionId, answer],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async getDecision(id: string): Promise<Decision | null> {
    const r = await this.pool.query("SELECT * FROM decisions WHERE id = $1", [id]);
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      id: row.id, caseId: row.case_id, question: row.question, options: row.options,
      status: row.status, answer: row.answer, answeredAt: row.answered_at ? new Date(row.answered_at) : null,
      createdAt: new Date(row.created_at),
    };
  }

  async getOpenDecisionForCase(caseId: string): Promise<Decision | null> {
    const r = await this.pool.query(
      "SELECT * FROM decisions WHERE case_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1", [caseId],
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      id: row.id, caseId: row.case_id, question: row.question, options: row.options,
      status: row.status, answer: row.answer, answeredAt: row.answered_at ? new Date(row.answered_at) : null,
      createdAt: new Date(row.created_at),
    };
  }

  async claimInbound(input: {
    id: string; channel: string; providerMessageId: string; payload: Record<string, unknown>;
  }): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO inbound_events (id, channel, provider_message_id, payload)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (channel, provider_message_id) DO NOTHING`,
      [input.id, input.channel, input.providerMessageId, JSON.stringify(input.payload)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markInboundProcessed(id: string): Promise<void> {
    await this.pool.query("UPDATE inbound_events SET processed_at = now() WHERE id = $1", [id]);
  }

  async listUnprocessedInbound(limit: number): Promise<{ id: string; payload: Record<string, unknown> }[]> {
    const r = await this.pool.query(
      `SELECT id, payload FROM inbound_events WHERE processed_at IS NULL ORDER BY received_at LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => ({ id: row.id as string, payload: row.payload as Record<string, unknown> }));
  }

  async claimWake(id: string, now: Date): Promise<boolean> {
    const result=await this.pool.query("UPDATE cases SET status='running', updated_at=now() WHERE id=$1 AND status='waiting_timeout' AND wake_at<=$2 RETURNING id",[id,now]);
    return !!result.rowCount;
  }

  async listWakeable(now: Date): Promise<CaseRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM cases WHERE status = 'waiting_timeout' AND wake_at IS NOT NULL AND wake_at <= $1
       ORDER BY wake_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
      [now],
    );
    return r.rows.map(rowToCase);
  }

  async listOpenCases(userId: string, channel: string): Promise<CaseRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM cases WHERE user_id = $1 AND channel = $2
         AND status IN ('running','waiting_user','waiting_timeout','in_doubt')
       ORDER BY created_at DESC LIMIT 10`,
      [userId, channel],
    );
    return r.rows.map(rowToCase);
  }

  async listByStatus(status: CaseStatus): Promise<CaseRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM cases WHERE status = $1 ORDER BY created_at LIMIT 100",
      [status],
    );
    return r.rows.map(rowToCase);
  }
}

// ---------------------------------------------------------------------------
// In-memory (tests / no-DB fallback). Single-threaded, so the same
 // exactly-once semantics hold trivially; the shapes mirror the SQL constraints.
// ---------------------------------------------------------------------------

interface MemAction extends ActionRecord { attempts: ProviderAttempt[] }

export class InMemoryCaseStore implements CaseStore {
  private locks = new Map<string, Promise<unknown>>();
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior=this.locks.get(id) ?? Promise.resolve();
    const next=prior.catch(()=>{}).then(fn); this.locks.set(id,next);
    try { return await next; } finally { if(this.locks.get(id)===next) this.locks.delete(id); }
  }
  async listActions(caseId: string): Promise<ActionRecord[]> { return [...this.actions.values()].filter(a=>a.caseId===caseId); }
  async attemptsFor(actionId: string): Promise<ProviderAttempt[]> { return this.actions.get(actionId)?.attempts ?? []; }

  readonly cases = new Map<string, CaseRecord>();
  readonly events = new Map<string, CaseEvent[]>();
  readonly actions = new Map<string, MemAction>();
  readonly actionsByKey = new Map<string, string>();
  readonly reservations = new Map<string, Reservation>(); // by actionId
  readonly evidence = new Map<string, Evidence[]>();
  readonly decisions = new Map<string, Decision>();
  readonly inboundRows = new Map<string, { id: string; payload: Record<string, unknown>; processed: boolean }>(); // `${channel}:${providerMessageId}`

  async createCase(input: CreateCaseInput): Promise<CaseRecord> {
    const rec: CaseRecord = {
      id: input.id, userId: input.userId, channel: input.channel, goal: input.goal,
      playbook: input.playbook, state: input.state, status: "running",
      context: { ...(input.context ?? {}) },
      budgetMinor: input.budgetMinor ?? null,
      deadlineAt: input.deadlineAt ?? null, wakeAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    this.cases.set(rec.id, rec);
    this.events.set(rec.id, []);
    this.evidence.set(rec.id, []);
    return rec;
  }

  async getCase(id: string): Promise<CaseRecord | null> {
    const c = this.cases.get(id);
    return c ? { ...c, context: { ...c.context } } : null;
  }

  async updateCase(
    id: string,
    patch: Partial<Pick<CaseRecord, "state" | "status" | "context" | "wakeAt" | "deadlineAt">>,
  ): Promise<CaseRecord | null> {
    if(patch.status === "completed" && !await hasCurrentProof(this,id)) throw new Error("completion requires current Axis proof");
    const c = this.cases.get(id);
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: new Date() });
    return { ...c, context: { ...c.context } };
  }

  async appendEvent(caseId: string, type: string, payload: Record<string, unknown> = {}): Promise<CaseEvent> {
    const list = this.events.get(caseId) ?? [];
    const ev: CaseEvent = { caseId, seq: list.length + 1, type, payload, at: new Date() };
    list.push(ev);
    this.events.set(caseId, list);
    return ev;
  }

  async listEvents(caseId: string): Promise<CaseEvent[]> {
    return [...(this.events.get(caseId) ?? [])];
  }

  async createAction(input: {
    id: string; caseId: string; capability: string; idempotencyKey: string; input: Record<string, unknown>;
  }): Promise<{ action: ActionRecord; created: boolean }> {
    const existingId = this.actionsByKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.actions.get(existingId)!;
      return { action: { ...existing }, created: false };
    }
    const action: MemAction = {
      id: input.id, caseId: input.caseId, capability: input.capability, status: "proposed",
      input: { ...input.input }, result: null, idempotencyKey: input.idempotencyKey,
      createdAt: new Date(), updatedAt: new Date(), attempts: [],
    };
    this.actions.set(action.id, action);
    this.actionsByKey.set(input.idempotencyKey, action.id);
    return { action: { ...action }, created: true };
  }

  async getAction(id: string): Promise<ActionRecord | null> {
    const a = this.actions.get(id);
    if (!a) return null;
    const { attempts, ...rest } = a;
    return { ...rest };
  }

  async getActionByIdempotencyKey(key: string): Promise<ActionRecord | null> {
    const id = this.actionsByKey.get(key);
    return id ? this.getAction(id) : null;
  }

  async updateActionStatus(id: string, status: ActionStatus, result?: Record<string, unknown>): Promise<void> {
    const a = this.actions.get(id);
    if (!a) return;
    a.status = status;
    if (result) a.result = result;
    a.updatedAt = new Date();
  }

  async appendAttempt(input: {
    id: string; actionId: string; provider: string; mode: ExecutionMode;
    request: Record<string, unknown>; outcome: AttemptOutcome;
    response?: Record<string, unknown> | null; providerRef?: string | null; error?: string | null;
  }): Promise<ProviderAttempt> {
    const a = this.actions.get(input.actionId);
    if (!a) throw new Error(`unknown action ${input.actionId}`);
    const attempt: ProviderAttempt = {
      ...input, response: input.response ?? null, providerRef: input.providerRef ?? null,
      error: input.error ?? null, seq: a.attempts.length + 1, at: new Date(),
    };
    a.attempts.push(attempt);
    return attempt;
  }

  listAttempts(actionId: string): ProviderAttempt[] {
    return [...(this.actions.get(actionId)?.attempts ?? [])];
  }

  async putReservation(input: {
    id: string; actionId: string; owner: string; amountMinor: bigint; asset: string; status: ReservationStatus;
  }): Promise<Reservation> {
    const existing = this.reservations.get(input.actionId);
    const rec: Reservation = existing
      ? { ...existing, ...input, updatedAt: new Date() }
      : { ...input, createdAt: new Date(), updatedAt: new Date() };
    this.reservations.set(input.actionId, rec);
    return { ...rec };
  }

  async getReservationByAction(actionId: string): Promise<Reservation | null> {
    const r = this.reservations.get(actionId);
    return r ? { ...r } : null;
  }

  async setReservationStatus(actionId: string, status: ReservationStatus): Promise<void> {
    const r = this.reservations.get(actionId);
    if (r) { r.status = status; r.updatedAt = new Date(); }
  }

  async addEvidence(input: {
    id: string; caseId: string; actionId?: string | null; kind: EvidenceKind; payload: Record<string, unknown>;
  }): Promise<Evidence> {
    const ev: Evidence = { ...input, actionId: input.actionId ?? null, at: new Date() };
    this.evidence.get(input.caseId)?.push(ev);
    return ev;
  }

  async listEvidence(caseId: string): Promise<Evidence[]> {
    return [...(this.evidence.get(caseId) ?? [])];
  }

  async openDecision(input: { id: string; caseId: string; question: string; options: string[] }): Promise<Decision> {
    const d: Decision = { ...input, status: "open", answer: null, answeredAt: null, createdAt: new Date() };
    this.decisions.set(d.id, d);
    return { ...d };
  }

  async answerDecision(decisionId: string, answer: string): Promise<boolean> {
    const d = this.decisions.get(decisionId);
    if (!d || d.status !== "open") return false;
    d.status = "answered";
    d.answer = answer;
    d.answeredAt = new Date();
    return true;
  }

  async getDecision(id: string): Promise<Decision | null> {
    const d = this.decisions.get(id);
    return d ? { ...d } : null;
  }

  async getOpenDecisionForCase(caseId: string): Promise<Decision | null> {
    for (const d of [...this.decisions.values()].reverse()) {
      if (d.caseId === caseId && d.status === "open") return { ...d };
    }
    return null;
  }

  async claimInbound(input: {
    id: string; channel: string; providerMessageId: string; payload: Record<string, unknown>;
  }): Promise<boolean> {
    const key = `${input.channel}:${input.providerMessageId}`;
    if (this.inboundRows.has(key)) return false;
    this.inboundRows.set(key, { id: input.id, payload: input.payload, processed: false });
    return true;
  }

  async markInboundProcessed(id: string): Promise<void> {
    for (const row of this.inboundRows.values()) {
      if (row.id === id) row.processed = true;
    }
  }

  async listUnprocessedInbound(limit: number): Promise<{ id: string; payload: Record<string, unknown> }[]> {
    return [...this.inboundRows.values()]
      .filter((r) => !r.processed)
      .slice(0, limit)
      .map((r) => ({ id: r.id, payload: r.payload }));
  }

  async claimWake(id: string, now: Date): Promise<boolean> {
    const c=this.cases.get(id);
    if(!c || c.status!=="waiting_timeout" || !c.wakeAt || c.wakeAt>now) return false;
    c.status="running";c.updatedAt=new Date();return true;
  }

  async listWakeable(now: Date): Promise<CaseRecord[]> {
    return [...this.cases.values()].filter(
      (c) => c.status === "waiting_timeout" && c.wakeAt != null && c.wakeAt <= now,
    );
  }

  async listOpenCases(userId: string, channel: string): Promise<CaseRecord[]> {
    return [...this.cases.values()]
      .filter((c) => c.userId === userId && c.channel === channel && is_open(c.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 10);
  }

  async listByStatus(status: CaseStatus): Promise<CaseRecord[]> {
    return [...this.cases.values()]
      .filter((c) => c.status === status)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, 100);
  }
}

function is_open(s: CaseStatus): boolean {
  return s === "running" || s === "waiting_user" || s === "waiting_timeout" || s === "in_doubt";
}
