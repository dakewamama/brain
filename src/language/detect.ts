/**
 * Model-based language detection. Returns a supported language code + confidence,
 * or null if detection failed (caller then keeps the current language — never
 * crashes, never guesses). Detection judges the language of expression, not the
 * topic; numbers, names and prices are explicitly not signals.
 */
import type { JsonSchema, ModelProvider } from "../model/types.js";
import { instrumentedGenerate } from "../model/instrument.js";
import { isModelError } from "../model/errors.js";
import { childLogger } from "../core/logger.js";
import type { Detection, LanguageConfig } from "./index.js";

const log = childLogger("language");

export async function detectLanguage(
  provider: ModelProvider,
  conversationId: string,
  text: string,
  langs: LanguageConfig,
): Promise<Detection | null> {
  const codes = langs.list.map((l) => l.code);
  const schema: JsonSchema = {
    type: "object",
    properties: {
      language: { type: "string", enum: codes },
      confidence: { type: "number" },
    },
    required: ["language", "confidence"],
    additionalProperties: false,
  };

  const system =
    `You detect the language or variety of a short message for a Nigerian chat ` +
    `assistant. Choose EXACTLY one code from: ` +
    langs.list.map((l) => `${l.code} (${l.name})`).join(", ") +
    `. Nigerian English (en) and Nigerian Pidgin (pcm) are DISTINCT and both ` +
    `valid; never treat Pidgin or code-switched text as unsupported. Judge the ` +
    `language of expression, not the topic — numbers, prices, and proper names ` +
    `are NOT language signals. Return JSON {"language","confidence"} where ` +
    `confidence is 0..1 (low when the message is too short or ambiguous).`;

  try {
    const r = await instrumentedGenerate(
      provider,
      conversationId,
      "detect",
      [{ role: "user", content: text }],
      // Generous cap: newer "thinking" models spend tokens before emitting the
      // (tiny) JSON answer, so a small cap yields empty output.
      { system, responseSchema: schema, temperature: 0, maxOutputTokens: 512 },
    );
    const j = r.json as { language: string; confidence: number } | undefined;
    if (!j || !langs.has(j.language)) return null;
    const confidence = Math.max(0, Math.min(1, Number(j.confidence)));
    return { language: j.language, confidence };
  } catch (err) {
    log.warn(
      { conversationId, kind: isModelError(err) ? err.kind : "unknown" },
      "language detection failed",
    );
    return null;
  }
}
