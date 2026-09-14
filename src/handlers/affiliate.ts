import type {
  InboundMessage,
  SessionState,
  HandlerResult,
} from "../core/types.js";
import type { VerticalHandler } from "./types.js";
import { affiliateProvider } from "../providers/index.js";
import { browse } from "../browse/serper.js";

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
  "to",
  // shop-intent filler, so "shop online" doesn't become a search for "shop online"
  "shop",
  "shopping",
  "online",
  "store",
  "order",
];

interface ShopContext {
  category?: string;
}

export class AffiliateHandler implements VerticalHandler {
  readonly vertical = "affiliate" as const;

  async start(msg: InboundMessage, session: SessionState): Promise<HandlerResult> {
    return this.handle(msg, session);
  }

  async handle(msg: InboundMessage, session: SessionState): Promise<HandlerResult> {
    const ctx = (session.context ?? {}) as ShopContext;

    // Answering an earlier "what kind?" — combine with the category and search.
    if (session.step === "awaiting_query") {
      const answer = cleanQuery(msg.text);
      if (!answer) return this.askWhat();
      const refined =
        ctx.category && !answer.includes(ctx.category)
          ? `${answer} ${ctx.category}`
          : answer;
      return this.search(refined);
    }

    const query = cleanQuery(msg.text);
    if (!query) return this.askWhat();
    // A bare single-word item ("tape", "shoes") is too vague to shop well — ask
    // what kind before dumping results.
    if (isVague(query)) return this.askKind(query);
    return this.search(query);
  }

  private askWhat(): HandlerResult {
    return {
      replies: [
        { kind: "text", text: 'What are you looking to buy? (e.g. "oraimo powerbank")' },
      ],
      sessionPatch: { vertical: "affiliate", step: "awaiting_query", context: {} },
    };
  }

  private askKind(query: string): HandlerResult {
    return {
      replies: [
        {
          kind: "text",
          text: `Sure, what kind of ${query} are you after? A brand or specific type helps.`,
        },
      ],
      sessionPatch: {
        vertical: "affiliate",
        step: "awaiting_query",
        context: { category: query },
      },
    };
  }

  private async search(query: string): Promise<HandlerResult> {
    const done = { step: "idle" as const, vertical: "unknown" as const, context: {} };

    // Live browse: real products with picture and price, when configured.
    const found = await browse(query);
    if (found && found.length > 0) {
      return {
        replies: [
          {
            kind: "products",
            text: `Here's what I found for "${query}":`,
            products: found,
          },
        ],
        sessionPatch: done,
      };
    }

    // Fallback: category-filtered vendor search links.
    const products = await affiliateProvider.search(query);
    const replies: HandlerResult["replies"] = [
      { kind: "text", text: `Here's where to get "${query}":` },
    ];
    for (const p of products) {
      replies.push({ kind: "link", text: p.title, url: p.url, label: p.merchant });
    }
    return { replies, sessionPatch: done };
  }
}

function cleanQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.includes(w))
    .join(" ")
    .trim();
}

function isVague(query: string): boolean {
  return query.split(/\s+/).length === 1;
}
