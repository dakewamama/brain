/**
 * Planner eval dataset: real Axis messages -> the plan we expect. This is how we
 * catch classification regressions (the "i want a tape -> Jumia dump" / "food ->
 * Oraimo" class) with numbers instead of vibes, and how we compare models before
 * trusting one. No PII: every phone/amount here is fake.
 *
 * expectedSkill is the FIRST step's skill id, or null for "no skill" (a greeting,
 * small talk, or something we don't do yet -> empty plan -> menu). expectedParams
 * are param keys the planner must have extracted from the message.
 */
export interface EvalCase {
  input: string;
  expectedSkill: string | null;
  expectedParams?: string[];
  note?: string;
}

export const PLANNER_CASES: EvalCase[] = [
  // buy_airtime
  { input: "buy 500 airtime for 08031234567", expectedSkill: "buy_airtime", expectedParams: ["amount", "phone"] },
  { input: "buy 100 mtn airtime for 08051234567", expectedSkill: "buy_airtime", expectedParams: ["amount", "phone"] },
  { input: "top up 08021234567 with 200 naira", expectedSkill: "buy_airtime", expectedParams: ["amount", "phone"] },
  { input: "recharge my line 08091234567 500", expectedSkill: "buy_airtime", expectedParams: ["amount", "phone"] },

  // pay_person
  { input: "send 2000 to mum", expectedSkill: "pay_person", expectedParams: ["amount", "recipient"] },
  { input: "pay chinelo 5000", expectedSkill: "pay_person", expectedParams: ["amount", "recipient"] },
  { input: "transfer 1500 naira to my brother", expectedSkill: "pay_person", expectedParams: ["amount", "recipient"] },

  // save_address
  { input: "save my mum's gtbank account 0123456789", expectedSkill: "save_address", expectedParams: ["accountNumber"] },

  // no skill (social / unsupported) -> empty plan
  { input: "hi", expectedSkill: null, note: "greeting" },
  { input: "wagwan", expectedSkill: null, note: "greeting (pidgin)" },
  { input: "what can you do", expectedSkill: null, note: "help/social" },
  { input: "i want a tape", expectedSkill: null, note: "no shop skill exists; must NOT force a wrong skill" },
  { input: "who has fruits", expectedSkill: null, note: "no shop skill; must not misroute" },
];
