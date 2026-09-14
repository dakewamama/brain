import { test } from "node:test";
import assert from "node:assert/strict";
import { Executor } from "../src/executor/executor.js";
import { SkillRegistry, type SkillOutcome } from "../src/skills/registry.js";
import { InMemoryMemory } from "../src/memory/service.js";
import type { Plan } from "../src/planner/planner.js";
import type { VerticalHandler } from "../src/handlers/types.js";
import type { HandlerResult } from "../src/core/types.js";

function registry(): SkillRegistry {
  const r = new SkillRegistry();
  r.register({
    id: "get_rates",
    name: "rates",
    description: "get rate",
    parameters: { type: "object" },
    async execute(): Promise<SkillOutcome> {
      return { replies: [{ kind: "text", text: "rate is set" }], data: { rate: 1650 } };
    },
  });
  r.register({
    id: "pay_person",
    name: "pay",
    description: "pay a person",
    parameters: { type: "object" },
    async execute(params, ctx): Promise<SkillOutcome> {
      const entity = params.recipientEntity as { canonicalName?: string } | undefined;
      const rate = (ctx.priorResults[0] as { rate?: number } | undefined)?.rate;
      return {
        replies: [
          {
            kind: "text",
            text: `paying ${entity?.canonicalName ?? params.recipient} (rate ${rate})`,
          },
        ],
        data: { paid: true },
      };
    },
  });
  return r;
}

test("runs a multi-step plan, resolves the recipient, passes results forward", async () => {
  const mem = new InMemoryMemory();
  await mem.upsertEntity({
    userId: "u1",
    kind: "person",
    canonicalName: "Chinelo Okafor",
    aliases: ["mum"],
    metadata: { accountNumber: "0123456789" },
  });
  const exec = new Executor(registry(), mem);
  const plan: Plan = {
    steps: [
      { skill: "get_rates", params: {}, dependsOn: [] },
      { skill: "pay_person", params: { recipient: "mum" }, dependsOn: [0] },
    ],
  };
  const result = await exec.run(plan, "u1");
  assert.equal(result.completed, true);
  assert.equal(result.replies.length, 2);
  // recipient resolved to canonical name, and rate passed from step 0
  assert.match(
    result.replies[1].kind === "text" ? result.replies[1].text : "",
    /paying Chinelo Okafor \(rate 1650\)/,
  );
});

test("ambiguous recipient pauses the plan and asks", async () => {
  const mem = new InMemoryMemory();
  await mem.upsertEntity({ userId: "u2", kind: "person", canonicalName: "Priya Sharma", aliases: ["priya"] });
  await mem.upsertEntity({ userId: "u2", kind: "person", canonicalName: "Priya Patel", aliases: ["priya"] });
  const exec = new Executor(registry(), mem);
  const plan: Plan = {
    steps: [{ skill: "pay_person", params: { recipient: "priya" }, dependsOn: [] }],
  };
  const result = await exec.run(plan, "u2");
  assert.equal(result.completed, false);
  const reply = result.replies[0];
  assert.equal(reply.kind, "buttons");
  if (reply.kind !== "buttons") return;
  assert.match(reply.text, /which one/i);
  const titles = reply.buttons.map((b) => b.title);
  assert.ok(titles.includes("Priya Sharma"));
  assert.ok(titles.includes("Priya Patel"));
  assert.ok(reply.buttons.every((b) => b.id.startsWith("q:")));
});

test("a conversational skill (no execute) is deferred to its flow", async () => {
  const r = registry();
  const flow: VerticalHandler = {
    vertical: "delivery",
    async start(): Promise<HandlerResult> {
      return { replies: [] };
    },
    async handle(): Promise<HandlerResult> {
      return { replies: [] };
    },
  };
  r.register({
    id: "delivery",
    name: "food",
    description: "order food",
    parameters: { type: "object" },
    handler: flow,
  });
  const exec = new Executor(r, new InMemoryMemory());
  const plan: Plan = {
    steps: [{ skill: "delivery", params: {}, dependsOn: [] }],
  };
  const result = await exec.run(plan, "u3");
  assert.equal(result.completed, false);
  assert.equal(result.deferred?.skill, "delivery");
});
