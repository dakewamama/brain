/**
 * Language service used by the pipeline: detect + apply the switching rule on
 * inbound, and localize outbound replies. Both degrade safely — if the model is
 * unavailable, the conversation stays on its current language rather than
 * crashing or dropping a reply.
 */
import type { OutboundMessage } from "../core/types.js";
import type { ModelProvider } from "../model/types.js";
import { isModelError } from "../model/errors.js";
import { childLogger } from "../core/logger.js";
import { resolveLanguage, type LanguageConfig } from "./index.js";
import { detectLanguage } from "./detect.js";
import { localizeStrings } from "./localize.js";

const log = childLogger("language");

export interface LanguageOutcome {
  language: string;
  switched: boolean;
}

/** Detect the inbound message's language and apply the switching rule. Logs the
 *  detection outcome + any switch with the conversation id. */
export async function applyInboundLanguage(
  provider: ModelProvider,
  conversationId: string,
  currentLanguage: string | undefined,
  text: string,
  langs: LanguageConfig,
): Promise<LanguageOutcome> {
  const detection = await detectLanguage(provider, conversationId, text, langs);
  const { language, switched } = resolveLanguage(currentLanguage, detection, {
    fallback: langs.fallback,
    minConfidence: langs.minConfidence,
  });
  log.info(
    {
      conversationId,
      detected: detection?.language ?? null,
      confidence: detection?.confidence ?? null,
      language,
      switched,
    },
    "language.detect",
  );
  return { language, switched };
}

// Every translatable string field of an OutboundMessage, in a stable order, with
// a way to rebuild the messages from the translated array.
function collect(replies: OutboundMessage[]): {
  strings: string[];
  rehydrate: (t: string[]) => OutboundMessage[];
} {
  const strings: string[] = [];
  const put = (s: string): number => strings.push(s) - 1;
  // Record each field's index so rehydrate can pull its translation back.
  const plan = replies.map((m) => {
    switch (m.kind) {
      case "text":
        return { kind: m.kind, text: put(m.text) } as const;
      case "location_request":
        return { kind: m.kind, text: put(m.text) } as const;
      case "link":
        return {
          kind: m.kind,
          text: put(m.text),
          label: m.label !== undefined ? put(m.label) : -1,
          url: m.url,
        } as const;
      case "buttons":
        return {
          kind: m.kind,
          text: put(m.text),
          buttons: m.buttons.map((b) => ({ id: b.id, title: put(b.title) })),
        } as const;
      case "list":
        return {
          kind: m.kind,
          text: put(m.text),
          header: m.header !== undefined ? put(m.header) : -1,
          sections: m.sections.map((s) => ({
            title: s.title !== undefined ? put(s.title) : -1,
            rows: s.rows.map((r) => ({
              id: r.id,
              title: put(r.title),
              description: r.description !== undefined ? put(r.description) : -1,
            })),
          })),
        } as const;
      case "products":
        // Localize only the intro line; product titles, prices, merchants and
        // URLs are real source data and must pass through byte-identical.
        return { kind: m.kind, text: put(m.text), products: m.products } as const;
    }
  });

  const rehydrate = (t: string[]): OutboundMessage[] => {
    const at = (i: number, fallback?: string) =>
      i === -1 ? fallback : (t[i] ?? fallback ?? "");
    return plan.map((p): OutboundMessage => {
      switch (p.kind) {
        case "text":
          return { kind: "text", text: t[p.text] };
        case "location_request":
          return { kind: "location_request", text: t[p.text] };
        case "link":
          return {
            kind: "link",
            text: t[p.text],
            url: p.url,
            ...(p.label === -1 ? {} : { label: t[p.label] }),
          };
        case "buttons":
          return {
            kind: "buttons",
            text: t[p.text],
            buttons: p.buttons.map((b) => ({ id: b.id, title: t[b.title] })),
          };
        case "list":
          return {
            kind: "list",
            text: t[p.text],
            ...(p.header === -1 ? {} : { header: at(p.header) }),
            sections: p.sections.map((s) => ({
              ...(s.title === -1 ? {} : { title: at(s.title) }),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: t[r.title],
                ...(r.description === -1 ? {} : { description: at(r.description) }),
              })),
            })),
          };
        case "products":
          return { kind: "products", text: t[p.text], products: p.products };
      }
    });
  };

  return { strings, rehydrate };
}

/** Localize replies into `language`. No-op when it equals the fallback (handler
 *  text is authored in the fallback language). Safe on model failure: returns the
 *  source-language replies rather than dropping them. */
export async function localizeReplies(
  provider: ModelProvider,
  conversationId: string,
  replies: OutboundMessage[],
  language: string,
  langs: LanguageConfig,
  protectedTerms: string[] = [],
): Promise<OutboundMessage[]> {
  if (language === langs.fallback) return replies;
  const targetName = langs.name(language) ?? language;
  const { strings, rehydrate } = collect(replies);
  if (strings.length === 0) return replies;
  try {
    const translated = await localizeStrings(
      provider,
      conversationId,
      strings,
      targetName,
      protectedTerms,
    );
    return rehydrate(translated);
  } catch (err) {
    log.warn(
      { conversationId, language, kind: isModelError(err) ? err.kind : "unknown" },
      "localization failed; replying in source language",
    );
    return replies;
  }
}
