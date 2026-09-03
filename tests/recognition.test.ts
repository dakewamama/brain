import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleRecognizer } from "../src/recognition/rules.js";
const r = new RuleRecognizer();
test("clean order extracts vendor and item at high confidence", async () => {
  const out = await r.recognize({ text: "chicken wings from Nadia" });
  assert.equal(out.action, "order");
  assert.equal(out.vertical, "delivery");
  assert.match(out.vendor ?? "", /Nadia/i);
  assert.match(out.item ?? "", /chicken wings/i);
  assert.ok(out.confidence >= 0.85, `confidence was ${out.confidence}`);
  assert.equal(out.clarificationNeeded, false);
});
test("quantity is extracted from digits", async () => {
  const out = await r.recognize({ text: "2 chicken wings from nadia" });
  assert.equal(out.quantity, 2);
});
test("quantity is extracted from number words", async () => {
  const out = await r.recognize({ text: "two shawarma from nadia" });
  assert.equal(out.quantity, 2);
});
test("vague hunger asks for clarification", async () => {
  const out = await r.recognize({ text: "i dey hungry" });
  assert.equal(out.clarificationNeeded, true);
  assert.ok(out.clarificationPrompt);
});
test("item without vendor asks which vendor", async () => {
  const out = await r.recognize({ text: "i want jollof" });
  assert.equal(out.action, "order");
});
test("greeting recognised", async () => {
  const out = await r.recognize({ text: "hi" });
  assert.equal(out.action, "greet");
  assert.ok(out.confidence >= 0.9);
});
test("cancel recognised with high confidence", async () => {
  const out = await r.recognize({ text: "cancel" });
  assert.equal(out.action, "cancel");
  assert.ok(out.confidence >= 0.9);
});
test("shop intent recognised", async () => {
  const out = await r.recognize({ text: "buy an oraimo powerbank" });
  assert.equal(out.action, "shop");
  assert.equal(out.vertical, "affiliate");
});
test("gift intent recognised", async () => {
  const out = await r.recognize({ text: "send lunch to Ebele" });
  assert.equal(out.action, "gift");
  assert.equal(out.vertical, "gifting");
});
test("empty message asks, never crashes", async () => {
  const out = await r.recognize({ text: "" });
  assert.equal(out.clarificationNeeded, true);
});
test("gibberish returns low confidence and asks", async () => {
  const out = await r.recognize({ text: "asdkfj qwerty zzz" });
  assert.ok(out.confidence < 0.55);
  assert.equal(out.clarificationNeeded, true);
});
