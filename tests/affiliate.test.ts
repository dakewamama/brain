import { test } from "node:test";
import assert from "node:assert/strict";
import { AffiliateHandler } from "../src/handlers/affiliate.js";
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
  return r.kind === "text" ? r.text : "";
}
type HandlerReply = { kind: string; text?: string };

test("a vague single item asks what kind instead of dumping links", async () => {
  const h = new AffiliateHandler();
  const out = await h.start(msg("I want a tape"), session());
  assert.match(textOf(out.replies[0] as HandlerReply), /what kind of tape/i);
  assert.equal(out.sessionPatch?.step, "awaiting_query");
  assert.equal((out.sessionPatch?.context as { category?: string })?.category, "tape");
});

test("answering 'what kind' searches the refined term", async () => {
  const h = new AffiliateHandler();
  const out = await h.handle(msg("masking"), session("awaiting_query", { category: "tape" }));
  assert.match(textOf(out.replies[0] as HandlerReply), /masking tape/);
  // followed by product links
  assert.ok(out.replies.slice(1).some((r) => (r as HandlerReply).kind === "link"));
});

test("'shop online' is treated as filler and asks what to buy", async () => {
  const h = new AffiliateHandler();
  const out = await h.start(msg("shop online"), session());
  assert.match(textOf(out.replies[0] as HandlerReply), /what are you looking to buy/i);
});

test("a specific multi-word item searches directly", async () => {
  const h = new AffiliateHandler();
  const out = await h.start(msg("buy an oraimo powerbank"), session());
  assert.match(textOf(out.replies[0] as HandlerReply), /oraimo powerbank/);
  assert.ok(out.replies.slice(1).some((r) => (r as HandlerReply).kind === "link"));
});
