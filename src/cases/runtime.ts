/**
 * CaseRunner — durable execution over playbook state machines.
 *
 * Design (deliberately NOT a workflow framework):
 *  - A Case's resume point is (state, status, context) persisted in the store.
 *  - Advancing means: run the current state's onEnter, persist the returned
 *    Transition (event + case row), loop until the case reaches a resting
 *    status (waiting_user / waiting_timeout / in_doubt / completed / failed /
 *    cancelled) or a handler throws.
 *  - A crash between persist steps loses nothing: the next resume continues
 *    from the recorded state. Nothing depends on the HTTP request that started
 *    the case staying alive.
 *  - signal() resumes waiting_user cases with an authenticated user reply.
 *  - The worker resumes waiting_timeout cases past wake_at and runs registered
 *    reconcilers for in_doubt cases.
 *
 * The runner's public surface (start/signal/cancel/status/wakeDueCases/
 * reconcileInDoubt) is the seam a different executor (e.g. Hatchet) would
 * implement; playbooks never see it.
 */
import { CapabilityRegistry } from "../capabilities/registry.js";
import { verifyCompletion } from "../proof/gate.js";
import { randomUUID } from "node:crypto";
import type {
  CaseRecord,
  Playbook,
  Transition,
  CaseContext,
  CaseMessage,
  ExecutionMode,
} from "./types.js";
import type { CaseStore } from "./store.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("runtime");

export interface StartCaseInput {
  userId: string;
  channel: string;
  goal: string;
  playbookId: string;
  budgetMinor?: bigint | null;
  deadlineAt?: Date | null;
  context?: Record<string, unknown>;
}

export interface CaseStepOutcome {
  caseId: string;
  status: CaseRecord["status"];
  state: string;
  replies: CaseMessage[];
  done: boolean;
}

export interface RuntimeStatus {
  caseId: string;
  status: CaseRecord["status"];
  state: string;
  goal: string;
  events: { seq: number; type: string; at: Date }[];
  evidence: { kind: string; at: Date }[];
}

/** A capability the runtime can invoke on an action's behalf. Adapters register
 *  these; the runner records a ProviderAttempt for every call with its mode. */
export interface CapabilityExecutor {
  capability: string;
  provider: string;
  mode: ExecutionMode;
  /** Perform the side effect. Throw on transport failure; return a typed result
   *  otherwise. outcome "unknown" means the provider may have accepted. */
  execute(input: { actionId: string; idempotencyKey: string; params: Record<string, unknown> }): Promise<{
    ok: boolean;
    outcome: "ok" | "failed" | "unknown";
    response: Record<string, unknown>;
    providerRef?: string;
  }>;
}

const MAX_HOPS = 20;

export class CaseRunner {
  private playbooks = new Map<string, Playbook>();

  private reconcilers = new Map<string, (caseId: string) => Promise<void>>();

  constructor(
    private store: CaseStore,
    private mode: ExecutionMode = "LIVE",
    readonly capabilities = new CapabilityRegistry(),
  ) {}

  registerPlaybook(pb: Playbook): void {
    if (this.playbooks.has(pb.id)) throw new Error(`playbook ${pb.id} already registered`);
    this.playbooks.set(pb.id, pb);
  }

  registerCapability(exec: CapabilityExecutor): void {
    this.capabilities.registerCompatibility({id:exec.capability,version:"legacy",provider:{id:exec.provider,kind:"external_api"},description:exec.capability,inputSchema:{type:"object"},outputSchema:{type:"object"},mode:"UNAVAILABLE",risk:"financial",requiredScopes:["legacy.disabled"],reversible:false,contextTypes:[],health:"unhealthy"},exec);
  }

  capability(capability: string): CapabilityExecutor | undefined {
    return this.capabilities.compatibility<CapabilityExecutor>(capability);
  }

  executionMode(): ExecutionMode {
    return this.mode;
  }

  registerReconciler(playbookId: string, fn: (caseId: string) => Promise<void>): void {
    this.reconcilers.set(playbookId, fn);
  }

  /** Create the case and run it until it rests. */
  async start(input: StartCaseInput): Promise<CaseStepOutcome> {
    const pb = this.playbooks.get(input.playbookId);
    if (!pb) throw new Error(`unknown playbook ${input.playbookId}`);
    // The budget lives on the case row (authoritative) and is mirrored into
    // context so playbook states can enforce it without a store round-trip.
    const context = { ...(input.context ?? {}) };
    if (input.budgetMinor != null && context.caseBudgetMinor == null) {
      context.caseBudgetMinor = input.budgetMinor.toString();
    }
    const caseRec = await this.store.createCase({
      id: `case_${randomUUID()}`,
      userId: input.userId,
      channel: input.channel,
      goal: input.goal,
      playbook: input.playbookId,
      state: pb.initialState,
      budgetMinor: input.budgetMinor ?? null,
      deadlineAt: input.deadlineAt ?? null,
      context,
    });
    await this.store.appendEvent(caseRec.id, "case_created", {
      goal: input.goal, playbook: input.playbookId, channel: input.channel,
    });
    return this.advance(caseRec.id);
  }

  /** Run states from the case's recorded resume point until it rests. */
  async advance(caseId: string): Promise<CaseStepOutcome> {
    return this.store.exclusive(caseId, () => this.advanceUnlocked(caseId));
  }
  async complete(caseId: string, summary: string): Promise<boolean> {
    const c=await this.store.getCase(caseId);
    if(!c) return false;
    const verified=await verifyCompletion(this.store,caseId,this.playbooks.get(c.playbook)?.verification);
    if(!verified) { await this.store.updateCase(caseId,{status:"verifying"}); return false; }
    await this.store.appendEvent(caseId,"case_completed",{summary});
    await this.store.updateCase(caseId,{status:"completed",wakeAt:null});
    return true;
  }
  private async advanceUnlocked(caseId: string): Promise<CaseStepOutcome> {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const current = await this.store.getCase(caseId);
      if (!current) throw new Error(`unknown case ${caseId}`);
      if (isResting(current.status)) return this.outcome(current, false);

      const pb = this.playbooks.get(current.playbook);
      if (!pb) return this.failCase(caseId, `unknown playbook ${current.playbook}`);
      const handler = pb.states[current.state];
      if (!handler) return this.failCase(caseId, `unknown state ${current.state}`);

      const ctx: CaseContext = {
        caseId: current.id,
        userId: current.userId,
        channel: current.channel,
        goal: current.goal,
        state: current.state,
        context: current.context,
        pendingReplies: [],
      };

      let transition: Transition;
      try {
        transition = await handler.onEnter(ctx);
      } catch (err) {
        const reason = String((err as Error)?.message ?? err);
        log.error({ caseId, state: current.state, err: reason }, "playbook state threw");
        return this.failCase(caseId, reason, current.state);
      }

      await this.store.appendEvent(caseId, "state_transition", {
        from: current.state, transition: summarize(transition),
      });
      if (ctx.pendingReplies.length > 0) {
        await this.store.appendEvent(caseId, "replies", {
          texts: ctx.pendingReplies.map((r) => r.text),
        });
      }

      switch (kindOf(transition)) {
        case "advance": {
          const t = transition as { to: string; context?: Record<string, unknown> };
          await this.store.updateCase(caseId, {
            state: t.to, status: "running", context: t.context ?? {}, wakeAt: null,
          });
          break; // loop continues from the new state
        }
        case "ask": {
          const t = transition as Extract<Transition, { askUser: unknown }>;
          const d = await this.store.openDecision({
            id: `dec_${randomUUID()}`, caseId,
            question: t.askUser.question, options: t.askUser.options ?? [],
          });
          await this.store.updateCase(caseId, {
            status: "waiting_user", context: { ...(t.context ?? {}), decisionId: d.id }, wakeAt: null,
          });
          await this.store.appendEvent(caseId, "decision_opened", {
            decisionId: d.id, question: d.question,
          });
          const updated = (await this.store.getCase(caseId))!;
          return this.outcome(updated, false, ctx.pendingReplies);
        }
        case "sleep": {
          const t = transition as Extract<Transition, { sleepUntil: Date; to?: string }>;
          await this.store.updateCase(caseId, {
            // `to` moves the resume point (e.g. execute → recheck) so the wake
            // does NOT re-run the state that decided to sleep.
            state: t.to ?? (await this.store.getCase(caseId))!.state,
            status: "waiting_timeout", context: t.context ?? {}, wakeAt: t.sleepUntil,
          });
          const updated = (await this.store.getCase(caseId))!;
          return this.outcome(updated, false, ctx.pendingReplies);
        }
        case "doubt": {
          const t = transition as Extract<Transition, { inDoubt: unknown }>;
          await this.store.updateCase(caseId, {
            status: "in_doubt", context: { ...(t.context ?? {}), doubtReason: t.inDoubt.reason },
            wakeAt: null,
          });
          const updated = (await this.store.getCase(caseId))!;
          return this.outcome(updated, true, ctx.pendingReplies);
        }
        case "complete": {
          const t = transition as Extract<Transition, { complete: unknown }>;
          await this.store.updateCase(caseId, { context: t.context ?? {} });
          await this.complete(caseId, t.complete.summary);
          const done = (await this.store.getCase(caseId))!;
          return this.outcome(done, done.status === "completed", ctx.pendingReplies);
        }
        case "fail": {
          const t = transition as Extract<Transition, { fail: unknown }>;
          await this.store.appendEvent(caseId, "case_failed", { reason: t.fail.reason });
          await this.store.updateCase(caseId, { status: "failed", context: t.context ?? {}, wakeAt: null });
          const done = (await this.store.getCase(caseId))!;
          return this.outcome(done, true, ctx.pendingReplies);
        }
      }
    }
    // Loop guard: a playbook that never rests is a bug — fail it loudly.
    return this.failCase(caseId, `transition loop exceeded ${MAX_HOPS} hops`);
  }

  /** Answer an open decision on a case and resume it. Returns null when the
   *  case is not waiting on a user. */
  async signal(caseId: string, answer: string): Promise<CaseStepOutcome | null> {
    const c = await this.store.getCase(caseId);
    if (!c || c.status !== "waiting_user") return null;
    const decision = await this.store.getOpenDecisionForCase(caseId);
    if (!decision) return null;
    const applied = await this.store.answerDecision(decision.id, answer);
    if (!applied) return null;
    await this.store.appendEvent(caseId, "decision_answered", { decisionId: decision.id, answer });
    await this.store.addEvidence({
      id: `ev_${randomUUID()}`,
      caseId,
      actionId: null,
      kind: "user_confirmation",
      payload: { decisionId: decision.id, question: decision.question, answer },
    });
    await this.store.updateCase(caseId, { status: "running", wakeAt: null });
    return this.advance(caseId);
  }

  /** Answer the newest user-waiting case for a user (channel routing). */
  async signalLatest(userId: string, channel: string, answer: string): Promise<CaseStepOutcome | null> {
    const open = await this.store.listOpenCases(userId, channel);
    const waiting = open.find((c) => c.status === "waiting_user");
    if (!waiting) return null;
    return this.signal(waiting.id, answer);
  }

  async cancel(caseId: string, reason: string): Promise<boolean> {
    const c = await this.store.getCase(caseId);
    if (!c || isResting(c.status)) return false;
    await this.store.appendEvent(caseId, "case_cancelled", { reason });
    await this.store.updateCase(caseId, { status: "cancelled" });
    return true;
  }

  async status(caseId: string): Promise<RuntimeStatus | null> {
    const c = await this.store.getCase(caseId);
    if (!c) return null;
    const [events, evidence] = await Promise.all([
      this.store.listEvents(caseId),
      this.store.listEvidence(caseId),
    ]);
    return {
      caseId,
      status: c.status,
      state: c.state,
      goal: c.goal,
      events: events.map((e) => ({ seq: e.seq, type: e.type, at: e.at })),
      evidence: evidence.map((e) => ({ kind: e.kind, at: e.at })),
    };
  }

  /** Resume every waiting_timeout case whose wake_at has passed. Returns how
   *  many were resumed. Called by the worker loop. */
  async wakeDueCases(now = new Date()): Promise<number> {
    const due = await this.store.listWakeable(now);
    let n = 0;
    for (const c of due) {
      if(!this.playbooks.has(c.playbook) || !await this.store.claimWake(c.id,now)) continue;
      await this.store.appendEvent(c.id, "case_wake", { wakeAt: c.wakeAt?.toISOString() ?? null });
      try {
        await this.advance(c.id);
      } catch (err) {
        log.error({ caseId: c.id, err: String(err) }, "wake advance failed");
      }
      n++;
    }
    return n;
  }

  /** A process can die after a Case became running. Its database session lock
   * is released by PostgreSQL; serialized advance then resumes the recorded
   * action. Gateway playbooks requery a submitted action, never purchase again. */
  async recoverRunning(): Promise<void> {
    for(const c of await this.store.listByStatus("running")) {
      if(!this.playbooks.has(c.playbook)) continue;
      try { await this.advance(c.id); }
      catch(error) { log.error({caseId:c.id,error:String(error)},"running case recovery will retry"); }
    }
  }

  /** Run registered reconcilers over in_doubt cases. Called by the worker loop. */
  async reconcileInDoubt(): Promise<number> {
    const open = await this.store.listByStatus("in_doubt");
    let n = 0;
    for (const c of open) {
      const fn = this.reconcilers.get(c.playbook);
      if (!fn) continue;
      try {
        await fn(c.id);
        n++;
      } catch (err) {
        log.error({ caseId: c.id, err: String(err) }, "reconciler failed");
      }
    }
    return n;
  }

  private async failCase(caseId: string, reason: string, state?: string): Promise<CaseStepOutcome> {
    const ambiguous=(await this.store.listActions(caseId)).some(a=>a.status==="executing"||a.status==="in_doubt");
    await this.store.appendEvent(caseId, ambiguous?"case_in_doubt":"case_failed", { reason, ...(state ? { state } : {}) });
    await this.store.updateCase(caseId, { status: ambiguous?"in_doubt":"failed" });
    return this.outcome((await this.store.getCase(caseId))!, true);
  }

  private outcome(rec: CaseRecord, done: boolean, replies: CaseMessage[] = []): CaseStepOutcome {
    return { caseId: rec.id, status: rec.status, state: rec.state, replies, done };
  }
}

export function isResting(status: CaseRecord["status"]): boolean {
  return (
    status === "prepared" ||
    status === "verifying" ||
    status === "waiting_user" ||
    status === "waiting_timeout" ||
    status === "in_doubt" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function kindOf(t: Transition): "advance" | "ask" | "sleep" | "doubt" | "complete" | "fail" {
  // sleepBefore advance: a sleep transition may carry `to` (the resume state),
  // so the presence of `to` alone must not classify it as an advance.
  if ("sleepUntil" in t) return "sleep";
  if ("to" in t) return "advance";
  if ("askUser" in t) return "ask";
  if ("inDoubt" in t) return "doubt";
  if ("complete" in t) return "complete";
  return "fail";
}

function summarize(t: Transition): Record<string, unknown> {
  if ("sleepUntil" in t) return { sleepUntil: t.sleepUntil.toISOString(), to: t.to };
  if ("to" in t) return { to: t.to };
  if ("askUser" in t) return { askUser: t.askUser.question };
  if ("inDoubt" in t) return { inDoubt: t.inDoubt.reason };
  if ("complete" in t) return { complete: t.complete.summary };
  return { fail: (t as { fail: { reason: string } }).fail.reason };
}
