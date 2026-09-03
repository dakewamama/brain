import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizer } from "../src/recognition/index.js";
import { consultBrain } from "../src/brain/adapter.js";
import type { ConversationEvent } from "../src/core/types.js";
async function run(text: string) {
  const recognized = await recognizer.recognize({ text });
  return consultBrain({
    recognized,
    session: null,
    userId: "wire",
    rawText: text,
    history: [] as ConversationEvent[],
  });
}
test("greeting flows to a menu with buttons", async () => {
  const r = await run("hi");
  assert.equal(r.directive.kind, "show_menu");
  assert.ok(r.replies[0].kind === "buttons");
});
test("clean order flows to availability check", async () => {
  const r = await run("2 chicken wings from Nadia");
  assert.equal(r.directive.kind, "check_availability");
});
test("messy pidgin order still routes to delivery reasoning", async () => {
  const r = await run("abeg send me jollof from nadia sharp sharp");
  assert.ok(
    r.directive.kind === "check_availability" ||
      r.directive.kind === "ask_clarification",
  );
});
test("vague hunger asks rather than acting", async () => {
  const r = await run("i dey hungry");
  assert.equal(r.directive.kind, "ask_clarification");
});
test("shop intent starts the affiliate vertical", async () => {
  const r = await run("buy an oraimo powerbank");
  assert.equal(r.directive.kind, "start_vertical");
});
test("cancel is honoured end to end", async () => {
  const r = await run("cancel");
  assert.equal(r.directive.kind, "cancel_flow");
});
test("every reply has non-empty text", async () => {
  for (const msg of ["hi", "order food", "asdf", "buy phone", "cancel"]) {
    const r = await run(msg);
    const text = r.replies
      .map((m) =>
        m.kind === "text" ||
        m.kind === "buttons" ||
        m.kind === "location_request"
          ? m.text
          : "",
      )
      .join("");
    assert.ok(text.trim().length > 0, `empty reply for "${msg}"`);
  }
});
