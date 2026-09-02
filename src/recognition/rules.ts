import type {
  Recognizer,
  RecognizedIntent,
  RecognizeInput,
  IntentAction,
} from "./types.js";
import type { Vertical } from "../core/types.js";
import { findVendor, findItem, listVendors } from "../handlers/catalog.js";
const GREET = [
  "hi",
  "hello",
  "hey",
  "menu",
  "start",
  "home",
  "good morning",
  "good evening",
];
const CANCEL = ["cancel", "stop", "abort", "quit"];
const HELP = ["help", "how does this work", "what can you do"];
const TRACK = ["track", "where is my", "where's my", "status of my order"];
const GIFT = ["gift", "send lunch", "send food to", "surprise", "treat"];
const SHOP = [
  "buy",
  "phone",
  "powerbank",
  "power bank",
  "earbuds",
  "charger",
  "oraimo",
  "jumia",
  "konga",
  "laptop",
];
const ORDER = [
  "order",
  "deliver",
  "food",
  "eat",
  "hungry",
  "chicken",
  "rice",
  "jollof",
  "shawarma",
  "amala",
  "want",
  "get me",
  "send me",
];
function has(t: string, arr: string[]): boolean {
  return arr.some((w) => t.includes(w));
}
function actionToVertical(action: IntentAction): Vertical {
  switch (action) {
    case "order":
      return "delivery";
    case "gift":
      return "gifting";
    case "shop":
      return "affiliate";
    default:
      return "unknown";
  }
}
function extractQuantity(t: string): number | undefined {
  const digit = t.match(/\b(\d{1,2})\b/);
  if (digit) return Number(digit[1]);
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
  };
  for (const [w, n] of Object.entries(words)) {
    if (new RegExp(`\\b${w}\\b`).test(t)) return n;
  }
  return undefined;
}

export class RuleRecognizer implements Recognizer {
  readonly name = "rules";
  readonly live = false;
  async recognize(input: RecognizeInput): Promise<RecognizedIntent> {
    const t = input.text.trim().toLowerCase();
    if (t.length === 0) {
      return this.low(
        "unknown",
        0.0,
        "Sorry, I didn't catch that. What would you like?",
      );
    }
    if (has(t, CANCEL)) {
      return this.high("cancel", 0.97);
    }
    if (HELP.some((w) => t === w || t.startsWith(w))) {
      return this.high("help", 0.9);
    }
    if (GREET.includes(t)) {
      return this.high("greet", 0.95);
    }
    if (has(t, TRACK)) {
      return this.high("track", 0.8);
    }
    const quantity = extractQuantity(t);
    const vendor = findVendor(t);
    const item = vendor ? findItem(vendor, t) : null;
    if (has(t, GIFT)) {
      return {
        action: "gift",
        vertical: "gifting",
        vendor: vendor?.name,
        item: item?.name,
        quantity: item ? (quantity ?? 1) : undefined,
        confidence: 0.7,
        clarificationNeeded: false,
        source: "rules",
      };
    }
    if (has(t, SHOP)) {
      return {
        action: "shop",
        vertical: "affiliate",
        confidence: 0.72,
        clarificationNeeded: false,
        source: "rules",
      };
    }
    const looksLikeOrder = has(t, ORDER) || vendor !== null;
    if (looksLikeOrder) {
      let confidence = 0.5;
      if (vendor) confidence += 0.25;
      if (item) confidence += 0.2;
      confidence = Math.min(confidence, 0.97);
      const clarificationNeeded = confidence < 0.55;
      return {
        action: "order",
        vertical: "delivery",
        vendor: vendor?.name,
        item: item?.name,
        quantity: item ? (quantity ?? 1) : undefined,
        confidence,
        clarificationNeeded,
        clarificationPrompt: clarificationNeeded
          ? this.orderClarifier(vendor?.name, item?.name)
          : undefined,
        source: "rules",
      };
    }
    return this.low(
      "unknown",
      0.2,
      "I can help you order food, send a gift, or shop. What would you like?",
    );
  }
  private orderClarifier(vendor?: string, item?: string): string {
    if (vendor && !item) return `What would you like from ${vendor}?`;
    if (!vendor && item) {
      const names = listVendors()
        .map((v) => v.name)
        .join(", ");
      return `Which vendor for the ${item}? We have ${names}.`;
    }
    return 'What would you like, and from where? (e.g. "chicken wings from Nadia")';
  }
  private high(action: IntentAction, confidence: number): RecognizedIntent {
    return {
      action,
      vertical: actionToVertical(action),
      confidence,
      clarificationNeeded: false,
      source: "rules",
    };
  }
  private low(
    action: IntentAction,
    confidence: number,
    prompt: string,
  ): RecognizedIntent {
    return {
      action,
      vertical: actionToVertical(action),
      confidence,
      clarificationNeeded: true,
      clarificationPrompt: prompt,
      source: "rules",
    };
  }
}
