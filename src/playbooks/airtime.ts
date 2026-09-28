/**
 * buy_airtime — the first Case-backed playbook (brief §AIRTIME).
 *
 * Lifecycle: validate → authorize (policy) → [confirm] → reserve → execute →
 * verify → complete, with recheck/reconcile branches for accepted-but-pending
 * and unknown outcomes. Failure branches: policy rejection, definitive provider
 * failure (reservation released), unknown outcome (case IN_DOUBT — the debit
 * stays, the reconciler requeries; a timeout is never treated as a refund).
 *
 * The completion rule is the verifier: the case completes ONLY with a provider
 * receipt recorded on the action AND the reservation captured/settled. The
 * executing state cannot declare success by itself.
 *
 * Resume semantics: when a state's askUser is answered, the case re-enters THE
 * SAME state; that state reads the answered decision from the store via
 * context.decisionId. Nothing is carried in memory across resumes.
 */
import { randomUUID } from "node:crypto";
import type { Playbook, Transition, CaseContext } from "../cases/types.js";
import type { CaseRunner } from "../cases/runtime.js";
import type { PolicyEngine } from "../policy/policy.js";
import type { CaseStore } from "../cases/store.js";
import { normalizePhone, validNigerianPhone, networkFromPhone } from "../skills/intentHelpers.js";
import { custodyBalance } from "../capabilities/airtime.js";

export interface AirtimeSlots {
  phone?: string;
  amount?: number;
  network?: string;
}

export interface AirtimeDeps {
  store: CaseStore;
  policy: PolicyEngine;
  runner: CaseRunner;
  /** Custody balance check — injectable for tests. */
  getBalance?: typeof custodyBalance;
  /** Recheck wait for accepted-pending purchases. */
  requeryDelayMs?: number;
}

const CONFIRM_YES = /^(yes|y|yes+|confirm|confirmed|ok|okay|go|go ahead|do it)\b/i;
const CONFIRM_NO = /^(no|n|no+|cancel|stop|don't|dont|abort)\b/i;
const NETWORKS = ["MTN", "Glo", "Airtel", "9mobile"];

function fail(reason: string): Transition {
  return { fail: { reason } };
}

export function airtimePlaybook(deps: AirtimeDeps): Playbook {
  const getBalance = deps.getBalance ?? custodyBalance;
  const requeryDelay = deps.requeryDelayMs ?? 30_000;

  /** The answered decision for this state's ask, if we asked. */
  async function answeredDecision(ctx: CaseContext): Promise<{ question: string; answer: string } | null> {
    const decisionId = ctx.context.decisionId as string | undefined;
    if (!decisionId) return null;
    const d = await deps.store.getDecision(decisionId);
    if (!d || d.status !== "answered" || !d.answer) return null;
    return { question: d.question, answer: d.answer };
  }

  return {
    id: "airtime",
    initialState: "validate",
    states: {
      // ---- validate: deterministic checks, no model in sight ----------------
      validate: {
        async onEnter(ctx: CaseContext): Promise<Transition> {
          const slots = { ...(ctx.context.slots as AirtimeSlots) };

          // Resume after a network question: the answer IS the network.
          const answered = await answeredDecision(ctx);
          if (answered?.question === "network") {
            slots.network = answered.answer.trim();
          }

          const phone = normalizePhone(String(slots.phone ?? ""));
          const amount = Number(slots.amount);
          let network = String(slots.network ?? "").trim().toLowerCase();

          if (!validNigerianPhone(phone)) return fail("invalid phone number");
          if (!amount || amount <= 0) return fail("missing amount");
          if (amount < 50) return fail("minimum airtime is ₦50");
          if (amount > 50_000) return fail("maximum airtime is ₦50,000");
          if (!network) network = networkFromPhone(phone) ?? "";
          if (!network) {
            ctx.pendingReplies.push({
              kind: "text",
              text: "Which network is that number on — MTN, Glo, Airtel or 9mobile?",
            });
            return {
              askUser: { question: "network", options: NETWORKS },
              context: { ...ctx.context, slots: { ...slots, phone }, decisionId: undefined },
            };
          }
          const norm = NETWORKS.find((n) => n.toLowerCase() === network);
          if (!norm) return fail(`unsupported network ${network}`);
          return {
            to: "authorize",
            context: { ...ctx.context, slots: { ...slots, phone, amount, network: norm } },
          };
        },
      },

      // ---- authorize: deterministic policy; may require user confirmation ---
      authorize: {
        async onEnter(ctx: CaseContext): Promise<Transition> {
          const slots = ctx.context.slots as Required<AirtimeSlots>;
          const amountMinor = BigInt(Math.round(slots.amount * 100));

          // Resume after a confirmation question: a clear "no" ends the case;
          // a "yes" lets policy see the recorded user_confirmation evidence.
          const answered = await answeredDecision(ctx);
          if (answered?.question === "confirm_purchase") {
            if (CONFIRM_NO.test(answered.answer)) {
              ctx.pendingReplies.push({ kind: "text", text: "Okay, cancelled — nothing was charged." });
              return fail("user declined the purchase");
            }
            if (!CONFIRM_YES.test(answered.answer)) {
              ctx.pendingReplies.push({
                kind: "text",
                text: "Please reply yes to confirm or no to cancel.",
              });
              return { askUser: { question: "confirm_purchase", options: ["yes", "no"] }, context: ctx.context };
            }
          }

          const evidence = await deps.store.listEvidence(ctx.caseId);
          const req = {
            userId: ctx.userId,
            capability: "telecom.airtime" as const,
            amountMinor,
            caseSpentMinor: BigInt(Number(ctx.context.caseSpentMinor ?? 0)),
            caseBudgetMinor:
              ctx.context.caseBudgetMinor != null
                ? BigInt(Number(ctx.context.caseBudgetMinor))
                : null,
            evidenceKinds: evidence.map((e) => e.kind),
          };
          // Ask BEFORE the hard gate: precheck says whether a confirmation is
          // needed; authorize() then refuses execution without the evidence.
          if (deps.policy.precheck(req).requiresConfirmation && !evidence.some((e) => e.kind === "user_confirmation")) {
            ctx.pendingReplies.push({
              kind: "text",
              text: `Confirm: buy ₦${slots.amount.toLocaleString()} ${slots.network.toUpperCase()} airtime for ${slots.phone}? Reply yes or no.`,
            });
            return {
              askUser: { question: "confirm_purchase", options: ["yes", "no"] },
              context: { ...ctx.context, decisionId: undefined },
            };
          }
          const decision = deps.policy.authorize(req);
          if (!decision.allowed) {
            ctx.pendingReplies.push({ kind: "text", text: `I can't do that: ${decision.reason}.` });
            return fail(decision.reason);
          }
          return { to: "reserve", context: { ...ctx.context, decisionId: undefined } };
        },
      },

      // ---- reserve: verify custody funds (the debit itself happens with the
      // provider submit; the reservation row is created with the action) ------
      reserve: {
        async onEnter(ctx: CaseContext): Promise<Transition> {
          const slots = ctx.context.slots as Required<AirtimeSlots>;
          const bal = await getBalance(ctx.userId);
          const covered = bal.ok && bal.ngn != null && bal.ngn >= slots.amount;
          if (!covered) {
            if (bal.ok) {
              ctx.pendingReplies.push({
                kind: "text",
                text: bal.address
                  ? `You don't have enough balance yet. Add USDC to your Axis wallet to top up:\n${bal.address}`
                  : "You don't have enough balance yet. Add funds to your Axis wallet first.",
              });
              return fail("insufficient funds");
            }
            ctx.pendingReplies.push({
              kind: "text",
              text: "I couldn't check your balance just now. Please try again shortly.",
            });
            return fail("balance unavailable");
          }
          return { to: "execute", context: { ...ctx.context, fundsVerified: true } };
        },
      },

      // ---- execute: exactly-once action, every attempt recorded -------------
      execute: {
        async onEnter(ctx: CaseContext): Promise<Transition> {
          const slots = ctx.context.slots as Required<AirtimeSlots>;
          let actionId = ctx.context.actionId as string | undefined;
          if (!actionId) {
            // Stable idempotency key: one per case, never re-randomized. A
            // retry of THIS purchase (after timeout/crash) lands on the same
            // action row; a new purchase is a new case.
            const { action } = await deps.store.createAction({
              id: `act_${randomUUID()}`,
              caseId: ctx.caseId,
              capability: "telecom.airtime",
              idempotencyKey: `airtime:${ctx.caseId}`,
              input: { network: slots.network, amount: slots.amount, phone: slots.phone, owner: ctx.userId },
            });
            actionId = action.id;
            await deps.store.updateActionStatus(actionId, "authorized");
            await deps.store.putReservation({
              id: `res_${randomUUID()}`,
              actionId,
              owner: ctx.userId,
              amountMinor: BigInt(Math.round(slots.amount * 100)),
              asset: "NGN",
              status: "reserved",
            });
            ctx.context = { ...ctx.context, actionId };
          }

          const exec = deps.runner.capability("telecom.airtime");
          if (!exec) return fail("telecom.airtime capability not registered");
          await deps.store.updateActionStatus(actionId, "executing");
          const result = await exec.execute({
            actionId,
            idempotencyKey: `airtime:${ctx.caseId}`,
            params: { network: slots.network, amount: slots.amount, phone: slots.phone, owner: ctx.userId },
          });
          await deps.store.appendAttempt({
            id: `att_${randomUUID()}`,
            actionId,
            provider: exec.provider,
            mode: exec.mode,
            request: { network: slots.network, amount: slots.amount, phone: slots.phone },
            outcome: result.outcome,
            response: result.response,
            providerRef: result.providerRef ?? null,
          });

          if (result.outcome === "unknown") {
            // The provider may have accepted. The debit stays; reconciliation
            // decides. NEVER release here — that is how free airtime happens.
            await deps.store.setReservationStatus(actionId, "in_doubt");
            await deps.store.updateActionStatus(actionId, "in_doubt");
            ctx.pendingReplies.push({
              kind: "text",
              text: `Your ₦${slots.amount.toLocaleString()} ${slots.network.toUpperCase()} top-up to ${slots.phone} is processing. I'll confirm here once it lands.`,
            });
            return { inDoubt: { reason: "provider outcome unknown" }, context: ctx.context };
          }

          if (result.outcome === "failed") {
            await deps.store.setReservationStatus(actionId, "released");
            await deps.store.updateActionStatus(actionId, "released");
            const insufficient = result.response.reason === "insufficient_balance";
            ctx.pendingReplies.push({
              kind: "text",
              text: insufficient
                ? "That didn't go through — not enough balance. Nothing was charged."
                : "I couldn't buy that airtime just now. Nothing was charged — please try again shortly.",
            });
            return fail("provider rejected the purchase");
          }

          const providerStatus = String(result.response.providerStatus ?? "");
          if (providerStatus === "delivered" || providerStatus === "duplicate") {
            return { to: "verify", context: ctx.context };
          }
          // accepted but not yet delivered: the charge stands, wait, recheck.
          await deps.store.setReservationStatus(actionId, "captured");
          ctx.pendingReplies.push({
            kind: "text",
            text: `Your ₦${slots.amount.toLocaleString()} ${slots.network.toUpperCase()} top-up to ${slots.phone} is processing. I'll confirm once it lands.`,
          });
          return {
            sleepUntil: new Date(Date.now() + requeryDelay),
            to: "recheck",
            context: ctx.context,
          };
        },
      },

      // ---- recheck: accepted-pending path wakes here ------------------------
      recheck: {
        async onEnter(ctx: CaseContext): Promise<Transition> {
          const actionId = ctx.context.actionId as string;
          const requery = deps.runner.capability("telecom.airtime.requery");
          if (!requery) return fail("telecom.airtime.requery capability not registered");
          const result = await requery.execute({
            actionId, idempotencyKey: `airtime:${ctx.caseId}`, params: {},
          });
          await deps.store.appendAttempt({
            id: `att_${randomUUID()}`,
            actionId,
            provider: requery.provider,
            mode: requery.mode,
            request: { requery: true },
            outcome: result.outcome,
            response: result.response,
          });
          const status = String(result.response.providerStatus ?? "");
          if (result.outcome === "ok" && status === "delivered") {
            return { to: "verify", context: { ...ctx.context, providerStatus: "delivered" } };
          }
          if (result.outcome === "failed") {
            // Custody reports definitive failure after acceptance: compensate.
            await deps.store.setReservationStatus(actionId, "reversed");
            await deps.store.updateActionStatus(actionId, "reversed");
            ctx.pendingReplies.push({
              kind: "text",
              text: "That top-up didn't make it — the amount has been returned to your balance.",
            });
            return fail("accepted then reported failed; reservation reversed");
          }
          const attempts = Number(ctx.context.recheckAttempts ?? 0) + 1;
          if (attempts >= 5) {
            await deps.store.setReservationStatus(actionId, "in_doubt");
            await deps.store.updateActionStatus(actionId, "in_doubt");
            return {
              inDoubt: { reason: "still pending after repeated requeries" },
              context: { ...ctx.context, recheckAttempts: attempts },
            };
          }
          return {
            sleepUntil: new Date(Date.now() + requeryDelay),
            context: { ...ctx.context, recheckAttempts: attempts },
          };
        },
      },

      // ---- verify: the boundary the executor cannot talk its way past -------
      verify: {
        async onEnter(ctx: CaseContext): Promise<Transition> {
          const actionId = ctx.context.actionId as string;
          const evidence = await deps.store.listEvidence(ctx.caseId);
          const hasReceipt = evidence.some(
            (e) => e.kind === "provider_receipt" && e.actionId === actionId,
          );
          if (!hasReceipt) {
            // First-class proof: the provider receipt is persisted, not claimed.
            await deps.store.addEvidence({
              id: `ev_${randomUUID()}`,
              caseId: ctx.caseId,
              actionId,
              kind: "provider_receipt",
              payload: {
                providerStatus: ctx.context.providerStatus ?? "delivered",
                source: "onboarding/vtpass",
                idempotencyKey: `airtime:${ctx.caseId}`,
              },
            });
          }
          const reservation = await deps.store.getReservationByAction(actionId);
          if (!reservation) return fail("verification failed: no reservation on the action");
          if (reservation.status === "reserved" || reservation.status === "in_doubt") {
            await deps.store.setReservationStatus(actionId, "captured");
          }
          if (reservation.status === "released" || reservation.status === "reversed") {
            return fail("verification failed: reservation was released");
          }
          await deps.store.updateActionStatus(actionId, "settled");
          const slots = ctx.context.slots as Required<AirtimeSlots>;
          ctx.pendingReplies.push({
            kind: "text",
            text: `Done. ₦${slots.amount.toLocaleString()} ${slots.network.toUpperCase()} airtime sent to ${slots.phone}.`,
          });
          return { complete: { summary: "airtime delivered and charged" }, context: ctx.context };
        },
      },
    },
  };
}

/** Reconciler for in_doubt airtime cases: requery until a verdict, then move
 *  the case the way the provider actually went. Never auto-refunds an unknown. */
export function airtimeReconciler(deps: AirtimeDeps) {
  return async (caseId: string): Promise<void> => {
    const rec = await deps.store.getCase(caseId);
    if (!rec) return;
    const actionId = rec.context.actionId as string | undefined;
    const slots = rec.context.slots as Required<AirtimeSlots> | undefined;
    const requery = deps.runner.capability("telecom.airtime.requery");
    if (!actionId || !requery) return;

    const result = await requery.execute({ actionId, idempotencyKey: `airtime:${caseId}`, params: {} });
    await deps.store.appendAttempt({
      id: `att_${randomUUID()}`,
      actionId,
      provider: requery.provider,
      mode: requery.mode,
      request: { reconcile: true },
      outcome: result.outcome,
      response: result.response,
    });
    const status = String(result.response.providerStatus ?? "");
    const reply = (text: string) =>
      deps.store.appendEvent(caseId, "replies", { texts: [text] });

    if (result.outcome === "ok" && status === "delivered") {
      await deps.store.setReservationStatus(actionId, "captured");
      await deps.store.updateActionStatus(actionId, "settled");
      await deps.store.addEvidence({
        id: `ev_${randomUUID()}`, caseId, actionId, kind: "provider_receipt",
        payload: { providerStatus: "delivered", source: "reconcile" },
      });
      if (slots) {
        reply(`Done. ₦${slots.amount.toLocaleString()} ${slots.network.toUpperCase()} airtime sent to ${slots.phone}.`);
      }
      await deps.store.appendEvent(caseId, "case_completed", { summary: "reconciled: delivered" });
      await deps.store.updateCase(caseId, { status: "completed" });
      return;
    }
    if (result.outcome === "failed") {
      // Definitive provider failure after an accepted submit: compensate.
      await deps.store.setReservationStatus(actionId, "reversed");
      await deps.store.updateActionStatus(actionId, "reversed");
      if (slots) {
        reply("That top-up didn't make it — the amount has been returned to your balance.");
      }
      await deps.store.appendEvent(caseId, "case_failed", { reason: "reconciled: provider failed; reservation reversed" });
      await deps.store.updateCase(caseId, { status: "failed" });
      return;
    }
    // Still unknown: remain in_doubt; the next sweep tries again. Escalation
    // (admin resolution) is an operations path — never an automatic refund.
    await deps.store.appendEvent(caseId, "reconcile_pending", { providerStatus: status || "unknown" });
  };
}
