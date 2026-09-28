/**
 * Policy — the deterministic boundary between planning and side effects.
 * The AI proposes; policy authorizes. No model output can create financial
 * authority: every rule here is code, every decision is explainable by the
 * rule that produced it.
 */
import { getConfig } from "../core/config.js";

/** Risk classes drive caps and confirmation. A capability registers exactly one. */
export type RiskClass = "informational" | "low" | "medium" | "high";

export interface CapabilityPolicy {
  risk: RiskClass;
  /** Per-transaction ceiling in minor units (kobo for NGN). */
  maxAmountMinor: bigint;
  /** Amounts at or above this need explicit user confirmation before execute. */
  confirmAtMinor: bigint;
}

export interface AuthorizationRequest {
  userId: string;
  capability: string;
  amountMinor: bigint | null;
  /** Already-captured spend on this case, minor units. */
  caseSpentMinor: bigint;
  caseBudgetMinor: bigint | null;
  /** Evidence kinds already attached to the case (e.g. user_confirmation). */
  evidenceKinds: string[];
  /** Per-user standing permission overrides (future: persisted grants). */
  standingPermission?: boolean;
}

export type PolicyDecision =
  | { allowed: true; requiresConfirmation: boolean; risk: RiskClass; rule: string }
  | { allowed: false; reason: string; rule: string };

export class PolicyEngine {
  private caps = new Map<string, CapabilityPolicy>();

  constructor() {
    const cfg = getConfig();
    const cap = BigInt(Math.max(0, cfg.MAX_TRANSACTION_NGN) || 50_000) * 100n;
    const confirm = BigInt(Math.max(0, cfg.CONFIRM_THRESHOLD_NGN) || 20_000) * 100n;
    this.register("telecom.airtime", { risk: "medium", maxAmountMinor: cap, confirmAtMinor: confirm });
    this.register("money.transfer", { risk: "high", maxAmountMinor: cap, confirmAtMinor: 0n });
    this.register("human.message", { risk: "informational", maxAmountMinor: 0n, confirmAtMinor: 0n });
  }

  register(capability: string, policy: CapabilityPolicy): void {
    this.caps.set(capability, policy);
  }

  policyFor(capability: string): CapabilityPolicy | undefined {
    return this.caps.get(capability);
  }

  /** UX-facing precheck: should the playbook ask the user before authorize()?
   *  True only when a confirmation is the ONLY thing standing between the
   *  request and approval — hard-limit violations skip the ask and fail fast
   *  in authorize(). authorize() remains the gate that refuses execution. */
  precheck(req: AuthorizationRequest): { requiresConfirmation: boolean } {
    const decision = this.authorize(req);
    return { requiresConfirmation: !decision.allowed && decision.rule === "confirm_before_execute" };
  }

  authorize(req: AuthorizationRequest): PolicyDecision {
    const cap = this.caps.get(req.capability);
    if (!cap) return { allowed: false, reason: `unknown capability ${req.capability}`, rule: "known_capability" };

    // Hard limits first: no amount of consent authorizes an oversized spend.
    if (req.amountMinor != null) {
      if (req.amountMinor > cap.maxAmountMinor) {
        return { allowed: false, reason: "amount exceeds the per-transaction limit", rule: "max_amount" };
      }
      if (req.caseBudgetMinor != null && req.caseSpentMinor + req.amountMinor > req.caseBudgetMinor) {
        return { allowed: false, reason: "amount exceeds this task's budget", rule: "case_budget" };
      }
    }

    // High risk always needs a recorded user confirmation, regardless of amount.
    const needsConfirmation =
      cap.risk === "high" ||
      (req.amountMinor != null && req.amountMinor >= cap.confirmAtMinor);
    if (needsConfirmation && !req.standingPermission && !req.evidenceKinds.includes("user_confirmation")) {
      return {
        allowed: false,
        reason: "confirmation required before this action can execute",
        rule: "confirm_before_execute",
      };
    }
    return {
      allowed: true,
      requiresConfirmation: needsConfirmation,
      risk: cap.risk,
      rule: "within_limits",
    };
  }
}
