import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatProvider } from "../src/model/openai.js";
import { ModelSchemaError, ModelTransportError } from "../src/model/errors.js";
import type { JsonSchema } from "../src/model/types.js";

const base = {
  baseUrl: "https://example.test/v1",
  defaultModelId: "test-model",
  timeoutMs: 1000,
  maxRetries: 2,
  retryBaseMs: 1,
};

function completion(content: string, finish = "stop") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const SCHEMA: JsonSchema = {
  type: "object",
  properties: { intent: { type: "string" } },
  required: ["intent"],
};

test("missing key → typed, non-retryable transport error", async () => {
  const p = new OpenAICompatProvider({ ...base, apiKey: "" });
  await assert.rejects(
    () => p.generate([{ role: "user", content: "hi" }]),
    (e: unknown) => e instanceof ModelTransportError && !e.retryable,
  );
});

test("plain completion returns text + usage", async () => {
  const p = new OpenAICompatProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => completion("ok"),
  });
  const r = await p.generate([{ role: "user", content: "hi" }]);
  assert.equal(r.text, "ok");
  assert.equal(r.usage.inputTokens, 9);
});

test("429 is not retried", async () => {
  let calls = 0;
  const p = new OpenAICompatProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "rate" } }), {
        status: 429,
      });
    },
  });
  await assert.rejects(() => p.generate([{ role: "user", content: "hi" }]));
  assert.equal(calls, 1);
});

test("structured output (even fenced) parses and validates", async () => {
  const p = new OpenAICompatProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => completion('```json\n{"intent":"order"}\n```'),
  });
  const r = await p.generate([{ role: "user", content: "hi" }], {
    responseSchema: SCHEMA,
  });
  assert.deepEqual(r.json, { intent: "order" });
});

test("schema-violating JSON → schema error", async () => {
  const p = new OpenAICompatProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () => completion('{"nope":1}'),
  });
  await assert.rejects(
    () => p.generate([{ role: "user", content: "hi" }], { responseSchema: SCHEMA }),
    (e: unknown) => e instanceof ModelSchemaError,
  );
});

test("tool_calls map to provider-agnostic ToolInvocations (args parsed)", async () => {
  const p = new OpenAICompatProvider({
    ...base,
    apiKey: "k",
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    function: { name: "get_price", arguments: '{"sku":"A1"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const r = await p.generate([{ role: "user", content: "price?" }], {
    tools: [{ name: "get_price", description: "price", parameters: { type: "object" } }],
  });
  assert.equal(r.toolCalls[0].name, "get_price");
  assert.deepEqual(r.toolCalls[0].arguments, { sku: "A1" });
  assert.equal(r.toolCalls[0].id, "call_1");
  assert.equal(r.finishReason, "tool_calls");
});
