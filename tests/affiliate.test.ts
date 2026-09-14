import { test } from "node:test";
import assert from "node:assert/strict";
import { AffiliateHandler } from "../src/handlers/affiliate.js";
import { resetConfigForTests } from "../src/core/config.js";
import type { InboundMessage, SessionState } from "../src/core/types.js";

function msg(text: string): InboundMessage {
  return { channel: "web", userId: "u", text, timestamp: Date.now() };
}
function session(step = "idle", context: Record<string, unknown> = {}): SessionState {
  return {
    channel: "web",
    userId: "u",
    vertical: "affiliate",
    step,
    context,
    savedLocations: [],
    updatedAt: Date.now(),
  };
}
function textOf(r: HandlerReply): string {
  return r.kind === "text" ? r.text ?? "" : "";
}
type HandlerReply = { kind: string; text?: string };

// Stub the Serper HTTP boundary with a real-shaped shopping response, capturing
// the outgoing query so we can prove what was searched. This is a network double,
// not fabricated product data shown to a user.
function withSerper(
  products: Array<{ title: string; price?: string; imageUrl?: string; link: string; source?: string }>,
  run: (captured: { body: unknown }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const realFetch = globalThis.fetch;
    const captured: { body: unknown } = { body: null };
    process.env.SERPER_API_KEY = "test-key";
    resetConfigForTests();
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      captured.body = init?.body ? JSON.parse(init.body) : null;
      return {
        ok: true,
        json: async () => ({ shopping: products }),
      } as Response;
    }) as typeof fetch;
    try {
      await run(captured);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SERPER_API_KEY;
      resetConfigForTests();
    }
  };
}

test("a vague single item asks what kind instead of searching", async () => {
  const h = new AffiliateHandler();
  const out = await h.start(msg("I want a tape"), session());
  assert.match(textOf(out.replies[0] as HandlerReply), /what kind of tape/i);
  assert.equal(out.sessionPatch?.step, "awaiting_query");
  assert.equal((out.sessionPatch?.context as { category?: string })?.category, "tape");
});

test(
  "answering 'what kind' refines the term and returns in-app products, never a link",
  withSerper(
    [{ title: "Masking Tape 2in", price: "₦1,200", imageUrl: "https://x/i.jpg", link: "https://x/p", source: "Jumia" }],
    async (captured) => {
      const h = new AffiliateHandler();
      const out = await h.handle(msg("masking"), session("awaiting_query", { category: "tape" }));
      // The refined term reached the live search.
      assert.match(JSON.stringify(captured.body), /masking tape/i);
      // Results are product cards shown in-app.
      assert.equal(out.replies[0].kind, "products");
      // No reply is ever a direct link.
      assert.ok(!out.replies.some((r) => r.kind === ("link" as string)));
    },
  ),
);

test("'shop online' is treated as filler and asks what to buy", async () => {
  const h = new AffiliateHandler();
  const out = await h.start(msg("shop online"), session());
  assert.match(textOf(out.replies[0] as HandlerReply), /what are you looking to buy/i);
});

test(
  "a specific multi-word item returns in-app products, never a link",
  withSerper(
    [{ title: "Oraimo 20000mAh Power Bank", price: "₦18,500", link: "https://x/pb", source: "Oraimo" }],
    async () => {
      const h = new AffiliateHandler();
      const out = await h.start(msg("buy an oraimo powerbank"), session());
      assert.equal(out.replies[0].kind, "products");
      assert.ok(!out.replies.some((r) => r.kind === ("link" as string)));
    },
  ),
);

test("with no search key configured, it never posts a link", async () => {
  const h = new AffiliateHandler();
  const out = await h.start(msg("buy an oraimo powerbank"), session());
  assert.ok(!out.replies.some((r) => r.kind === ("link" as string)));
  assert.equal(out.replies[0].kind, "text");
});
