import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  validateCredentials,
  AuthError,
} from "../src/auth/auth.js";

test("hashPassword/verifyPassword round-trip", () => {
  const stored = hashPassword("correct horse battery");
  assert.equal(verifyPassword("correct horse battery", stored), true);
  assert.equal(verifyPassword("wrong password", stored), false);
});

test("hashes are salted (same password -> different hash)", () => {
  assert.notEqual(hashPassword("samepass1"), hashPassword("samepass1"));
});

test("verifyPassword rejects malformed stored values", () => {
  assert.equal(verifyPassword("x", "notavalidhash"), false);
  assert.equal(verifyPassword("x", ""), false);
});

test("validateCredentials enforces email + min length", () => {
  assert.throws(() => validateCredentials("notanemail", "longenough1"), AuthError);
  assert.throws(() => validateCredentials("a@b.co", "short"), AuthError);
  assert.doesNotThrow(() => validateCredentials("a@b.co", "longenough1"));
});
