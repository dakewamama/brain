/**
 * check_balance — read the user's spendable Axis balance from onboarding. Numbers
 * come from the ledger (real data), never the model.
 */
import type { SkillManifest, SkillOutcome, SkillContext } from "./registry.js";
import { getFromOnboarding } from "./payments.js";

export const checkBalanceSkill: SkillManifest = {
  id: "check_balance",
  name: "Check balance",
  description:
    "Check the user's Axis wallet balance, e.g. 'what is my balance' or 'how much do I have'.",
  parameters: { type: "object", properties: {} },
  origin: "baseline",
  async execute(_params, ctx: SkillContext): Promise<SkillOutcome> {
    const res = await getFromOnboarding(
      `/wallet/balance?userId=${encodeURIComponent(ctx.userId)}`,
    );
    if (!res.ok) {
      return {
        replies: [
          { kind: "text", text: "I couldn't check your balance just now. Try again shortly." },
        ],
      };
    }
    const ngn = typeof res.data.ngn === "number" ? res.data.ngn : null;
    const usdc = typeof res.data.usdc === "number" ? res.data.usdc : 0;
    const text =
      usdc > 0
        ? ngn != null
          ? `Your Axis balance is ${usdc} USDC (about ₦${ngn.toLocaleString()}).`
          : `Your Axis balance is ${usdc} USDC.`
        : "Your Axis balance is ₦0. Add USDC to your wallet to top up.";
    return { replies: [{ kind: "text", text }], data: res.data };
  },
};
