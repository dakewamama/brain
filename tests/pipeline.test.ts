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

// With no model configured in tests, the planner returns an empty plan, so every
// turn falls to the menu. That is the single decision path: plan -> execute, else
// menu. (Skill execution with a real model is covered in executor/planner tests.)
test("a turn with no actionable plan falls to the menu", async () => {
  const { say } = freshPipeline();
  const r = await say("hi");
  assert.match(r, /Axis/);
});

test("axis never emits a direct link", async () => {
  const { say } = freshPipeline();
  const r = await say("buy an oraimo powerbank");
  assert.doesNotMatch(r, /https?:\/\//);
});

test("every message is recorded in the conversation store", async () => {
  const { say, conversations, userId } = freshPipeline();
  await say("hello");
  await say("what can you do");
  const history = await conversations.history("console", userId);
  const inbound = history.filter((e) => e.direction === "in");
  const outbound = history.filter((e) => e.direction === "out");
  assert.equal(inbound.length, 2);
  assert.ok(outbound.length >= 2);
});
