import { test } from "node:test";
import assert from "node:assert/strict";
import { skills } from "../src/skills/index.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { VerticalHandler } from "../src/handlers/types.js";
import type { HandlerResult } from "../src/core/types.js";

test("baseline commerce skills are registered", () => {
  for (const id of ["delivery", "gifting", "affiliate"]) {
    assert.ok(skills.has(id), `${id} should be registered`);
    assert.ok(skills.handlerFor(id), `${id} should resolve a handler`);
  }
});

test("listForLLM exposes provider-agnostic tool definitions", () => {
  const tools = skills.listForLLM();
  const delivery = tools.find((t) => t.name === "delivery");
  assert.ok(delivery);
  assert.ok(delivery.description.length > 0);
  assert.equal(typeof delivery.parameters, "object");
});

test("skills can be registered at runtime (the Learner seam)", () => {
  const reg = new SkillRegistry();
  const stub: VerticalHandler = {
    vertical: "unknown",
    async start(): Promise<HandlerResult> {
      return { replies: [{ kind: "text", text: "booked" }] };
    },
    async handle(): Promise<HandlerResult> {
      return { replies: [{ kind: "text", text: "booked" }] };
    },
  };
  assert.equal(reg.has("book_flight"), false);
  reg.register({
    id: "book_flight",
    name: "Book a flight",
    description: "Book a flight between two cities",
    parameters: { type: "object", properties: { origin: { type: "string" } } },
    handler: stub,
    origin: "learned",
  });
  assert.ok(reg.has("book_flight"));
  assert.equal(reg.find("book_flight")?.origin, "learned");
  assert.equal(reg.listForLLM()[0].name, "book_flight");
});
