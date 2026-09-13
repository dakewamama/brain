/**
 * Language configuration and the switching rule. The supported set comes from
 * config ("code:Name" pairs), so adding a language is an env change, not a code
 * change. Detection and localization use the model provider; nothing here uses a
 * separate language library (see PR notes for why: the model already handles
 * Nigerian English / Pidgin / code-switching, which off-the-shelf detectors
 * misclassify).
 *
 * SWITCHING RULE (documented, implemented in `resolveLanguage`):
 *   - The conversation has one language, stored on the session, not per message.
 *   - The first turn adopts the detected language only if confidence is high
 *     enough (>= LANGUAGE_SWITCH_MIN_CONFIDENCE); otherwise it stays on the
 *     fallback language.
 *   - Thereafter the language changes ONLY when a later message is detected as a
 *     DIFFERENT supported language at or above that confidence. A low-confidence
 *     or ambiguous message never flips it. A clear mid-conversation switch does.
 */
import { getConfig } from "../core/config.js";

export interface LanguageEntry {
  code: string;
  name: string;
}

export interface LanguageConfig {
  /** Whether model-backed language features run at all (needs a Gemini key).
   *  When false, the pipeline stays byte-for-byte on the fallback language. */
  enabled: boolean;
  fallback: string;
  minConfidence: number;
  list: LanguageEntry[];
  has(code: string): boolean;
  name(code: string): string | undefined;
}

function parse(spec: string): LanguageEntry[] {
  return spec
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      const code = (idx === -1 ? pair : pair.slice(0, idx)).trim();
      const name = (idx === -1 ? pair : pair.slice(idx + 1)).trim();
      return { code, name: name || code };
    });
}

function build(): LanguageConfig {
  const cfg = getConfig();
  const list = parse(cfg.SUPPORTED_LANGUAGES);
  const byCode = new Map(list.map((l) => [l.code, l.name]));
  // Ensure the fallback is always a member.
  if (!byCode.has(cfg.FALLBACK_LANGUAGE)) {
    list.unshift({ code: cfg.FALLBACK_LANGUAGE, name: cfg.FALLBACK_LANGUAGE });
    byCode.set(cfg.FALLBACK_LANGUAGE, cfg.FALLBACK_LANGUAGE);
  }
  return {
    enabled: Boolean(cfg.GEMINI_API_KEY) || Boolean(cfg.OPENAI_API_KEY),
    fallback: cfg.FALLBACK_LANGUAGE,
    minConfidence: cfg.LANGUAGE_SWITCH_MIN_CONFIDENCE,
    list,
    has: (code) => byCode.has(code),
    name: (code) => byCode.get(code),
  };
}

export const languages: LanguageConfig = build();

export interface Detection {
  language: string;
  confidence: number;
}

/** The switching rule. Pure and unit-tested. */
export function resolveLanguage(
  current: string | undefined,
  detection: Detection | null,
  cfg: { fallback: string; minConfidence: number },
): { language: string; switched: boolean } {
  const active = current ?? cfg.fallback;
  if (!detection) return { language: active, switched: false };
  if (detection.language === active) return { language: active, switched: false };
  if (detection.confidence >= cfg.minConfidence) {
    return { language: detection.language, switched: true };
  }
  return { language: active, switched: false };
}
