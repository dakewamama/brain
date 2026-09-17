import { test } from "node:test";
import assert from "node:assert/strict";
import { skills } from "../src/skills/index.js";
import { SkillRegistry } from "../src/skills/registry.js";
import type { SkillOutcome } from "../src/skills/registry.js";

test("baseline atomic skills are registered with an execute()", () => {
  for (const id of ["save_address", "pay_person"]) {
    assert.ok(skills.has(id), `${id} should be registered`);
    assert.equal(typeof skills.find(id)?.execute, "function", `${id} needs execute()`);
  }
});

test("listForLLM exposes provider-agnostic tool definitions", () => {
  const tools = skills.listForLLM();
  const pay = tools.find((t) => t.name === "pay_person");
  assert.ok(pay);
  assert.ok(pay.description.length > 0);
  assert.equal(typeof pay.parameters, "object");
});

test("skills can be registered at runtime (the Learner seam)", () => {
  const reg = new SkillRegistry();
  assert.equal(reg.has("book_flight"), false);
  reg.register({
    id: "book_flight",
    name: "Book a flight",
    description: "Book a flight between two cities",
    parameters: { type: "object", properties: { origin: { type: "string" } } },
    async execute(): Promise<SkillOutcome> {
      return { replies: [{ kind: "text", text: "booked" }] };
    },
    origin: "learned",
  });
  assert.ok(reg.has("book_flight"));
  assert.equal(reg.find("book_flight")?.origin, "learned");
  assert.equal(reg.listForLLM()[0].name, "book_flight");
});
