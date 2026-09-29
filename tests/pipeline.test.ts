import { test } from "node:test";
import assert from "node:assert/strict";
import { createPipeline } from "../src/router/pipeline.js";
import {
  InMemorySessionStore,
  InMemoryConversationStore,
} from "../src/store/memory.js";
import { flattenOutbound } from "../src/core/recorder.js";
import { configureCasesForTests } from "../src/cases/index.js";
import type { InboundMessage } from "../src/core/types.js";

function freshPipeline() {
  const sessions = new InMemorySessionStore();
  const conversations = new InMemoryConversationStore();
  const pipeline = createPipeline({ sessions, conversations });
  const userId = "u1";
  async function say(text: string, data?: Record<string, unknown>, messageId?: string) {
    const msg: InboundMessage = {
      channel: "console",
      userId,
      text,
      data,
      messageId,
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
  assert.match(r, /airtime/i);
});

test("axis never emits a direct link", async () => {
  const { say } = freshPipeline();
  const r = await say("buy an oraimo powerbank");
  assert.doesNotMatch(r, /https?:\/\//);
});

test("airtime is multi-turn: asks for the network, then resumes on the answer", async () => {
  // The completed slots start a real Case; the mock balance says insufficient,
  // which proves the message traveled the whole runtime path and back.
  configureCasesForTests({
    purchase: { capability: "telecom.airtime", provider: "test", mode: "MOCK", execute: async () => ({ ok: true, outcome: "ok", response: { providerStatus: "delivered" } }) },
    getBalance: async () => ({ ok: true, ngn: 0, usdc: 0, address: "TestAddr123" }),
  });
  const { say } = freshPipeline();
  // 0801 isn't an inferable prefix and no network stated -> it must ask.
  const r1 = await say("buy 200 airtime for 08012345678");
  assert.match(r1, /which network/i);
  // The follow-up answer resumes the pending request (reaches the airtime
  // playbook, which reports the empty balance — proving it got there, not the
  // generic greeting).
  const r2 = await say("MTN");
  assert.doesNotMatch(r2, /transfers and bills are coming/i); // not the fallback
  assert.match(r2, /balance/i);
});

test("a replayed webhook message id is processed once, not twice", async () => {
  configureCasesForTests({
    purchase: { capability: "telecom.airtime", provider: "test", mode: "MOCK", execute: async () => ({ ok: true, outcome: "ok", response: { providerStatus: "delivered" } }) },
    getBalance: async () => ({ ok: false, ngn: null, usdc: 0 }),
  });
  const { say } = freshPipeline();
  const first = await say("buy 200 airtime for 08012345678", undefined, "wamid.test-1");
  assert.match(first, /which network/i);
  const replay = await say("buy 200 airtime for 08012345678", undefined, "wamid.test-1");
  assert.equal(replay, "", "duplicate inbound is dropped");
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
