import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/planner/planner.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { VerticalHandler } from "../src/handlers/types.js";
import type { HandlerResult } from "../src/core/types.js";
import type {
  GenerateResult,
  ModelMessage,
  ModelProvider,
  GenerateOptions,
} from "../src/model/types.js";

const stub: VerticalHandler = {
  vertical: "unknown",
  async start(): Promise<HandlerResult> {
    return { replies: [] };
  },
  async handle(): Promise<HandlerResult> {
    return { replies: [] };
  },
};

function registry(): SkillRegistry {
  const r = new SkillRegistry();
  for (const id of ["pay_person", "delivery"]) {
    r.register({
      id,
      name: id,
      description: `does ${id}`,
      parameters: { type: "object" },
      handler: stub,
    });
  }
  return r;
}

function provider(
  fn: (m: ModelMessage[], o?: GenerateOptions) => Partial<GenerateResult>,
): ModelProvider {
  return {
    id: "fake",
    defaultModelId: "fake",
    async generate(m, o) {
      return {
        text: "",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 1,
        modelId: "fake",
        finishReason: "stop",
        ...fn(m, o),
      };
    },
  };
}

test("decomposes a compound request into ordered steps", async () => {
  const p = provider(() => ({
    json: {
      steps: [
        { skill: "pay_person", params: { amount: 20000, recipient: "mum" }, dependsOn: [] },
        { skill: "delivery", params: { item: "jollof" }, dependsOn: [] },
      ],
    },
  }));
  const result = await plan(p, "c1", "send 20k to mum and order jollof", registry());
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].skill, "pay_person");
  assert.equal(result.steps[0].params.amount, 20000);
  assert.equal(result.steps[1].skill, "delivery");
});

test("drops steps that reference unknown skills", async () => {
  const p = provider(() => ({
    json: {
      steps: [
        { skill: "book_flight", params: {}, dependsOn: [] },
        { skill: "delivery", params: {}, dependsOn: [] },
      ],
    },
  }));
  const result = await plan(p, "c2", "book a flight and order food", registry());
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].skill, "delivery");
});

test("a greeting yields an empty plan", async () => {
  const p = provider(() => ({ json: { steps: [] } }));
  const result = await plan(p, "c3", "wagwan", registry());
  assert.deepEqual(result.steps, []);
});

test("model failure yields an empty plan (caller falls back)", async () => {
  const p = provider(() => {
    throw new Error("boom");
  });
  const result = await plan(p, "c4", "pay mum", registry());
  assert.deepEqual(result.steps, []);
});
