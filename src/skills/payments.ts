/**
 * Money skills: save_address and pay_person. These are ATOMIC (planner-driven)
 * and DETERMINISTIC — no model in the money loop. They call the onboarding
 * service's authenticated off-ramp API; onboarding holds the Paj key and custody.
 * The brain never sees a private key.
 *
 * Anti-patterns honoured:
 *  - Account-name confirmation happens ahead of time (save_address resolves the
 *    name and asks the user to verify) — never during a pay.
 *  - The user's stated amount is echoed; no number is invented by a model.
 *  - Settlement is confirmed by Paj's webhook (the onboarding receiver), not here.
 */
import type { SkillManifest, SkillOutcome, SkillContext } from "./registry.js";
import type { Entity } from "../memory/entities.js";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("payments");

export async function callOnboarding(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const cfg = getConfig();
  if (!cfg.ONBOARDING_URL || !cfg.INTERNAL_API_TOKEN) {
    return { ok: false, status: 0, data: { error: "payments not configured" } };
  }
  const res = await fetch(`${cfg.ONBOARDING_URL.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.INTERNAL_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { ok: res.ok, status: res.status, data };
}

function accountNameOf(data: Record<string, unknown>): string | undefined {
  const direct = data.accountName;
  const nested = (data.data as { accountName?: string } | undefined)?.accountName;
  return (typeof direct === "string" && direct) || nested || undefined;
}

export const saveAddressSkill: SkillManifest = {
  id: "save_address",
  name: "Save a bank account",
  description:
    "Save a person's bank account ahead of time so payments to them are instant. " +
    "Resolves and shows the account name to confirm.",
  parameters: {
    type: "object",
    properties: {
      recipient: { type: "string" },
      bankCode: { type: "string" },
      accountNumber: { type: "string" },
    },
    required: ["accountNumber", "bankCode"],
  },
  origin: "baseline",
  async execute(params, ctx: SkillContext): Promise<SkillOutcome> {
    const bankCode = String(params.bankCode ?? "");
    const accountNumber = String(params.accountNumber ?? "");
    const recipient = typeof params.recipient === "string" ? params.recipient : "";
    if (!bankCode || !accountNumber) {
      return {
        replies: [{ kind: "text", text: "Send the bank and the account number to save." }],
        needsInput: true,
      };
    }
    const resolved = await callOnboarding("/offramp/resolve-account", { accountNumber });
    if (!resolved.ok) {
      return {
        replies: [{ kind: "text", text: "I couldn't verify that account. Check the number and try again." }],
      };
    }
    const accountName = accountNameOf(resolved.data);
    try {
      await ctx.memory.upsertEntity({
        userId: ctx.userId,
        kind: "person",
        canonicalName: recipient || accountName || accountNumber,
        aliases: recipient ? [recipient] : [],
        metadata: { bankCode, accountNumber, accountName },
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, "save_address memory write failed");
    }
    return {
      replies: [
        {
          kind: "text",
          text: accountName
            ? `That account is ${accountName}. Saved${recipient ? ` as ${recipient}` : ""} — please check the name is right before paying.`
            : `Saved${recipient ? ` ${recipient}` : ""}.`,
        },
      ],
      data: { accountName, bankCode, accountNumber },
    };
  },
};

export const payPersonSkill: SkillManifest = {
  id: "pay_person",
  name: "Send money to a person",
  description:
    "Send naira to a saved person's bank account (USDC off-ramp). Needs the " +
    "recipient's bank details saved first.",
  parameters: {
    type: "object",
    properties: {
      recipient: { type: "string" },
      amount: { type: "number", description: "Amount in NGN" },
    },
    required: ["recipient", "amount"],
  },
  origin: "baseline",
  async execute(params, _ctx: SkillContext): Promise<SkillOutcome> {
    // The Executor attaches the resolved entity as `<key>Entity`.
    const entity = params.recipientEntity as Entity | undefined;
    const name = entity?.canonicalName ?? String(params.recipient ?? "them");
    const bankCode = entity?.metadata.bankCode as string | undefined;
    const accountNumber = entity?.metadata.accountNumber as string | undefined;
    const amount = Number(params.amount);

    if (!entity || !bankCode || !accountNumber) {
      return {
        replies: [
          {
            kind: "text",
            text: `I don't have ${name}'s bank details yet. Save them first, then I can pay.`,
          },
        ],
        needsInput: true,
      };
    }
    if (!amount || amount <= 0) {
      return {
        replies: [{ kind: "text", text: `How much should I send to ${name}?` }],
        needsInput: true,
      };
    }

    const order = await callOnboarding("/offramp", {
      bankCode,
      accountNumber,
      fiatAmount: amount,
      description: `Axis transfer to ${name}`,
    });
    if (!order.ok) {
      return {
        replies: [{ kind: "text", text: `I couldn't start that transfer just now. Try again shortly.` }],
      };
    }
    return {
      replies: [
        {
          kind: "text",
          text: `Sending ₦${amount.toLocaleString()} to ${name}. I'll confirm here once it settles.`,
        },
      ],
      data: { orderId: order.data.id },
    };
  },
};
