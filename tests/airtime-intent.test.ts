import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAirtime,
  looksLikeAirtime,
  mergeSlots,
  missingSlot,
  hasAnySlot,
} from "../src/router/airtimeIntent.js";

test("looksLikeAirtime detects the vertical", () => {
  assert.equal(looksLikeAirtime("buy ₦200 MTN airtime for 08031234567"), true);
  assert.equal(looksLikeAirtime("top up 08051234567 with 100"), true);
  assert.equal(looksLikeAirtime("recharge my line"), true);
  assert.equal(looksLikeAirtime("order me a pizza"), false);
  assert.equal(looksLikeAirtime("MTN"), false);
});

test("parseAirtime extracts amount, network, phone", () => {
  const s = parseAirtime("buy ₦200 MTN airtime for 08031234567");
  assert.equal(s.amount, 200);
  assert.equal(s.network, "mtn");
  assert.equal(s.phone, "08031234567");
});

test("parseAirtime handles bare slot answers", () => {
  assert.deepEqual(parseAirtime("MTN"), { network: "mtn" });
  assert.deepEqual(parseAirtime("500"), { amount: 500 });
  assert.equal(parseAirtime("08051234567").phone, "08051234567");
  assert.equal(parseAirtime("9mobile").network, "9mobile");
});

test("mergeSlots infers network from the phone prefix", () => {
  const merged = mergeSlots({ amount: 200 }, { phone: "08051234567" });
  assert.equal(merged.network, "glo"); // 0805 -> Glo
  assert.equal(merged.amount, 200);
});

test("mergeSlots: a later answer fills the gap", () => {
  const merged = mergeSlots({ amount: 200, phone: "08012345678" }, { network: "mtn" });
  assert.equal(missingSlot(merged), null); // complete
});

test("missingSlot reports the first gap in order", () => {
  assert.equal(missingSlot({}), "amount");
  assert.equal(missingSlot({ amount: 100 }), "phone");
  assert.equal(missingSlot({ amount: 100, phone: "08012345678" }), "network");
  assert.equal(missingSlot({ amount: 100, phone: "08031234567", network: "mtn" }), null);
});

test("hasAnySlot", () => {
  assert.equal(hasAnySlot({}), false);
  assert.equal(hasAnySlot({ network: "mtn" }), true);
});
