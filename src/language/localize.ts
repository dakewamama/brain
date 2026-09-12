/**
 * Constraint-safe localization.
 *
 * The model must NEVER emit or alter a user-facing number, currency amount,
 * phone number, merchant name, or address. We guarantee this structurally, not
 * by instruction: those tokens are masked out to letter placeholders (⟦a⟧, ⟦b⟧…
 * — no digits, so they can't be re-matched) BEFORE the model sees the text, then
 * restored verbatim afterwards. The model only ever rephrases the connective
 * prose. If any placeholder fails to survive translation, that item falls back
 * to the original source string rather than risk a dropped/edited token.
 */
import type { JsonSchema, ModelProvider } from "../model/types.js";
import { instrumentedGenerate } from "../model/instrument.js";
import { ModelSchemaError } from "../model/errors.js";

interface Masked {
  masked: string;
  tokens: string[];
}

function toLetters(i: number): string {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const PATTERNS: RegExp[] = [
  /\b(?:https?:\/\/|www\.)\S+/gi, // urls
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, // emails
  /[₦$€£]\s?\d[\d,]*(?:\.\d+)?/g, // currency amounts
  /\+?\d[\d\s().-]{6,}\d/g, // phone-like sequences
  /\b\d[\d,]*(?:\.\d+)?\b/g, // any standalone number
];

/** Mask protected terms + numeric/contact tokens into ⟦letter⟧ placeholders. */
export function mask(text: string, protectedTerms: string[] = []): Masked {
  const tokens: string[] = [];
  const put = (m: string): string => {
    const i = tokens.length;
    tokens.push(m);
    return `⟦${toLetters(i)}⟧`;
  };
  let masked = text;
  // Explicit terms first (longest first so substrings don't pre-empt), exact match.
  for (const term of [...new Set(protectedTerms)]
    .filter((t) => t && t.length > 1)
    .sort((a, b) => b.length - a.length)) {
    if (masked.includes(term)) masked = masked.split(term).join(put(term));
  }
  for (const re of PATTERNS) masked = masked.replace(re, (m) => put(m));
  return { masked, tokens };
}

const PLACEHOLDER = /⟦([a-z]+)⟧/g;

function fromLetters(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 97 + 1);
  return n - 1;
}

/** Restore placeholders. Returns null if any placeholder is missing/unknown, so
 *  the caller can fall back to the source string (never emit a broken token). */
export function restore(translated: string, tokens: string[]): string | null {
  const seen = new Set<number>();
  let ok = true;
  const out = translated.replace(PLACEHOLDER, (_m, letters: string) => {
    const idx = fromLetters(letters);
    if (idx < 0 || idx >= tokens.length) {
      ok = false;
      return _m;
    }
    seen.add(idx);
    return tokens[idx];
  });
  if (!ok || seen.size !== tokens.length) return null;
  return out;
}

/**
 * Translate an array of strings into `targetName`, preserving placeholders. One
 * model call for the whole batch. Throws ModelSchemaError on a shape/count
 * mismatch (typed, no string-match fallback). Per-item, if a placeholder didn't
 * survive, that item keeps its original source string.
 */
export async function localizeStrings(
  provider: ModelProvider,
  conversationId: string,
  strings: string[],
  targetName: string,
  protectedTerms: string[] = [],
): Promise<string[]> {
  const masked = strings.map((s) => mask(s, protectedTerms));
  const schema: JsonSchema = {
    type: "object",
    properties: { translations: { type: "array", items: { type: "string" } } },
    required: ["translations"],
    additionalProperties: false,
  };
  const system =
    `Translate each string in input.items into ${targetName}, keeping a warm, ` +
    `concise tone for a Nigerian chat assistant. HARD RULES: keep every ⟦x⟧ ` +
    `placeholder exactly as-is and in a natural position; do NOT add, remove, or ` +
    `change any digits; keep emoji; translate nothing inside a placeholder. ` +
    `Return {"translations":[...]} with the SAME number of items, in order.`;
  const user = JSON.stringify({ items: masked.map((m) => m.masked) });

  const r = await instrumentedGenerate(
    provider,
    conversationId,
    "localize",
    [{ role: "user", content: user }],
    { system, responseSchema: schema, temperature: 0.2 },
  );
  const j = r.json as { translations?: unknown };
  const translations = j?.translations;
  if (!Array.isArray(translations) || translations.length !== strings.length) {
    throw new ModelSchemaError("translation count mismatch", {
      provider: provider.id,
      modelId: r.modelId,
    });
  }

  return translations.map((t, i) => {
    if (typeof t !== "string") return strings[i];
    const restored = restore(t, masked[i].tokens);
    return restored ?? strings[i];
  });
}
