/**
 * Case worker — the loop that makes waiting cases move without an HTTP request.
 * Two sweeps on a timer:
 *  - wake waiting_timeout cases whose wake_at has passed (recheck cycles,
 *    deadlines) and deliver any replies their states emitted;
 *  - run playbook reconcilers for in_doubt cases and deliver their verdict
 *    messages.
 * Notifications are deduped durably: a "notified" event is appended after
 * delivery, so a worker restart never double-sends a verdict message. (Chat
 * messages are not money; at-least-once with durable dedupe is the right class
 * of guarantee here — exactly-once is reserved for financial effects.)
 */
import type { CaseRunner } from "./runtime.js";
import type { CaseStore } from "./store.js";
import { childLogger } from "../core/logger.js";
import { getConfig } from "../core/config.js";

const log = childLogger("worker");

export interface Notifier {
  (userId: string, channel: string, texts: string[]): Promise<void>;
}

export function pendingNotifications(store: CaseStore, caseId: string): Promise<string[]> {
  return collectUnnotified(store, caseId);
}

async function collectUnnotified(store: CaseStore, caseId: string): Promise<string[]> {
  const events = await store.listEvents(caseId);
  const texts: string[] = [];
  let notifiedAfter = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "notified") { notifiedAfter = true; break; }
    if (e.type === "replies") {
      const t = (e.payload.texts as string[] | undefined) ?? [];
      texts.unshift(...t);
    }
    if (e.type === "case_completed" || e.type === "case_failed" || e.type === "case_cancelled") {
      // terminal reached; keep scanning back for replies but stop at start
    } else if (e.type === "state_transition" && texts.length === 0 && !notifiedAfter) {
      // a running case may hold pending replies only transiently — skip
    }
  }
  return texts;
}

export class CaseWorker {
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;

  constructor(
    private runner: CaseRunner,
    private store: CaseStore,
    private notify: Notifier | null = null,
  ) {}

  start(intervalMs?: number): void {
    const ms = intervalMs ?? getConfig().CASE_WORKER_POLL_MS;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.timer.unref?.();
    log.info({ intervalMs: ms }, "case worker started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.activeTick;
  }

  async tick(): Promise<void> {
    if(this.activeTick) return this.activeTick;
    const active=this.sweep();this.activeTick=active;
    try {await active;} finally {if(this.activeTick===active)this.activeTick=null;}
  }

  private async sweep(): Promise<void> {
    try {
      await this.runner.recoverRunning();
      await this.runner.wakeDueCases();
      await this.runner.reconcileInDoubt();
      await this.deliverReplies();
    } catch (err) {
      log.error({ err: String(err) }, "worker tick failed");
    }
  }

  /** Send any reply events that reached a resting case but were never delivered. */
  private async deliverReplies(): Promise<void> {
    if (!this.notify) return;
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const cases = await this.store.listByStatus(status);
      for (const c of cases.slice(-25)) {
        const texts = await collectUnnotified(this.store, c.id);
        if (texts.length === 0) continue;
        try {
          await this.notify(c.userId, c.channel, texts);
          await this.store.appendEvent(c.id, "notified", { count: texts.length });
        } catch (err) {
          log.warn({ caseId: c.id, err: String(err) }, "notify failed; will retry next sweep");
        }
      }
    }
  }
}
