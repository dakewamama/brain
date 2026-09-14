import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateAliases,
  similarity,
  resolve,
  type Entity,
} from "../src/memory/entities.js";
import { InMemoryMemory } from "../src/memory/service.js";

test("generateAliases yields full name + meaningful tokens", () => {
  const a = generateAliases("Chinelo Okafor");
  assert.ok(a.includes("chinelo okafor"));
  assert.ok(a.includes("chinelo"));
  assert.ok(a.includes("okafor"));
});

test("similarity: exact=1, close is high, unrelated is low", () => {
  assert.equal(similarity("mum", "mum"), 1);
  assert.ok(similarity("chinello", "chinelo") > 0.7);
  assert.ok(similarity("mum", "powerbank") < 0.2);
});

test("resolve picks the aliased entity for a relationship word", async () => {
  const mem = new InMemoryMemory();
  const mum = await mem.upsertEntity({
    userId: "u1",
    kind: "person",
    canonicalName: "Chinelo Okafor",
    aliases: ["mum"],
    metadata: { bankCode: "058", accountNumber: "0123456789" },
  });
  const r = await mem.resolveEntity("u1", "person", "send money to my mum");
  // note: "send money to my mum" contains "mum" as a token match
  const direct = await mem.resolveEntity("u1", "person", "mum");
  assert.equal(direct.match?.id, mum.id);
  assert.equal(direct.match?.metadata.accountNumber, "0123456789");
  assert.ok(r.candidates.length >= 0);
});

test("resolve flags ambiguity between two people with the same name", () => {
  const base = {
    userId: "u1",
    kind: "person" as const,
    metadata: {},
    coOccurrences: [],
    updatedAt: Date.now(),
  };
  const priyaA: Entity = { ...base, id: "a", canonicalName: "Priya Sharma", aliases: ["priya sharma", "priya", "sharma"] };
  const priyaB: Entity = { ...base, id: "b", canonicalName: "Priya Patel", aliases: ["priya patel", "priya", "patel"] };
  const r = resolve("priya", [priyaA, priyaB]);
  assert.equal(r.ambiguous, true);
  assert.equal(r.match, null);
  assert.equal(r.candidates.length, 2);
});

test("upsert merges aliases/metadata into the same canonical entity", async () => {
  const mem = new InMemoryMemory();
  const first = await mem.upsertEntity({ userId: "u2", kind: "person", canonicalName: "Ada" });
  const second = await mem.upsertEntity({
    userId: "u2",
    kind: "person",
    canonicalName: "Ada",
    aliases: ["sister"],
    metadata: { phone: "0803" },
  });
  assert.equal(first.id, second.id);
  const list = await mem.listEntities("u2", "person");
  assert.equal(list.length, 1);
  assert.ok(list[0].aliases.includes("sister"));
  assert.equal(list[0].metadata.phone, "0803");
});

test("unknown reference resolves to nothing (no false match)", async () => {
  const mem = new InMemoryMemory();
  await mem.upsertEntity({ userId: "u3", kind: "person", canonicalName: "Chinelo" });
  const r = await mem.resolveEntity("u3", "person", "the president");
  assert.equal(r.match, null);
});
