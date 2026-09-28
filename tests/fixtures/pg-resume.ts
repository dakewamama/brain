import assert from "node:assert/strict";
import { Pool } from "pg";
import { PgCaseStore } from "../../src/cases/store.js";
import { CaseRunner } from "../../src/cases/runtime.js";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
try {
  const store = new PgCaseStore(pool);
  const runner = new CaseRunner(store);
  runner.registerPlaybook({ id: "restart", initialState: "resume", states: { resume: { async onEnter(ctx) { assert.equal(ctx.context.durable, true); return { askUser: { question: "resumed after restart" }, context: ctx.context }; } } } });
  await runner.wakeDueCases();
  assert.equal((await store.getCase(process.argv[2]))?.status, "waiting_user");
} finally { await pool.end(); }
