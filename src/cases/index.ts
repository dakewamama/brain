/**
 * Case runtime bootstrap — one store, one policy engine, one runner, one worker.
 *
 * With DATABASE_URL the store is Postgres (durable across restarts); without it,
 * everything still runs on the in-memory store (tests, local demo) — money
 * capabilities still fail closed when the custody service is not configured.
 * Init is idempotent and best-effort like the other boot-time services.
 */
import { childLogger } from "../core/logger.js";
import { getPool, migrate } from "../db/pool.js";
import {
  InMemoryCaseStore,
  PgCaseStore,
  type CaseStore,
} from "./store.js";
import { CaseRunner } from "./runtime.js";
import { CaseWorker, type Notifier } from "./worker.js";
import { PolicyEngine } from "../policy/policy.js";
import { airtimePlaybook, airtimeReconciler } from "../playbooks/airtime.js";
import {
  airtimePurchaseExecutor,
  airtimeRequeryExecutor,
} from "../capabilities/airtime.js";

const log = childLogger("cases");

let store: CaseStore = new InMemoryCaseStore();
let policy: PolicyEngine = new PolicyEngine();
let runner: CaseRunner = new CaseRunner(store, "LIVE");
let worker: CaseWorker = new CaseWorker(runner, store);
let initialized = false;

export function getCaseStore(): CaseStore {
  return store;
}
export function getPolicy(): PolicyEngine {
  return policy;
}
export function getCaseRunner(): CaseRunner {
  return runner;
}

export async function initCases(notify?: Notifier): Promise<void> {
  if (initialized) return;
  const pool = getPool();
  if (pool) {
    try {
      await migrate();
      store = new PgCaseStore(pool);
      log.info("Cases: Postgres store ready.");
    } catch (err) {
      // Fail loud at boot: silently running money flows on a degraded store is
      // how ledgers drift. The process still serves non-case traffic.
      log.error({ err: String(err) }, "Cases: Postgres init FAILED; staying on in-memory store");
    }
  } else {
    log.info("Cases: in-memory store (set DATABASE_URL for durability).");
  }
  policy = new PolicyEngine();
  // LIVE is the only production mode; tests construct their own runner with
  // explicit MOCK executors rather than flipping a global flag.
  runner = new CaseRunner(store, "LIVE");
  runner.registerPlaybook(airtimePlaybook({ store, policy, runner }));
  runner.registerCapability(airtimePurchaseExecutor());
  runner.registerCapability(airtimeRequeryExecutor());
  runner.registerReconciler("airtime", airtimeReconciler({ store, policy, runner }));
  worker = new CaseWorker(runner, store, notify ?? null);
  initialized = true;
}

export function startCaseWorker(): void {
  worker.start();
}

/** Test seam: reset to pristine in-memory state. */
export function resetCasesForTests(): void {
  store = new InMemoryCaseStore();
  policy = new PolicyEngine();
  runner = new CaseRunner(store, "LIVE");
  worker = new CaseWorker(runner, store);
  initialized = false;
}

/** Test seam: in-memory store + the real airtime playbook with injected
 *  executors/balance, so pipeline-level tests exercise the real flow. */
export function configureCasesForTests(opts: {
  purchase: Parameters<CaseRunner["registerCapability"]>[0];
  requery?: Parameters<CaseRunner["registerCapability"]>[0];
  getBalance?: Parameters<typeof airtimePlaybook>[0]["getBalance"];
  requeryDelayMs?: number;
}): void {
  resetCasesForTests();
  policy = new PolicyEngine();
  runner = new CaseRunner(store, "SANDBOX");
  runner.registerPlaybook(
    airtimePlaybook({ store, policy, runner, getBalance: opts.getBalance, requeryDelayMs: opts.requeryDelayMs ?? 1 }),
  );
  runner.registerCapability(opts.purchase);
  runner.registerCapability(
    opts.requery ?? {
      capability: "telecom.airtime.requery",
      provider: "test",
      mode: "MOCK",
      execute: async () => ({ ok: false, outcome: "unknown", response: { providerStatus: "" } }),
    },
  );
  runner.registerReconciler(
    "airtime",
    airtimeReconciler({ store, policy, runner, getBalance: opts.getBalance, requeryDelayMs: opts.requeryDelayMs ?? 1 }),
  );
}
