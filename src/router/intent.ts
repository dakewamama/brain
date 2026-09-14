import type { InboundMessage, SessionState, Vertical } from "../core/types.js";

export type GlobalCommand = "cancel" | "menu" | "help" | "reset" | null;
export interface RouteDecision {
  vertical: Vertical;
  command: GlobalCommand;
  continued: boolean;
}
const CANCEL_WORDS = ["cancel", "stop", "abort", "quit"];
const MENU_WORDS = ["menu", "start", "home", "hi", "hello", "hey"];
const HELP_WORDS = ["help", "how", "what can you do"];
const RESET_WORDS = ["reset", "clear"];
const DELIVERY_WORDS = [
  "food",
  "order",
  "deliver",
  "delivery",
  "eat",
  "chicken",
  "rice",
  "jollof",
  "pizza",
  "burger",
  "send",
  "parcel",
  "package",
  "pickup",
  "pick up",
  "dispatch",
];
const GIFTING_WORDS = ["gift", "gifting", "surprise", "treat", "send lunch"];
const AFFILIATE_WORDS = [
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
  "gadget",
  "shop",
];
function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

export function detectCommand(text: string): GlobalCommand {
  const t = text.trim().toLowerCase();
  if (includesAny(t, RESET_WORDS)) return "reset";
  if (includesAny(t, CANCEL_WORDS)) return "cancel";
  if (HELP_WORDS.some((w) => t === w || t.startsWith(w))) return "help";
  if (MENU_WORDS.includes(t)) return "menu";
  return null;
}

const PURCHASE_WORDS = ["buy", "want", "need", "get me", "looking for", "order a"];

export function classifyFresh(text: string): Vertical {
  const t = text.toLowerCase();
  if (includesAny(t, GIFTING_WORDS)) return "gifting";
  if (includesAny(t, AFFILIATE_WORDS)) return "affiliate";
  if (includesAny(t, DELIVERY_WORDS)) return "delivery";
  // Fallback (used when the model is unavailable): a generic "buy/want/need X"
  // with no food or gift signal is a shopping request, not unknown — route to
  // affiliate, which asks what kind rather than dumping the menu.
  if (includesAny(t, PURCHASE_WORDS)) return "affiliate";
  return "unknown";
}

export function route(
  msg: InboundMessage,
  session: SessionState | null,
): RouteDecision {
  const command = detectCommand(msg.text);
  if (command === "cancel" || command === "reset") {
    return { vertical: "unknown", command, continued: false };
  }
  if (command === "menu" || command === "help") {
    return {
      vertical: session?.vertical ?? "unknown",
      command,
      continued: false,
    };
  }
  if (session && session.step !== "idle" && session.vertical !== "unknown") {
    return { vertical: session.vertical, command: null, continued: true };
  }
  return {
    vertical: classifyFresh(msg.text),
    command: null,
    continued: false,
  };
}
