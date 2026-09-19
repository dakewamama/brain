import {
  normalizePhone,
  validNigerianPhone,
  networkFromPhone,
} from "../skills/airtime.js";

/**
 * Deterministic airtime intent detection + slot memory. Airtime is the one live
 * vertical, so it must not depend on LLM variance (the model intermittently
 * returned an empty plan for clear airtime requests). This parses the slots
 * directly, remembers a partial request across turns (so "MTN" answers "which
 * network?"), and only hands complete requests to the buy_airtime skill.
 */
export interface AirtimeSlots {
  amount?: number;
  phone?: string;
  network?: string;
}

const NETWORKS: Record<string, string> = {
  mtn: "mtn",
  glo: "glo",
  airtel: "airtel",
  "9mobile": "9mobile",
  etisalat: "9mobile",
};

/** True when a message is unambiguously about airtime (keyword present). */
export function looksLikeAirtime(text: string): boolean {
  return /\bairtime\b|\btop\s?-?\s?up\b|\brecharge\b/i.test(text);
}

/** True when a message asks about wallet balance. */
export function looksLikeBalance(text: string): boolean {
  return /\bbalance\b|how much (do i|have i|money)|what.*\bhave\b.*\bwallet\b|my wallet/i.test(
    text,
  );
}

/** Extract whatever airtime slots the message states. */
export function parseAirtime(text: string): AirtimeSlots {
  const slots: AirtimeSlots = {};
  const lower = text.toLowerCase();

  for (const key of Object.keys(NETWORKS)) {
    if (new RegExp(`\\b${key}\\b`).test(lower)) {
      slots.network = NETWORKS[key];
      break;
    }
  }

  const phoneMatch = text.match(/(\+?234|0)\d{9,10}/);
  if (phoneMatch) {
    const p = normalizePhone(phoneMatch[0]);
    if (validNigerianPhone(p)) slots.phone = p;
  }

  // Amount: a number that isn't the phone. Strip the phone first.
  const withoutPhone = text.replace(/(\+?234|0)\d{9,10}/g, " ");
  const amtMatch = withoutPhone.match(/₦?\s*(\d[\d,]*)/);
  if (amtMatch) {
    const a = Number(amtMatch[1].replace(/,/g, ""));
    if (a > 0) slots.amount = a;
  }
  return slots;
}

export function hasAnySlot(s: AirtimeSlots): boolean {
  return s.amount != null || s.phone != null || s.network != null;
}

/** Merge new slots over a pending partial, inferring network from the phone. */
export function mergeSlots(pending: AirtimeSlots, parsed: AirtimeSlots): AirtimeSlots {
  const merged: AirtimeSlots = { ...pending, ...parsed };
  if (!merged.network && merged.phone) {
    const inferred = networkFromPhone(merged.phone);
    if (inferred) merged.network = inferred;
  }
  return merged;
}

/** The first slot still needed, or null when the request is complete. */
export function missingSlot(s: AirtimeSlots): "amount" | "phone" | "network" | null {
  if (s.amount == null) return "amount";
  if (!s.phone) return "phone";
  if (!s.network) return "network";
  return null;
}

export function slotPrompt(missing: "amount" | "phone" | "network"): string {
  switch (missing) {
    case "amount":
      return "How much airtime should I buy?";
    case "phone":
      return "What number should I top up?";
    case "network":
      return "Which network is that number on — MTN, Glo, Airtel or 9mobile?";
  }
}
