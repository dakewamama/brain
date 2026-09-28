/**
 * Postgres store tests — the exactly-once boundaries under real concurrency.
 * Skipped unless TEST_DATABASE_URL is set (local: the dev cluster on :5433).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const URL = process.env.TEST_DATABASE_URL;

if (!URL) {
  test("pg store tests skipped (set TEST_DATABASE_URL)", () => {
    assert.ok(true);
  });
} else {
  process.env.DATABASE_URL = URL;
  const { migrate } = await import("../../src/db/pool.js");
  await migrate();
  const { PgCaseStore } = await import("../../src/cases/store.js");
  const pool = new Pool({ connectionString: URL, max: 8 });
  const store = new PgCaseStore(pool);

  test("concurrent createAction with one idempotency key creates exactly one action", async () => {
    const c = await store.createCase({
      id: `case_pg_${Date.now()}`, userId: "u1", channel: "test", goal: "g",
      playbook: "airtime", state: "validate",
    });
    const key = `airtime:${c.id}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.createAction({
          id: `act_pg_${c.id}_${i}`, caseId: c.id, capability: "telecom.airtime",
          idempotencyKey: key, input: { amount: 500 },
        }),
      ),
    );
    const created = results.filter((r) => r.created);
    assert.equal(created.length, 1, "exactly one insert wins the race");
    const ids = new Set(results.map((r) => r.action.id));
    assert.equal(ids.size, 1, "every caller sees the same action");
  });

  test("concurrent claimInbound claims exactly once", async () => {
    const ts = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.claimInbound({
          id: `inb_pg_${ts}_${i}`, channel: "whatsapp",
          providerMessageId: `wamid.concurrent.${ts}`, payload: {},
        }),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1);
  });

  test("a case persisted waiting_timeout resumes on a NEW store instance (restart)", async () => {
    const c = await store.createCase({
      id: `case_pg_wake_${Date.now()}`, userId: "u1", channel: "test", goal: "g",
      playbook: "airtime", state: "recheck",
      context: { actionId: "act_x", slots: { phone: "08031234567", amount: 500, network: "MTN" } },
    });
    await store.updateCase(c.id, { status: "waiting_timeout", wakeAt: new Date(Date.now() - 1000) });
    const fresh = new PgCaseStore(new Pool({ connectionString: URL }));
    const due = await fresh.listWakeable(new Date());
    assert.equal(due.filter((x) => x.id === c.id).length, 1);
    await fresh.updateCase(c.id, { status: "running" });
    const reread = await fresh.getCase(c.id);
    assert.equal(reread?.status, "running");
    await (fresh as unknown as { pool: Pool }).pool.end();
  });

  test("event sequence is gapless under concurrent appends", async () => {
    const c = await store.createCase({
      id: `case_pg_ev_${Date.now()}`, userId: "u1", channel: "test", goal: "g",
      playbook: "airtime", state: "validate",
    });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.appendEvent(c.id, "state_transition", { i })),
    );
    const events = await store.listEvents(c.id);
    assert.equal(events.length, 10);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
}
