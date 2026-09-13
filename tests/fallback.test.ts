import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackProvider } from "../src/model/fallback.js";
import {
  ModelTransportError,
  ModelSchemaError,
} from "../src/model/errors.js";
import type {
  GenerateResult,
  ModelMessage,
  ModelProvider,
} from "../src/model/types.js";

function ok(id: string, text: string): ModelProvider {
  return {
    id,
    defaultModelId: id,
    async generate(): Promise<GenerateResult> {
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 1,
        modelId: id,
        finishReason: "stop",
      };
    },
  };
}

function fails(id: string, err: unknown): ModelProvider {
  return {
    id,
    defaultModelId: id,
    async generate(): Promise<GenerateResult> {
      throw err;
    },
  };
}

const msgs: ModelMessage[] = [{ role: "user", content: "hi" }];

test("falls over to the next provider on a transport (429) failure", async () => {
  const primary = fails(
    "groq",
    new ModelTransportError("429", { provider: "groq", modelId: "m", status: 429 }),
  );
  const backup = ok("gemini", "from backup");
  const fb = new FallbackProvider([primary, backup]);
  const r = await fb.generate(msgs);
  assert.equal(r.text, "from backup");
  assert.equal(r.modelId, "gemini");
});

test("uses the primary when it succeeds (no failover)", async () => {
  const fb = new FallbackProvider([ok("groq", "primary"), ok("gemini", "backup")]);
  const r = await fb.generate(msgs);
  assert.equal(r.text, "primary");
});

test("does NOT fail over on a deterministic (schema) error", async () => {
  const primary = fails(
    "groq",
    new ModelSchemaError("bad json", { provider: "groq", modelId: "m" }),
  );
  const backup = ok("gemini", "backup");
  const fb = new FallbackProvider([primary, backup]);
  await assert.rejects(() => fb.generate(msgs), (e) => e instanceof ModelSchemaError);
});

test("rethrows the last error when all providers are down", async () => {
  const e1 = new ModelTransportError("a", { provider: "groq", modelId: "m", status: 500 });
  const e2 = new ModelTransportError("b", { provider: "gemini", modelId: "m", status: 503 });
  const fb = new FallbackProvider([fails("groq", e1), fails("gemini", e2)]);
  await assert.rejects(() => fb.generate(msgs), (e) => e === e2);
});
