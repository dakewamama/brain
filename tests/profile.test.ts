import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryProfileStore, FileProfileStore } from "../src/store/profile.js";

test("summary is null until something is learned", async () => {
  const s = new InMemoryProfileStore();
  assert.equal(await s.summary("u1"), null);
});

test("summary reflects the most frequent item/vendor and the latest", async () => {
  const s = new InMemoryProfileStore();
  await s.record("u1", { vertical: "delivery", item: "jollof rice", vendor: "Mama Put Express", at: 1 });
  await s.record("u1", { vertical: "delivery", item: "jollof rice", vendor: "Mama Put Express", at: 2 });
  await s.record("u1", { vertical: "delivery", item: "chicken wings", vendor: "Nadia's Kitchen", at: 3 });
  const sum = await s.summary("u1");
  assert.ok(sum);
  assert.match(sum, /often orders jollof rice/);
  assert.match(sum, /likes Mama Put Express/);
  assert.match(sum, /recently: chicken wings/);
});

test("summary never contains a price/number from events", async () => {
  const s = new InMemoryProfileStore();
  await s.record("u2", { vertical: "delivery", item: "suya", vendor: "Nadia's Kitchen", at: 1 });
  const sum = (await s.summary("u2")) ?? "";
  assert.ok(!/\d/.test(sum), "no digits in the learning hint");
});

test("file store persists across instances (durable)", async () => {
  const dir = join(tmpdir(), `axis-profile-${Date.now()}`);
  const a = new FileProfileStore(dir);
  await a.record("web:u3", { vertical: "affiliate", item: "oraimo powerbank", at: 1 });
  const b = new FileProfileStore(dir);
  const sum = await b.summary("web:u3");
  assert.ok(sum && sum.includes("oraimo powerbank"));
  await fs.rm(dir, { recursive: true, force: true });
});
