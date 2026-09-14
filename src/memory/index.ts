/**
 * Process-wide MemoryService. Postgres when DATABASE_URL is set (and reachable),
 * otherwise in-memory. Init is best-effort: if the DB init fails we log and fall
 * back to in-memory rather than take the service down.
 */
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { InMemoryMemory, PgMemory, type MemoryService } from "./service.js";

const log = childLogger("memory");

let memory: MemoryService = new InMemoryMemory();

export function getMemory(): MemoryService {
  return memory;
}

/** Call once at boot. Never throws — degrades to in-memory on any failure. */
export async function initMemory(): Promise<void> {
  const url = getConfig().DATABASE_URL;
  if (!url) {
    log.info("Memory: in-memory (set DATABASE_URL for durable Postgres memory).");
    return;
  }
  const pg = new PgMemory(url);
  try {
    await pg.init();
    memory = pg;
    log.info("Memory: Postgres (pgvector) ready.");
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "Memory: Postgres init failed; using in-memory fallback.",
    );
  }
}

export type { MemoryService } from "./service.js";
export type {
  Entity,
  EntityKind,
  ResolveResult,
} from "./entities.js";
