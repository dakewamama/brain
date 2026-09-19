/**
 * buy_airtime — the first real-money vertical (Brief §6). ATOMIC + DETERMINISTIC:
 * the planner extracts the amount/phone/network the user stated, the Executor
 * runs this, and it calls the onboarding service's authenticated /airtime rail
 * (which holds the VTpass key and, later, debits the balance + books the remnant
 * as pool gain). No number is invented by a model — the amount is the user's.
 */
import type { SkillManifest, SkillOutcome, SkillContext } from "./registry.js";
import { callOnboarding } from "./payments.js";

/** Strip formatting; accept +234/234 and normalise to local 0-prefixed form. */
export function normalizePhone(raw: string): string {
  let p = raw.replace(/[^\d+]/g, "");
  if (p.startsWith("+234")) p = "0" + p.slice(4);
  else if (p.startsWith("234")) p = "0" + p.slice(3);
  return p;
}

export function validNigerianPhone(p: string): boolean {
  return /^0\d{10}$/.test(p);
}

// Best-effort network from the number's prefix (deterministic, not model-guessed).
// Number porting means this is a convenience, not a guarantee; an explicitly
// stated network always wins.
const PREFIXES: Record<string, string> = {};
for (const p of ["0803", "0806", "0703", "0706", "0813", "0816", "0810", "0814", "0903", "0906", "0913", "0916"]) PREFIXES[p] = "mtn";
for (const p of ["0805", "0807", "0705", "0815", "0811", "0905", "0915"]) PREFIXES[p] = "glo";
for (const p of ["0802", "0808", "0708", "0812", "0701", "0901", "0902", "0904", "0907", "0912"]) PREFIXES[p] = "airtel";
for (const p of ["0809", "0818", "0817", "0909", "0908"]) PREFIXES[p] = "9mobile";

export function networkFromPhone(phone: string): string | null {
  return PREFIXES[phone.slice(0, 4)] ?? null;
}

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
    let network =
      typeof params.network === "string" ? params.network.trim().toLowerCase() : "";

    if (!phone) return needs("What number should I top up?");
    if (!validNigerianPhone(phone))
      return needs("That doesn't look like a Nigerian number. Send it like 08012345678.");
    if (!amount || amount <= 0) return needs("How much airtime should I buy?");
    if (amount < 50) return needs("The minimum airtime is ₦50.");
    if (amount > 50000) return needs("The most I can send in one go is ₦50,000.");
    if (!network) network = networkFromPhone(phone) ?? "";
    if (!network)
      return needs("Which network is that number on — MTN, Glo, Airtel or 9mobile?");

    // owner = the user's balance key (custodial); idempotencyKey guards this
    // single onboarding call from a double-submit. A fresh key per attempt is
    // correct — buying again is a new purchase.
    const owner = ctx.userId;

    // The user's wallet is created at auth; this is a safety ensure (idempotent).
    // It returns the deposit address we show if the balance can't cover the buy.
    const prov = await callOnboarding("/wallet", { userId: owner });
    const address =
      typeof prov.data.address === "string" ? prov.data.address : undefined;

    const idempotencyKey = `airtime-${owner}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await callOnboarding("/airtime", {
      owner,
      network,
      amount,
      phone,
      idempotencyKey,
    });
    // Empty balance: tell them exactly where to add funds.
    if (res.status === 402) {
      return {
        replies: [
          {
            kind: "text",
            text: address
              ? `You don't have enough balance yet. Add USDC to your Axis wallet to top up:\n${address}`
              : "You don't have enough balance yet. Add funds to your Axis wallet first.",
          },
        ],
        needsInput: true,
      };
    }
    if (!res.ok) {
      return {
        replies: [
          { kind: "text", text: "I couldn't buy that airtime just now. Please try again shortly." },
        ],
      };
    }
    // 200 = delivered, 202 = accepted/pending.
    const delivered = res.status === 200 || res.data.status === "delivered";
    const net = network.toUpperCase();
    return {
      replies: [
        {
          kind: "text",
          text: delivered
            ? `Done. ₦${amount.toLocaleString()} ${net} airtime sent to ${phone}.`
            : `Your ₦${amount.toLocaleString()} ${net} airtime to ${phone} is processing. I'll confirm once it lands.`,
        },
      ],
      data: { status: res.data.status, phone, amount, network },
    };
  },
};
