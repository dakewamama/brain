/**
 * Postgres access for the Case runtime. One pool, shared. Migrations are plain
 * SQL files applied once, tracked in schema_migrations — no ORM, no codegen.
 * Unset DATABASE_URL => the runtime falls back to the in-memory store (tests /
 * local demo) and money capabilities fail closed in production mode.
 */
import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("db");

let pool: Pool | null = null;

export function getPool(): Pool | null {
  if (pool) return pool;
  const url = getConfig().DATABASE_URL;
  if (!url) return null;
  pool = new Pool({ connectionString: url, max: 10 });
  return pool;
}

/** Test seam: close and forget the shared pool. */
export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}

/** Apply every pending migration in src/db/migrations (sorted by filename). */
export async function migrate(): Promise<void> {
  const p = getPool();
  if (!p) throw new Error("migrate() requires DATABASE_URL");
  const client=await p.connect();
  // Serialize startup migrations per schema using a session-scoped PG lock.
  // No check-then-create race when two application processes start together.
  const lock="hashtextextended(current_database() || ':' || current_schema() || ':axis-migrations',0)";
  try {
    await client.query(`SELECT pg_advisory_lock(${lock})`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const dir=join(dirname(fileURLToPath(import.meta.url)),"migrations");
    const files=readdirSync(dir).filter(f=>f.endsWith(".sql")).sort();
    for(const file of files) {
      if((await client.query("SELECT 1 FROM schema_migrations WHERE version=$1",[file])).rowCount) continue;
      try {
        await client.query("BEGIN");await client.query(readFileSync(join(dir,file),"utf8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)",[file]);await client.query("COMMIT");
        log.info({migration:file},"applied migration");
      }catch(error){await client.query("ROLLBACK");throw error;}
    }
  }finally{await client.query(`SELECT pg_advisory_unlock(${lock})`);client.release();}
}
