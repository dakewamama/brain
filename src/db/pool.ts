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
  await p.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const applied = await p.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (applied.rowCount && applied.rowCount > 0) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log.info({ migration: file }, "applied migration");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
