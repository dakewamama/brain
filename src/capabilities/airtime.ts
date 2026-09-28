/**
 * telecom.airtime capability — VTpass via the onboarding custody service.
 *
 * The executor never invents amounts and never retries with a new identity:
 * the idempotencyKey it forwards IS the action's stable key, so the custody
 * service (and VTpass's request_id) see the same identity on every retry.
 *
 * Outcome mapping is the honesty boundary:
 *  - parsed provider response "delivered"        -> outcome "ok",       ok true
 *  - parsed provider response pending/initiated  -> outcome "ok",       ok false (accepted, not delivered)
 *  - parsed provider response failed/rejected    -> outcome "failed"
 *  - transport error / timeout / unparseable     -> outcome "unknown"   (may have gone through!)
 * A timeout is NEVER reported as failed — that is how double-charges happen.
 */
import type { CapabilityExecutor } from "../cases/runtime.js";
import { callOnboarding, getFromOnboarding } from "../skills/payments.js";

interface OnboardingAirtimeResponse {
  status?: string; // delivered | pending | failed | duplicate | in_doubt | ...
  chargedBaseUnits?: string;
  remnantBaseUnits?: string;
  error?: string;
}

function mapDelivery(res: { ok: boolean; status: number; data: OnboardingAirtimeResponse }): {
  ok: boolean;
  outcome: "ok" | "failed" | "unknown";
  response: Record<string, unknown>;
  providerRef?: string;
} {
  const providerStatus = String(res.data.status ?? "");
  if (res.ok && (providerStatus === "delivered" || providerStatus === "duplicate")) {
    return {
      ok: true, outcome: "ok",
      response: { providerStatus, chargedBaseUnits: res.data.chargedBaseUnits, remnantBaseUnits: res.data.remnantBaseUnits },
      providerRef: res.data.chargedBaseUnits ? `charged:${res.data.chargedBaseUnits}` : undefined,
    };
  }
  if (res.ok && (providerStatus === "pending" || providerStatus === "initiated")) {
    return { ok: false, outcome: "ok", response: { providerStatus } };
  }
  if (res.ok && providerStatus === "in_doubt") {
    // The custody service could not determine the outcome either.
    return { ok: false, outcome: "unknown", response: { providerStatus, error: res.data.error } };
  }
  if (res.status === 402) {
    return { ok: false, outcome: "failed", response: { reason: "insufficient_balance" } };
  }
  if (res.ok) {
    // 2xx but an unrecognized body: do NOT assume failure.
    return { ok: false, outcome: "unknown", response: { raw: res.data } };
  }
  if (res.status === 0) {
    return { ok: false, outcome: "unknown", response: { error: "payments not configured" } };
  }
  return { ok: false, outcome: "failed", response: { httpStatus: res.status, error: res.data.error } };
}

export function airtimePurchaseExecutor(): CapabilityExecutor {
  return {
    capability: "telecom.airtime",
    provider: "onboarding/vtpass",
    mode: "LIVE",
    async execute({ idempotencyKey, params }) {
      const res = await callOnboarding("/airtime", {
        owner: params.owner,
        network: params.network,
        amount: params.amount,
        phone: params.phone,
        idempotencyKey,
      }).catch((err: unknown) => {
        // Transport-level failure (DNS, timeout, reset): the provider MAY have
        // accepted. Report unknown — the reconciler requeries.
        return { ok: false, status: 0, data: { error: String((err as Error)?.message ?? err) } };
      });
      return mapDelivery(res as { ok: boolean; status: number; data: OnboardingAirtimeResponse });
    },
  };
}

export function airtimeRequeryExecutor(): CapabilityExecutor {
  return {
    capability: "telecom.airtime.requery",
    provider: "onboarding/vtpass",
    mode: "LIVE",
    async execute({ idempotencyKey }) {
      const res = await getFromOnboarding(
        `/airtime/status?idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
      ).catch(() => ({ ok: false, status: 0, data: {} as OnboardingAirtimeResponse }));
      const providerStatus = String((res.data as OnboardingAirtimeResponse).status ?? "");
      if (res.ok && providerStatus === "delivered") {
        return { ok: true, outcome: "ok" as const, response: { providerStatus } };
      }
      if (res.ok && providerStatus === "failed") {
        return { ok: false, outcome: "failed" as const, response: { providerStatus } };
      }
      // pending / unknown / endpoint down: still no verdict.
      return { ok: false, outcome: "unknown" as const, response: { providerStatus, httpStatus: res.status } };
    },
  };
}

/** Balance lookup against custody (USDC balance with NGN estimate). */
export async function custodyBalance(userId: string): Promise<{
  ok: boolean; ngn: number | null; usdc: number; address?: string;
}> {
  const prov = await callOnboarding("/wallet", { userId }).catch(() => null);
  const address = prov && typeof prov.data.address === "string" ? prov.data.address : undefined;
  const bal = await getFromOnboarding(`/wallet/balance?userId=${encodeURIComponent(userId)}`)
    .catch(() => null);
  if (!bal || !bal.ok) return { ok: false, ngn: null, usdc: 0, address };
  const ngn = typeof bal.data.ngn === "number" ? bal.data.ngn : null;
  const usdc = typeof bal.data.usdc === "number" ? bal.data.usdc : 0;
  return { ok: true, ngn, usdc, address };
}
