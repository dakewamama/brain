import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  GenerateResult,
  ModelMessage,
  ModelProvider,
  GenerateOptions,
} from "../src/model/types.js";
import { understand } from "../src/understanding/understand.js";
import { languages } from "../src/language/index.js";

function provider(
  fn: (messages: ModelMessage[], opts?: GenerateOptions) => Partial<GenerateResult>,
): ModelProvider {
  return {
    id: "fake",
    defaultModelId: "fake-1",
    async generate(messages, opts) {
      return {
        text: "",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 1,
        modelId: "fake-1",
        finishReason: "stop",
        ...fn(messages, opts),
      };
    },
  };
}

test("greeting → social intent with an in-language reply", async () => {
  const p = provider(() => ({
    json: {
      language: "pcm",
      confidence: 0.9,
      intent: "greet",
      reply: "How far! Wetin you wan chop?",
    },
  }));
  const u = await understand(p, "c1", "wagwan", languages);
  assert.ok(u);
  assert.equal(u.intent, "greet");
  assert.equal(u.language, "pcm");
  assert.equal(u.reply, "How far! Wetin you wan chop?");
});

test("order → transactional intent, entities kept, reply stripped", async () => {
  const p = provider(() => ({
    json: {
      language: "en",
      confidence: 0.8,
      intent: "order",
      vendor: "Nadia's Kitchen",
      item: "chicken wings",
      quantity: 2,
      // A model that wrongly tries to talk price here must not leak it:
      reply: "That's ₦1,000",
    },
  }));
  const u = await understand(p, "c2", "2 wings from nadia", languages);
  assert.ok(u);
  assert.equal(u.intent, "order");
  assert.equal(u.vendor, "Nadia's Kitchen");
  assert.equal(u.item, "chicken wings");
  assert.equal(u.quantity, 2);
  assert.equal(u.reply, undefined, "no model prose (or price) on transactional turns");
});

test("unknown/garbage intent value is coerced to 'unknown'", async () => {
  const p = provider(() => ({
    json: { language: "en", confidence: 0.5, intent: "banana" },
  }));
  const u = await understand(p, "c3", "???", languages);
  assert.ok(u);
  assert.equal(u.intent, "unknown");
});

test("unsupported detected language falls back", async () => {
  const p = provider(() => ({
    json: { language: "fr", confidence: 0.9, intent: "greet", reply: "salut" },
  }));
  const u = await understand(p, "c4", "bonjour", languages);
  assert.ok(u);
  assert.equal(u.language, languages.fallback);
});

test("model failure returns null (pipeline falls back to rules)", async () => {
  const p = provider(() => {
    throw new Error("boom");
  });
  const u = await understand(p, "c5", "hi", languages);
  assert.equal(u, null);
});
