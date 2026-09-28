/**
 * buy_airtime skill — the planner's surface for airtime. The actual purchase is
 * a Case: the skill starts one on the Case runtime and returns whatever the
 * playbook's states produced (slot prompts, confirmations, receipts). All the
 * money logic — policy, reservation, provider attempts, verification,
 * reconciliation — lives in playbooks/airtime.ts; this file only normalizes
 * inputs (shared with the deterministic fast path) and delegates.
 */
import type { SkillManifest, SkillOutcome, SkillContext } from "./registry.js";
import { getCaseRunner } from "../cases/index.js";
import { normalizePhone, validNigerianPhone } from "./intentHelpers.js";

export { normalizePhone, validNigerianPhone, networkFromPhone } from "./intentHelpers.js";

function needs(text: string): SkillOutcome {
  return { replies: [{ kind: "text", text }], needsInput: true };
}

export const buyAirtimeSkill: SkillManifest = {
  id: "buy_airtime",
  name: "Buy airtime",
  description:
    "Buy mobile airtime for a Nigerian phone number, e.g. 'buy ₦500 MTN airtime " +
    "for 08012345678'. Networks: MTN, Glo, Airtel, 9mobile.",
  parameters: {
    type: "object",
    properties: {
      network: { type: "string", description: "mtn | glo | airtel | 9mobile" },
      amount: { type: "number", description: "Amount in NGN" },
      phone: { type: "string", description: "Recipient phone number" },
    },
    required: ["amount", "phone"],
  },
  origin: "baseline",
  async execute(params, ctx: SkillContext): Promise<SkillOutcome> {
    const phone = normalizePhone(String(params.phone ?? ""));
    const amount = Number(params.amount);
    const network = typeof params.network === "string" ? params.network.trim().toLowerCase() : "";

    if (!phone) return needs("What number should I top up?");
    if (!validNigerianPhone(phone))
      return needs("That doesn't look like a Nigerian number. Send it like 08012345678.");
    if (!amount || amount <= 0) return needs("How much airtime should I buy?");

    // The playbook re-validates everything (minimums, network, policy,
    // confirmation) — this start is just the entry into the durable flow.
    const outcome = await getCaseRunner().start({
      userId: ctx.userId,
      channel: ctx.channel ?? "web",
      goal: `buy ${amount} NGN ${network} airtime for ${phone}`.replace(/\s+/g, " "),
      playbookId: "airtime",
      context: { slots: { phone, amount, network: network || undefined } },
    });
    return { replies: outcome.replies };
  },
};
