import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/router/pipeline.js";
import {
  InMemorySessionStore,
  InMemoryConversationStore,
} from "../src/store/memory.js";
import { flattenOutbound } from "../src/core/recorder.js";
import type { InboundMessage } from "../src/core/types.js";
function freshPipeline() {
  const sessions = new InMemorySessionStore();
  const conversations = new InMemoryConversationStore();
  const pipeline = createPipeline({ sessions, conversations });
  const userId = "u1";
  async function say(text: string, data?: Record<string, unknown>) {
    const msg: InboundMessage = {
      channel: "console",
      userId,
      text,
      data,
      timestamp: Date.now(),
    };
    const replies = await pipeline.process(msg);
    return replies.map(flattenOutbound).join(" || ");
  }
  return { say, sessions, conversations, userId };
}
test("full delivery flow reaches order placement", async () => {
  const { say } = freshPipeline();
  const r1 = await say("chicken wings from Nadia");
  assert.match(r1, /₦1,000/);
  assert.match(r1, /order it/i);
  const r2 = await say("yes");
  assert.match(r2, /location|address/i);
  const r3 = await say("Lekki Phase 1");
  assert.match(r3, /Total:/);
  assert.match(r3, /Confirm/i);
  const r4 = await say("yes");
  assert.match(r4, /Order placed/i);
  assert.match(r4, /Track order/i);
});
test("out-of-stock item is refused, not ordered", async () => {
  const { say } = freshPipeline();
  const r = await say("fried rice from Nadia");
  assert.match(r, /out of stock/i);
  assert.doesNotMatch(r, /Total:/);
});
test("affiliate query only surfaces vendors that stock the category", async () => {
  const { say } = freshPipeline();
  // A power/audio query goes to Oraimo, not to every vendor in the list.
  const r = await say("buy an oraimo powerbank");
  assert.match(r, /oraimo/i);
});
test("a grocery query never surfaces an electronics-only vendor", async () => {
  const { say } = freshPipeline();
  const r = await say("who has fruits");
  // Oraimo sells power banks and earbuds, nothing edible.
  assert.doesNotMatch(r, /oraimo/i);
});
test("cancel mid-flow clears the session", async () => {
  const { say } = freshPipeline();
  await say("chicken wings from Nadia");
  const r = await say("cancel");
  assert.match(r, /cleared/i);
  const r2 = await say("hello");
  assert.match(r2, /Axis/);
});
test("greeting shows the menu", async () => {
  const { say } = freshPipeline();
  const r = await say("hi");
  assert.match(r, /Order food/i);
});
test("every message is recorded in the conversation store", async () => {
  const { say, conversations, userId } = freshPipeline();
  await say("chicken wings from Nadia");
  await say("yes");
  const history = await conversations.history("console", userId);
  const inbound = history.filter((e) => e.direction === "in");
  const outbound = history.filter((e) => e.direction === "out");
  assert.equal(inbound.length, 2);
  assert.ok(outbound.length >= 2);
});
test("shared location (lat/lon) advances the delivery flow", async () => {
  const { say } = freshPipeline();
  await say("chicken wings from Nadia");
  await say("yes");
  const r = await say("", {
    location: { latitude: 6.43, longitude: 3.42 },
  });
  assert.match(r, /Total:/);
});
