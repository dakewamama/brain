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
  flow?: FlowContext,
): Promise<Understanding | null> {
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
    },
    required: ["language", "confidence", "intent"],
    additionalProperties: false,
  };

  const codes = langs.list.map((l) => `${l.code} (${l.name})`).join(", ");
  const flowNote =
    flow && flow.step !== "idle"
      ? ` The user is mid-flow (${flow.vertical}, step "${flow.step}"); if the message answers that, keep the same intent.`
      : "";

  const system =
    `You are Axis, a warm, street-smart Nigerian chat concierge that helps ` +
    `people ORDER FOOD, SEND GIFTS, and SHOP online. Understand the user's ` +
    `message — Nigerian English, Pidgin, Yoruba, Hausa, Igbo, and code-switching ` +
    `are all normal, never "unsupported".${flowNote}\n\n` +
    `Return JSON with:\n` +
    `- language: one code from [${codes}] — the language of THIS message (judge ` +
    `how it's written, not the topic; names/prices are not language signals).\n` +
    `- confidence: 0..1 (low if too short/ambiguous).\n` +
    `- intent: one of ${INTENTS.join(", ")}.\n` +
    `- vendor, item, quantity: ONLY for order/gift/shop, extracted from the ` +
    `message; omit what isn't stated.\n` +
    `- reply: ONLY for greet/smalltalk/help/cancel/unknown — a SHORT, warm reply ` +
    `(1-2 sentences) in the user's OWN language, nudging them toward food, gifts ` +
    `or shopping. For order/gift/shop leave reply empty.\n\n` +
    `CRITICAL: never state or invent a price, fee, total, delivery time, or ` +
    `whether an item is in stock — the system provides those. Never put a number ` +
    `like that in reply. Keep it human and brief; no menus, no lists.`;

  try {
    const r = await instrumentedGenerate(
      provider,
      conversationId,
      "understand",
      [{ role: "user", content: text }],
      { system, responseSchema: schema, temperature: 0.3, maxOutputTokens: 512 },
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
    return {
      language,
      confidence,
      intent,
      vendor: str(j.vendor),
      item: str(j.item),
      quantity: typeof j.quantity === "number" ? j.quantity : undefined,
      // Only trust a reply for social intents (defends the no-number rule).
      reply: isSocial(intent) || intent === "cancel" ? str(j.reply) : undefined,
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
