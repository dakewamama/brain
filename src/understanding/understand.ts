/**
 * Model-owned comprehension. ONE Gemini call per inbound text turn returns:
 *   - the language of the message (folds detection in — no separate call),
 *   - the intent,
 *   - extracted entities (vendor/item/quantity) for transactional intents,
 *   - a short, warm reply IN THE USER'S LANGUAGE for social intents.
 *
 * HARD CONSTRAINT: the model must never state or invent a price, fee, total,
 * ETA, or stock status. For transactional intents it only extracts entities and
 * leaves `reply` empty — deterministic code + the catalog produce any number.
 * The prompt enforces this and we never surface `reply` for those intents.
 *
 * This replaces the keyword router when a model is configured; the keyword path
 * remains as a fallback for when it isn't (or a call fails).
 */
import type { JsonSchema, ModelProvider } from "../model/types.js";
import { instrumentedGenerate } from "../model/instrument.js";
import { isModelError } from "../model/errors.js";
import { childLogger } from "../core/logger.js";
import type { LanguageConfig } from "../language/index.js";

const log = childLogger("understanding");

export type Intent =
  | "greet"
  | "smalltalk"
  | "help"
  | "cancel"
  | "order"
  | "gift"
  | "shop"
  | "track"
  | "unknown";

const INTENTS: Intent[] = [
  "greet",
  "smalltalk",
  "help",
  "cancel",
  "order",
  "gift",
  "shop",
  "track",
  "unknown",
];

const SOCIAL: ReadonlySet<Intent> = new Set<Intent>([
  "greet",
  "smalltalk",
  "help",
  "unknown",
]);

export function isSocial(intent: Intent): boolean {
  return SOCIAL.has(intent);
}

export function isTransactional(intent: Intent): boolean {
  return intent === "order" || intent === "gift" || intent === "shop";
}

export interface Understanding {
  language: string;
  confidence: number;
  intent: Intent;
  vendor?: string;
  item?: string;
  quantity?: number;
  /** In-language reply for social intents only; empty for transactional. */
  reply?: string;
  /** 0-3 short, tappable next-action recommendations (social intents only), in
   *  the user's language, never containing a price. Rendered as quick-reply
   *  buttons; tapping one sends it back as a normal message. */
  suggestions?: string[];
  /** Only meaningful mid-flow: true if the message is the answer the assistant is
   *  currently waiting for; false if it's a question, digression, or new request. */
  answersFlow?: boolean;
}

interface FlowContext {
  vertical: string;
  step: string;
}

export async function understand(
  provider: ModelProvider,
  conversationId: string,
  text: string,
  langs: LanguageConfig,
  ctx: {
    flow?: FlowContext;
    userName?: string;
    firstTurn?: boolean;
    recent?: string;
  } = {},
): Promise<Understanding | null> {
  const { flow, userName, firstTurn, recent } = ctx;
  const schema: JsonSchema = {
    type: "object",
    properties: {
      language: { type: "string" },
      confidence: { type: "number" },
      intent: { type: "string" },
      vendor: { type: "string" },
      item: { type: "string" },
      quantity: { type: "number" },
      reply: { type: "string" },
      suggestions: { type: "array", items: { type: "string" } },
      answersFlow: { type: "boolean" },
    },
    required: ["language", "confidence", "intent"],
    additionalProperties: false,
  };

  const codes = langs.list.map((l) => `${l.code} (${l.name})`).join(", ");
  const midFlow = Boolean(flow && flow.step !== "idle");
  const flowNote = midFlow
    ? ` The user is mid-flow (${flow!.vertical}, step "${flow!.step}"). Set ` +
      `answersFlow=true ONLY if this message is the answer that step is waiting ` +
      `for; set it false if it's a question, a digression, or a new request. ` +
      `When answersFlow is false, still give a short helpful reply.`
    : "";
  const name = userName?.trim();
  const openingNote = firstTurn
    ? name
      ? ` This is the first message. Open by name, short, like "Hey ${name}, what can Axis do for you today?".`
      : ` This is the first message. Open short, like "Hey, what can Axis do for you today?".`
    : ` This is an ongoing chat: do NOT greet again or reintroduce yourself; do not repeat earlier lines; just answer and move it forward.`;
  const recentNote = recent
    ? ` For personalized recommendations, the user recently: ${recent}. Prefer suggestions that build on that.`
    : "";

  const system =
    `You are Axis: a warm, brief, street-smart Nigerian concierge for ordering ` +
    `food, sending gifts, and shopping online. Nigerian English, Pidgin, Yoruba, ` +
    `Hausa, Igbo and code-switching are all normal, never "unsupported".` +
    `${flowNote}${openingNote}\n\n` +
    `VOICE: a calm, premium concierge who has it handled, not a chirpy bot. Warm, ` +
    `confident, effortless. Keep social replies to ONE short sentence; lead with ` +
    `substance, not filler. Use the user's name naturally now and then, not every ` +
    `line. Anticipate the next step instead of asking them to repeat themselves. ` +
    `Never list the food/gift/shop options every time and never repeat an earlier ` +
    `line. NEVER use a dash of any kind (no "—", "–", or " - "); use commas or ` +
    `full stops.\n\n` +
    `Return JSON with:\n` +
    `- language: one code from [${codes}] (the language of THIS message; judge ` +
    `how it's written, not the topic; names/prices are not language signals).\n` +
    `- confidence: 0..1 (low if too short/ambiguous).\n` +
    `- intent: one of ${INTENTS.join(", ")}.\n` +
    `- vendor, item, quantity: ONLY for order/gift/shop, extracted from the ` +
    `message; omit what isn't stated.\n` +
    `- reply: ONLY for greet/smalltalk/help/cancel/unknown, following the VOICE ` +
    `rules, in the user's own language. For order/gift/shop leave reply empty.\n` +
    `- suggestions: ONLY for greet/smalltalk/help/unknown, 2 to 3 SHORT tappable ` +
    `next actions in the user's language (e.g. "Order jollof", "Send lunch to a ` +
    `friend", "Shop gadgets"), no prices. Omit for other intents.${recentNote}\n\n` +
    `CRITICAL: never state or invent a price, fee, total, delivery time, or ` +
    `whether an item is in stock; the system provides those. Never put such a ` +
    `number in reply or a suggestion.`;

  try {
    const r = await instrumentedGenerate(
      provider,
      conversationId,
      "understand",
      [{ role: "user", content: text }],
      // Headroom for reasoning models (e.g. gpt-oss) that spend tokens before
      // emitting the JSON.
      { system, responseSchema: schema, temperature: 0.3, maxOutputTokens: 768 },
    );
    const j = (r.json ?? {}) as Partial<Understanding> & { intent?: string };
    const intent = (INTENTS as string[]).includes(j.intent ?? "")
      ? (j.intent as Intent)
      : "unknown";
    const language =
      typeof j.language === "string" && langs.has(j.language)
        ? j.language
        : langs.fallback;
    const confidence = Math.max(0, Math.min(1, Number(j.confidence ?? 0)));
    const answersFlow = midFlow ? j.answersFlow === true : undefined;
    // Trust a reply for social intents, cancel, and mid-flow digressions — all
    // of which must still never contain an invented number (prompt enforces it).
    const wantReply =
      isSocial(intent) || intent === "cancel" || (midFlow && answersFlow === false);
    return {
      language,
      confidence,
      intent,
      vendor: str(j.vendor),
      item: str(j.item),
      quantity: typeof j.quantity === "number" ? j.quantity : undefined,
      reply: wantReply ? str(j.reply) : undefined,
      suggestions: isSocial(intent) ? cleanSuggestions(j.suggestions) : undefined,
      answersFlow,
    };
  } catch (err) {
    log.warn(
      { conversationId, kind: isModelError(err) ? err.kind : "unknown" },
      "understanding failed; falling back to rules",
    );
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function cleanSuggestions(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim().slice(0, 40))
    .slice(0, 3);
  return out.length ? out : undefined;
}
