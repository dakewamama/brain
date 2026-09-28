import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buyAirtimeSkill,
  normalizePhone,
  validNigerianPhone,
  networkFromPhone,
} from "../src/skills/airtime.js";
import type { SkillContext } from "../src/skills/registry.js";

const ctx = { userId: "user-1" } as SkillContext; // owner for the debit

test("normalizePhone accepts +234/234 and strips formatting", () => {
  assert.equal(normalizePhone("+234 803 123 4567"), "08031234567");
  assert.equal(normalizePhone("2348031234567"), "08031234567");
  assert.equal(normalizePhone("0803-123-4567"), "08031234567");
});

test("validNigerianPhone enforces 0 + 10 digits", () => {
  assert.equal(validNigerianPhone("08031234567"), true);
  assert.equal(validNigerianPhone("0803123456"), false);
  assert.equal(validNigerianPhone("18031234567"), false);
});

test("networkFromPhone infers by prefix", () => {
  assert.equal(networkFromPhone("08031234567"), "mtn");
  assert.equal(networkFromPhone("08051234567"), "glo");
  assert.equal(networkFromPhone("08021234567"), "airtel");
  assert.equal(networkFromPhone("08091234567"), "9mobile");
  assert.equal(networkFromPhone("08001234567"), null);
});

// The purchase itself is a Case (policy → reserve → provider → verify); its
// adversarial coverage lives in tests/cases/airtime-case.test.ts. The skill
// validates its inputs before handing the request to the runtime.
test("buy_airtime asks for a valid number / amount before starting a case", async () => {
  const noPhone = await buyAirtimeSkill.execute!({ amount: 500 }, ctx);
  assert.equal(noPhone.needsInput, true);
  const badPhone = await buyAirtimeSkill.execute!({ amount: 500, phone: "123" }, ctx);
  assert.equal(badPhone.needsInput, true);
  const noAmount = await buyAirtimeSkill.execute!({ phone: "08031234567" }, ctx);
  assert.equal(noAmount.needsInput, true);
});
