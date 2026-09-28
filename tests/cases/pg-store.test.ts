/**
 * Postgres store tests — the exactly-once boundaries under real concurrency.
 * Skipped unless TEST_DATABASE_URL is set (local: the dev cluster on :5433).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const URL = process.env.TEST_DATABASE_URL;

if (!URL) {
  test("PostgreSQL durability requires TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = URL;
  const { migrate, closePool } = await import("../../src/db/pool.js");
  await migrate();
  const { PgCaseStore } = await import("../../src/cases/store.js");
  const pool = new Pool({ connectionString: URL, max: 8 });
  const store = new PgCaseStore(pool);
  after(async () => { await pool.end(); await closePool(); });

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
      Array.from({ length: 64 }, (_, i) => store.appendEvent(c.id, "state_transition", { i })),
    );
    const events = await store.listEvents(c.id);
    assert.equal(events.length, 64);
    assert.deepEqual(events.map((e) => e.seq), Array.from({ length: 64 }, (_, i) => i + 1));
  });

  test("an insert blocked by an uncommitted duplicate returns the committed action", async () => {
    const id = randomUUID();
    const c = await store.createCase({ id, userId: "foundation", channel: "test", goal: "g", playbook: "test", state: "wait" });
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("INSERT INTO actions (id,case_id,capability,status,input,idempotency_key) VALUES ($1,$2,'test','proposed','{}',$1)", [id, c.id]);
      const loser = store.createAction({ id: randomUUID(), caseId: c.id, capability: "test", idempotencyKey: id, input: {} });
      // Wait until PostgreSQL reports the actual uniqueness lock, not a timer guess.
      for (let i = 0; i < 100; i++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%INSERT INTO actions%'");
        if (waiting.rowCount) break;
        await new Promise(resolve => setTimeout(resolve, 10));
        if (i === 99) throw new Error("duplicate insert did not block");
      }
      await tx.query("COMMIT");
      const result = await loser;
      assert.equal(result.created, false);
      assert.equal(result.action.id, id);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  test("provider attempts have gapless ordering under concurrency", async () => {
    const id = randomUUID();
    await store.createCase({ id, userId: "foundation", channel: "test", goal: "g", playbook: "test", state: "wait" });
    await store.createAction({ id, caseId: id, capability: "test", idempotencyKey: id, input: {} });
    const attempts = await Promise.all(Array.from({ length: 32 }, () => store.appendAttempt({ id: randomUUID(), actionId: id, provider: "test", mode: "MOCK", request: {}, outcome: "submitted" })));
    assert.deepEqual(attempts.map(a => a.seq).sort((a,b) => a-b), Array.from({length:32}, (_,i) => i+1));
  });

  test("fresh process reloads the repository, wakes a persisted case, and preserves inbound dedupe", async () => {
    const id = randomUUID();
    await store.createCase({ id, userId: "foundation", channel: "test", goal: "persisted goal", playbook: "restart", state: "resume", context: { durable: true }, budgetMinor: 123n });
    await store.updateCase(id, { status: "waiting_timeout", wakeAt: new Date(0) });
    await store.claimInbound({ id, channel: "test", providerMessageId: id, payload: { caseId: id } });
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/pg-resume.ts", id], { env: { ...process.env, DATABASE_URL: URL }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", b => { output += b; });
    child.stderr.on("data", b => { output += b; });
    const code = await new Promise(resolve => child.on("exit", resolve));
    assert.equal(code, 0, output);
    assert.equal((await store.getCase(id))?.status, "waiting_user");
    assert.equal((await store.getCase(id))?.budgetMinor, 123n);
    assert.ok((await store.listEvents(id)).some(e => e.type === "case_wake"));
    assert.equal(await store.claimInbound({ id: randomUUID(), channel: "test", providerMessageId: id, payload: {} }), false);
    assert.ok((await store.listUnprocessedInbound(10000)).some(e => e.id === id));
    await store.markInboundProcessed(id);
    assert.ok(!(await store.listUnprocessedInbound(10000)).some(e => e.id === id));
  });
}
