/**
 * Adversarial tests for the Case runtime + airtime playbook (brief §TESTING).
 * The executors are doubles at the capability boundary; the store, policy,
 * playbook and worker are the real code paths.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCaseStore } from "../../src/cases/store.js";
import { CaseRunner, type CapabilityExecutor } from "../../src/cases/runtime.js";
import { CaseWorker } from "../../src/cases/worker.js";
import { PolicyEngine } from "../../src/policy/policy.js";
import { airtimePlaybook, airtimeReconciler } from "../../src/playbooks/airtime.js";
import type { CaseStore } from "../../src/cases/store.js";

interface Harness {
  store: InMemoryCaseStore;
  runner: CaseRunner;
  worker: CaseWorker;
  notifications: { userId: string; channel: string; texts: string[] }[];
  start(input?: { amount?: number; budgetMinor?: bigint | null; phone?: string }): Promise<string>;
}

function harness(opts: {
  purchase: CapabilityExecutor["execute"];
  requery?: CapabilityExecutor["execute"];
  balance?: { ok: boolean; ngn: number | null; usdc: number; address?: string };
  confirmThresholdNgn?: number;
  /** Shrink the POLICY per-transaction cap (NGN) — below the playbook's own ₦50k. */
  policyMaxNgn?: number;
}): Harness {
  const store = new InMemoryCaseStore();
  const policy = new PolicyEngine();
  if (opts.confirmThresholdNgn != null || opts.policyMaxNgn != null) {
    policy.register("telecom.airtime", {
      risk: "medium",
      maxAmountMinor: BigInt(opts.policyMaxNgn ?? 50_000) * 100n,
      confirmAtMinor: BigInt(opts.confirmThresholdNgn ?? 20_000) * 100n,
    });
  }
  const runner = new CaseRunner(store, "SANDBOX");
  const deps = {
    store: store as CaseStore,
    policy,
    runner,
    getBalance: async () => opts.balance ?? { ok: true, ngn: 100_000, usdc: 70, address: "Wa11etAddr111" },
    requeryDelayMs: 1,
  };
  runner.registerPlaybook(airtimePlaybook(deps));
  runner.registerCapability({
    capability: "telecom.airtime",
    provider: "test/vtpass",
    mode: "SANDBOX",
    execute: opts.purchase,
  });
  runner.registerCapability({
    capability: "telecom.airtime.requery",
    provider: "test/vtpass",
    mode: "SANDBOX",
    execute: opts.requery ?? (async () => ({ ok: false, outcome: "unknown" as const, response: { providerStatus: "" } })),
  });
  runner.registerReconciler("airtime", airtimeReconciler(deps));
  const notifications: Harness["notifications"] = [];
  const worker = new CaseWorker(runner, store, async (userId, channel, texts) => {
    notifications.push({ userId, channel, texts });
  });
  return {
    store,
    runner,
    worker,
    notifications,
    async start(input) {
      const out = await runner.start({
        userId: "user-1",
        channel: "whatsapp",
        goal: "airtime",
        playbookId: "airtime",
        budgetMinor: input?.budgetMinor ?? null,
        context: {
          slots: {
            phone: input?.phone ?? "08031234567",
            amount: input?.amount ?? 500,
            network: "MTN",
          },
        },
      });
      return out.caseId;
    },
  };
}

const delivered = async () => ({ ok: true, outcome: "ok" as const, response: { providerStatus: "delivered" } });

let h: Harness;
beforeEach(() => {
  h = harness({ purchase: delivered });
});

test("happy path: delivered → settled action, captured reservation, provider receipt", async () => {
  const caseId = await h.start();
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "completed");
  const action = [...h.store.actions.values()].find((a) => a.caseId === caseId);
  assert.ok(action, "an action was recorded");
  assert.equal(action.status, "settled");
  assert.equal(action.idempotencyKey, `airtime:${caseId}`);
  const reservation = await h.store.getReservationByAction(action.id);
  assert.equal(reservation?.status, "captured");
  assert.equal(reservation?.amountMinor, 50_000n);
  const evidence = await h.store.listEvidence(caseId);
  assert.ok(evidence.some((e) => e.kind === "provider_receipt" && e.actionId === action.id));
});

test("insufficient funds fails BEFORE any action or reservation exists", async () => {
  h = harness({ purchase: delivered, balance: { ok: true, ngn: 100, usdc: 0.06, address: "Wa11etAddr111" } });
  const caseId = await h.start();
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "failed");
  assert.equal(h.store.actions.size, 0, "no side effect without funds");
  assert.equal(h.store.reservations.size, 0);
  const events = await h.store.listEvents(caseId);
  const replies = events.find((e) => e.type === "replies");
  assert.match(JSON.stringify(replies?.payload ?? {}), /Wa11etAddr111/);
});

test("a provider timeout is IN_DOUBT: the debit stays, nothing is refunded", async () => {
  h = harness({
    purchase: async () => ({ ok: false, outcome: "unknown", response: { error: "etimedout" } }),
  });
  const caseId = await h.start();
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "in_doubt");
  const action = [...h.store.actions.values()].find((a) => a.caseId === caseId)!;
  assert.equal(action.status, "in_doubt");
  const reservation = await h.store.getReservationByAction(action.id);
  assert.equal(reservation?.status, "in_doubt", "reservation must NOT be released on an unknown");
});

test("reconciliation resolves IN_DOUBT delivered: completes with receipt, notifies once", async () => {
  h = harness({
    purchase: async () => ({ ok: false, outcome: "unknown", response: {} }),
    requery: async () => ({ ok: true, outcome: "ok", response: { providerStatus: "delivered" } }),
  });
  const caseId = await h.start();
  assert.equal((await h.store.getCase(caseId))?.status, "in_doubt");
  await h.runner.reconcileInDoubt();
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "completed");
  const action = [...h.store.actions.values()].find((a) => a.caseId === caseId)!;
  assert.equal(action.status, "settled");
  assert.equal((await h.store.getReservationByAction(action.id))?.status, "captured");
  // The worker delivers the verdict reply exactly once, even across sweeps.
  await h.worker.tick();
  await h.worker.tick();
  assert.equal(h.notifications.filter((n) => n.texts.join(" ").includes("Done.")).length, 1);
});

test("reconciliation resolves IN_DOUBT failed: reservation reversed, case failed", async () => {
  h = harness({
    purchase: async () => ({ ok: false, outcome: "unknown", response: {} }),
    requery: async () => ({ ok: false, outcome: "failed", response: { providerStatus: "failed" } }),
  });
  const caseId = await h.start();
  await h.runner.reconcileInDoubt();
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "failed");
  const action = [...h.store.actions.values()].find((a) => a.caseId === caseId)!;
  assert.equal((await h.store.getReservationByAction(action.id))?.status, "reversed");
});

test("reconciliation with no verdict yet stays IN_DOUBT (never auto-refunds)", async () => {
  h = harness({
    purchase: async () => ({ ok: false, outcome: "unknown", response: {} }),
    requery: async () => ({ ok: false, outcome: "unknown", response: { providerStatus: "pending" } }),
  });
  const caseId = await h.start();
  await h.runner.reconcileInDoubt();
  await h.runner.reconcileInDoubt();
  assert.equal((await h.store.getCase(caseId))?.status, "in_doubt");
  const action = [...h.store.actions.values()].find((a) => a.caseId === caseId)!;
  assert.equal((await h.store.getReservationByAction(action.id))?.status, "in_doubt");
});

test("accepted-then-pending charges and rechecks until delivered", async () => {
  let calls = 0;
  h = harness({
    purchase: async () => ({ ok: false, outcome: "ok", response: { providerStatus: "pending" } }),
    requery: async () => {
      calls++;
      return calls >= 2
        ? { ok: true, outcome: "ok" as const, response: { providerStatus: "delivered" } }
        : { ok: false, outcome: "unknown" as const, response: { providerStatus: "pending" } };
    },
  });
  const caseId = await h.start();
  assert.equal((await h.store.getCase(caseId))?.status, "waiting_timeout");
  await h.runner.wakeDueCases(new Date(Date.now() + 60_000));
  assert.equal((await h.store.getCase(caseId))?.status, "waiting_timeout", "first recheck still pending");
  await h.runner.wakeDueCases(new Date(Date.now() + 120_000));
  assert.equal((await h.store.getCase(caseId))?.status, "completed");
});

test("a process restart resumes the case from the store", async () => {
  h = harness({
    purchase: async () => ({ ok: false, outcome: "ok", response: { providerStatus: "pending" } }),
    requery: async () => ({ ok: true, outcome: "ok", response: { providerStatus: "delivered" } }),
  });
  const caseId = await h.start();
  assert.equal((await h.store.getCase(caseId))?.status, "waiting_timeout");

  // "Restart": a brand-new runner over the SAME store, nothing in memory.
  const policy2 = new PolicyEngine();
  const runner2 = new CaseRunner(h.store as CaseStore, "SANDBOX");
  const deps = { store: h.store as CaseStore, policy: policy2, runner: runner2, requeryDelayMs: 1 };
  runner2.registerPlaybook(airtimePlaybook(deps));
  runner2.registerCapability({
    capability: "telecom.airtime.requery",
    provider: "test/vtpass",
    mode: "SANDBOX",
    execute: async () => ({ ok: true, outcome: "ok" as const, response: { providerStatus: "delivered" } }),
  });
  const due = await h.store.listWakeable(new Date(Date.now() + 60_000));
  assert.equal(due.length, 1);
  // The wake sweep is the real resume path (a resting case is never advanced
  // by a stray advance() call — that's the guard, not a bug).
  await runner2.wakeDueCases(new Date(Date.now() + 60_000));
  assert.equal((await h.store.getCase(caseId))?.status, "completed");
});

test("at/above the confirmation threshold the case waits for an explicit yes", async () => {
  h = harness({ purchase: delivered, confirmThresholdNgn: 100 });
  const caseId = await h.start({ amount: 500 });
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "waiting_user");
  assert.equal(h.store.actions.size, 0, "nothing executes before confirmation");

  const signaled = await h.runner.signal(caseId, "yes");
  assert.ok(signaled);
  assert.equal((await h.store.getCase(caseId))?.status, "completed");
  const evidence = await h.store.listEvidence(caseId);
  assert.ok(evidence.some((e) => e.kind === "user_confirmation"));
});

test("a clear no cancels without executing anything", async () => {
  h = harness({ purchase: delivered, confirmThresholdNgn: 100 });
  const caseId = await h.start({ amount: 500 });
  await h.runner.signal(caseId, "no");
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "failed");
  assert.equal(h.store.actions.size, 0);
});

test("an ambiguous confirmation reply re-asks instead of proceeding", async () => {
  h = harness({ purchase: delivered, confirmThresholdNgn: 100 });
  const caseId = await h.start({ amount: 500 });
  const out = await h.runner.signal(caseId, "maybe later");
  assert.equal(out?.status, "waiting_user");
  assert.equal(h.store.actions.size, 0);
});

test("amount above the per-transaction limit is rejected by policy", async () => {
  // The playbook's own validation allows ₦20,000; POLICY's cap is ₦10,000 —
  // proving the deterministic layer, not the playbook, draws the line.
  h = harness({ purchase: delivered, policyMaxNgn: 10_000 });
  const caseId = await h.start({ amount: 20_000 });
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "failed");
  assert.equal(h.store.actions.size, 0);
  const events = await h.store.listEvents(caseId);
  assert.match(JSON.stringify(events), /per-transaction limit/);
});

test("a case budget smaller than the purchase is enforced", async () => {
  h = harness({ purchase: delivered });
  const caseId = await h.start({ amount: 500, budgetMinor: 10_000n }); // ₦100 budget
  assert.equal((await h.store.getCase(caseId))?.status, "failed");
  assert.equal(h.store.actions.size, 0);
});

test("the verifier rejects completion without a reservation (no receipt, no case)", async () => {
  h = harness({
    purchase: async ({ actionId }) => {
      // Sabotage: the money state disappears between submit and verification.
      h.store.reservations.delete(actionId);
      return { ok: true, outcome: "ok" as const, response: { providerStatus: "delivered" } };
    },
  });
  const caseId = await h.start();
  const c = await h.store.getCase(caseId);
  assert.equal(c?.status, "failed", "the executor cannot talk its way past verification");
  const action = [...h.store.actions.values()].find((a) => a.caseId === caseId)!;
  assert.notEqual(action.status, "settled");
});

test("retries keep one action identity (stable idempotency key, growing attempts)", async () => {
  let calls = 0;
  h = harness({
    purchase: async () => {
      calls++;
      return calls === 1
        ? { ok: false, outcome: "unknown" as const, response: {} }
        : { ok: true, outcome: "ok" as const, response: { providerStatus: "delivered" } };
    },
    requery: async () => ({ ok: true, outcome: "ok" as const, response: { providerStatus: "delivered" } }),
  });
  const caseId = await h.start();
  await h.runner.reconcileInDoubt();
  const actions = [...h.store.actions.values()].filter((a) => a.caseId === caseId);
  assert.equal(actions.length, 1, "exactly one action for one purchase");
  assert.equal(actions[0].idempotencyKey, `airtime:${caseId}`);
  const attempts = h.store.listAttempts(actions[0].id);
  assert.ok(attempts.length >= 2, "the attempt is recorded, not overwritten");
  assert.equal(attempts[0].outcome, "unknown");
});

test("duplicate inbound is claimed once", async () => {
  const store = new InMemoryCaseStore();
  const first = await store.claimInbound({
    id: "inb_1", channel: "whatsapp", providerMessageId: "wamid.123", payload: {},
  });
  const second = await store.claimInbound({
    id: "inb_2", channel: "whatsapp", providerMessageId: "wamid.123", payload: {},
  });
  assert.equal(first, true);
  assert.equal(second, false, "a replayed webhook is dropped, never processed twice");
});

test("high-risk money capability always requires recorded confirmation", async () => {
  const policy = new PolicyEngine();
  const denied = policy.authorize({
    userId: "u1",
    capability: "money.transfer",
    amountMinor: 5_000n,
    caseSpentMinor: 0n,
    caseBudgetMinor: null,
    evidenceKinds: [],
  });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.rule, "confirm_before_execute");
  const allowed = policy.authorize({
    userId: "u1",
    capability: "money.transfer",
    amountMinor: 5_000n,
    caseSpentMinor: 0n,
    caseBudgetMinor: null,
    evidenceKinds: ["user_confirmation"],
  });
  assert.equal(allowed.allowed, true);
});
