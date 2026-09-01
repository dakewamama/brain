import type {
  InboundMessage,
  SessionState,
  HandlerResult,
} from "../core/types.js";
import type { VerticalHandler } from "./types.js";
import { affiliateProvider } from "../providers/index.js";
const STOPWORDS = [
  "buy",
  "get",
  "find",
  "me",
  "a",
  "an",
  "some",
  "please",
  "i",
  "want",
  "need",
];

export class AffiliateHandler implements VerticalHandler {
  readonly vertical = "affiliate" as const;
  async start(
    msg: InboundMessage,
    session: SessionState,
  ): Promise<HandlerResult> {
    return this.handle(msg, session);
  }
  async handle(
    msg: InboundMessage,
    _session: SessionState,
  ): Promise<HandlerResult> {
    const query = cleanQuery(msg.text);
    if (!query) {
      return {
        replies: [
          {
            kind: "text",
            text: 'What are you looking to buy? (e.g. "oraimo powerbank")',
          },
        ],
        sessionPatch: {
          vertical: "affiliate",
          step: "awaiting_query",
          context: {},
        },
      };
    }
    const products = await affiliateProvider.search(query);
    const replies: HandlerResult["replies"] = [
      { kind: "text", text: `Here's where to get "${query}":` },
    ];
    for (const p of products) {
      replies.push({
        kind: "link",
        text: p.title,
        url: p.url,
        label: p.merchant,
      });
    }
    return {
      replies,
      sessionPatch: { step: "idle", vertical: "unknown", context: {} },
    };
  }
}
function cleanQuery(text: string): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !STOPWORDS.includes(w))
    .join(" ")
    .trim();
}
