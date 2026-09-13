import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiProvider } from "../src/model/gemini.js";
import {
  ModelSchemaError,
  ModelTimeoutError,
  ModelTransportError,
} from "../src/model/errors.js";
import type { JsonSchema } from "../src/model/types.js";

const base = {
  defaultModelId: "gemini-test",
  timeoutMs: 1000,
  maxRetries: 2,
  retryBaseMs: 1,
};

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textCandidate(text: string, finishReason = "STOP") {
  return {
    candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason }],
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 7,
      totalTokenCount: 18,
    },
  };
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: { intent: { type: "string" } },
  required: ["intent"],
  additionalProperties: false,
};

test("missing API key produces a typed, non-retryable transport error", async () => {
  let calls = 0;
  const p = new GeminiProvider({
    ...base,
    apiKey: "",
    fetchFn: async () => {
      calls++;
      return jsonResponse(textCandidate("hi"));
    },
  });
  await assert.rejects(
    () => p.generate([{ role: "user", content: "hi" }]),
    (err: unknown) => {
      assert.ok(err instanceof ModelTransportError);
      assert.equal(err.kind, "transport");
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 0, "must not hit the network without a key");
});

test("a bad-key HTTP error never leaks the key and is not retried", async () => {
  const KEY = "super-secret-key-value";
  let calls = 0;
  const p = new GeminiProvider({
    ...base,
    apiKey: KEY,
    fetchFn: async () => {
      calls++;
      return jsonResponse({ error: { message: "API key not valid" } }, 403);
    },
  });
  await assert.rejects(
    () => p.generate([{ role: "user", content: "hi" }]),
    (err: unknown) => {
      assert.ok(err instanceof ModelTransportError);
      assert.equal(err.status, 403);
      assert.equal(err.retryable, false);
      assert.ok(!String(err.message).includes(KEY), "key must not appear in error");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("retries on 5xx then succeeds", async () => {
  let calls = 0;
  const p = new GeminiProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => {
      calls++;
      if (calls < 3) return jsonResponse({ error: { message: "upstream" } }, 503);
      return jsonResponse(textCandidate("ok"));
    },
  });
  const r = await p.generate([{ role: "user", content: "hi" }]);
  assert.equal(r.text, "ok");
  assert.equal(calls, 3, "two retries then success");
  assert.equal(r.usage.inputTokens, 11);
  assert.equal(r.usage.outputTokens, 7);
});

test("malformed JSON with a responseSchema is a schema error, not a fallback", async () => {
  const p = new GeminiProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => jsonResponse(textCandidate("this is not json")),
  });
  await assert.rejects(
    () => p.generate([{ role: "user", content: "hi" }], { responseSchema: SCHEMA }),
    (err: unknown) => {
      assert.ok(err instanceof ModelSchemaError);
      assert.equal(err.kind, "schema_validation");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("JSON that violates the schema is a schema error", async () => {
  const p = new GeminiProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => jsonResponse(textCandidate('{"wrong":1}')),
  });
  await assert.rejects(
    () => p.generate([{ role: "user", content: "hi" }], { responseSchema: SCHEMA }),
    (err: unknown) => err instanceof ModelSchemaError,
  );
});

test("valid structured output parses and validates", async () => {
  const p = new GeminiProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => jsonResponse(textCandidate('{"intent":"order"}')),
  });
  const r = await p.generate([{ role: "user", content: "hi" }], {
    responseSchema: SCHEMA,
  });
  assert.deepEqual(r.json, { intent: "order" });
});

test("structured output wrapped in markdown fences is still parsed", async () => {
  const p = new GeminiProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () =>
      jsonResponse(textCandidate('```json\n{"intent":"order"}\n```')),
  });
  const r = await p.generate([{ role: "user", content: "hi" }], {
    responseSchema: SCHEMA,
  });
  assert.deepEqual(r.json, { intent: "order" });
});

test("a functionCall maps to a provider-agnostic ToolInvocation", async () => {
  const p = new GeminiProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "get_price", args: { sku: "A1" } } }],
              role: "model",
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
      }),
  });
  const r = await p.generate([{ role: "user", content: "price?" }], {
    tools: [
      { name: "get_price", description: "look up a price", parameters: { type: "object" } },
    ],
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "get_price");
  assert.deepEqual(r.toolCalls[0].arguments, { sku: "A1" });
  assert.equal(r.toolCalls[0].id, undefined, "Gemini supplies no tool-call id");
  assert.equal(r.finishReason, "tool_calls");
});

test("a timeout produces a typed timeout error", async () => {
  const p = new GeminiProvider({
    ...base,
    apiKey: "k",
    timeoutMs: 20,
    maxRetries: 0,
    fetchFn: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  });
  await assert.rejects(
    () => p.generate([{ role: "user", content: "hi" }]),
    (err: unknown) => {
      assert.ok(err instanceof ModelTimeoutError);
      assert.equal(err.kind, "timeout");
      return true;
    },
  );
});
