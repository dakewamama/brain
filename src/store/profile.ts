/**
 * Per-user learning profile. Records what a user actually does (vertical + the
 * item/vendor they named) so recommendations improve over time. Two impls:
 *   - InMemory: default; resets on restart.
 *   - File: durable across restarts/redeploys when PROFILE_STORE_DIR points at a
 *     mounted volume (same pattern as the onboarding deposit ledger).
 *
 * It stores only what the user said (item/vendor names) + timestamps — never a
 * price or any invented fact. The derived `summary` is a short, price-free hint
 * fed to the model for personalization.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { childLogger } from "../core/logger.js";

const log = childLogger("profile");
const MAX_EVENTS = 50;

export interface ProfileEvent {
  vertical: string;
  item?: string;
  vendor?: string;
  at: number;
}

export interface UserProfile {
  key: string;
  events: ProfileEvent[];
  updatedAt: number;
}

export interface ProfileStore {
  get(key: string): Promise<UserProfile | null>;
  record(key: string, event: ProfileEvent): Promise<void>;
  /** Short, price-free personalization hint, or null if nothing learned yet. */
  summary(key: string): Promise<string | null>;
}

function summarize(profile: UserProfile | null): string | null {
  if (!profile || profile.events.length === 0) return null;
  const items = tally(profile.events.map((e) => e.item));
  const vendors = tally(profile.events.map((e) => e.vendor));
  const topItem = top(items);
  const topVendor = top(vendors);
  const last = profile.events[profile.events.length - 1];
  const parts: string[] = [];
  if (topItem) parts.push(`often orders ${topItem}`);
  if (topVendor) parts.push(`likes ${topVendor}`);
  if (last?.item && last.item !== topItem) parts.push(`recently: ${last.item}`);
  return parts.length ? parts.join("; ") : null;
}

function tally(values: Array<string | undefined>): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
}

function top(m: Map<string, number>): string | undefined {
  let best: string | undefined;
  let n = 0;
  for (const [k, c] of m) if (c > n) ((best = k), (n = c));
  return best;
}

export class InMemoryProfileStore implements ProfileStore {
  private profiles = new Map<string, UserProfile>();

  async get(key: string): Promise<UserProfile | null> {
    return this.profiles.get(key) ?? null;
  }

  async record(key: string, event: ProfileEvent): Promise<void> {
    const p = this.profiles.get(key) ?? { key, events: [], updatedAt: 0 };
    p.events.push(event);
    if (p.events.length > MAX_EVENTS) p.events = p.events.slice(-MAX_EVENTS);
    p.updatedAt = Date.now();
    this.profiles.set(key, p);
  }

  async summary(key: string): Promise<string | null> {
    return summarize(this.profiles.get(key) ?? null);
  }
}

export class FileProfileStore implements ProfileStore {
  constructor(private dir: string) {}

  private path(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  async get(key: string): Promise<UserProfile | null> {
    try {
      const raw = await fs.readFile(this.path(key), "utf8");
      return JSON.parse(raw) as UserProfile;
    } catch {
      return null;
    }
  }

  async record(key: string, event: ProfileEvent): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const p = (await this.get(key)) ?? { key, events: [], updatedAt: 0 };
      p.events.push(event);
      if (p.events.length > MAX_EVENTS) p.events = p.events.slice(-MAX_EVENTS);
      p.updatedAt = Date.now();
      const tmp = `${this.path(key)}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(p), "utf8");
      await fs.rename(tmp, this.path(key));
    } catch (err) {
      // Learning is best-effort; never break a reply because a write failed.
      log.warn({ key, err: (err as Error).message }, "profile record failed");
    }
  }

  async summary(key: string): Promise<string | null> {
    return summarize(await this.get(key));
  }
}
