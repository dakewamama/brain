import { test } from "node:test";
import assert from "node:assert/strict";
import { secretOk, bearer } from "../src/router/webhookAuth.js";

test("secretOk: fails closed on missing values (P0 items 2, 3)", () => {
  assert.equal(secretOk("x", undefined), false);
  assert.equal(secretOk(undefined, "x"), false);
  assert.equal(secretOk(undefined, undefined), false);
});

test("secretOk: rejects wrong, accepts exact", () => {
  assert.equal(secretOk("nope", "secret"), false);
  assert.equal(secretOk("secre", "secret"), false); // length differs
  assert.equal(secretOk("secret", "secret"), true);
});

test("bearer: extracts token only from a well-formed header", () => {
  assert.equal(bearer("Bearer abc123"), "abc123");
  assert.equal(bearer("abc123"), undefined);
  assert.equal(bearer(undefined), undefined);
  assert.equal(bearer("Bearer "), "");
});
