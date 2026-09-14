/**
 * MemoryService (Core 1) — the entity/alias layer.
 *
 * v1 focuses on entity resolution (people, places, payment methods) with alias
 * enrichment + fuzzy resolve, which is what makes "pay mum" work. Semantic fact
 * recall (pgvector + Gemini embeddings) layers on later; the schema already
 * reserves an embedding column for it.
 *
 * Two impls behind one interface: Postgres (durable, shared) and in-memory (the
 * graceful fallback when no DB is configured or the DB is unreachable, so the
 * agent degrades instead of crashing).
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { childLogger } from "../core/logger.js";
import {
  generateAliases,
  resolve as resolveEntities,
  withAlias,
  type Entity,
  type EntityKind,
  type ResolveResult,
} from "./entities.js";

const log = childLogger("memory");

export interface UpsertEntityInput {
  userId: string;
  kind: EntityKind;
  canonicalName: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

export interface MemoryService {
  init(): Promise<void>;
  upsertEntity(input: UpsertEntityInput): Promise<Entity>;
  addAlias(id: string, alias: string): Promise<void>;
  resolveEntity(
    userId: string,
    kind: EntityKind,
    query: string,
  ): Promise<ResolveResult>;
  listEntities(userId: string, kind?: EntityKind): Promise<Entity[]>;
  linkCoOccurrence(idA: string, idB: string): Promise<void>;
}

function enrich(input: UpsertEntityInput): string[] {
  let aliases = generateAliases(input.canonicalName);
  for (const a of input.aliases ?? []) aliases = withAlias(aliases, a);
  return aliases;
}

// ---------------------------------------------------------------------------
// In-memory (fallback / tests)
// ---------------------------------------------------------------------------
export class InMemoryMemory implements MemoryService {
  private byUser = new Map<string, Entity[]>();

  async init(): Promise<void> {}

  async upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    const list = this.byUser.get(input.userId) ?? [];
    const aliases = enrich(input);
    // Merge into an existing entity of the same kind whose canonical name matches.
    const existing = list.find(
      (e) =>
        e.kind === input.kind &&
        e.canonicalName.toLowerCase() === input.canonicalName.trim().toLowerCase(),
    );
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      existing.metadata = { ...existing.metadata, ...(input.metadata ?? {}) };
      existing.updatedAt = Date.now();
      return existing;
    }
    const entity: Entity = {
      id: randomUUID(),
      userId: input.userId,
      kind: input.kind,
      canonicalName: input.canonicalName.trim(),
      aliases,
      metadata: input.metadata ?? {},
      coOccurrences: [],
      updatedAt: Date.now(),
    };
    list.push(entity);
    this.byUser.set(input.userId, list);
    return entity;
  }

  async addAlias(id: string, alias: string): Promise<void> {
    for (const list of this.byUser.values()) {
      const e = list.find((x) => x.id === id);
      if (e) {
        e.aliases = withAlias(e.aliases, alias);
        e.updatedAt = Date.now();
        return;
      }
    }
  }

  async resolveEntity(
    userId: string,
    kind: EntityKind,
    query: string,
  ): Promise<ResolveResult> {
    const list = (this.byUser.get(userId) ?? []).filter((e) => e.kind === kind);
    return resolveEntities(query, list);
  }

  async listEntities(userId: string, kind?: EntityKind): Promise<Entity[]> {
    const list = this.byUser.get(userId) ?? [];
    return kind ? list.filter((e) => e.kind === kind) : list;
  }

  async linkCoOccurrence(idA: string, idB: string): Promise<void> {
    for (const list of this.byUser.values()) {
      const a = list.find((x) => x.id === idA);
      const b = list.find((x) => x.id === idB);
      if (a && !a.coOccurrences.includes(idB)) a.coOccurrences.push(idB);
      if (b && !b.coOccurrences.includes(idA)) b.coOccurrences.push(idA);
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres (durable). Storage in PG; resolution reuses the shared entities logic
// so behaviour is identical to the in-memory impl.
// ---------------------------------------------------------------------------
export class PgMemory implements MemoryService {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  async init(): Promise<void> {
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await this.pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memory_entities (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        kind text NOT NULL,
        canonical_name text NOT NULL,
        aliases text[] NOT NULL DEFAULT '{}',
        metadata jsonb NOT NULL DEFAULT '{}',
        co_occurrences text[] NOT NULL DEFAULT '{}',
        embedding vector(768),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS memory_entities_user_kind ON memory_entities (user_id, kind)`,
    );
  }

  async upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    const aliases = enrich(input);
    const canonical = input.canonicalName.trim();
    const existing = await this.pool.query(
      `SELECT * FROM memory_entities WHERE user_id=$1 AND kind=$2 AND lower(canonical_name)=lower($3) LIMIT 1`,
      [input.userId, input.kind, canonical],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const mergedAliases = [...new Set([...(row.aliases ?? []), ...aliases])];
      const mergedMeta = { ...row.metadata, ...(input.metadata ?? {}) };
      await this.pool.query(
        `UPDATE memory_entities SET aliases=$1, metadata=$2, updated_at=now() WHERE id=$3`,
        [mergedAliases, mergedMeta, row.id],
      );
      return rowToEntity({ ...row, aliases: mergedAliases, metadata: mergedMeta });
    }
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO memory_entities (id, user_id, kind, canonical_name, aliases, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.userId, input.kind, canonical, aliases, input.metadata ?? {}],
    );
    return {
      id,
      userId: input.userId,
      kind: input.kind,
      canonicalName: canonical,
      aliases,
      metadata: input.metadata ?? {},
      coOccurrences: [],
      updatedAt: Date.now(),
    };
  }

  async addAlias(id: string, alias: string): Promise<void> {
    const a = alias.trim().toLowerCase();
    if (!a) return;
    await this.pool.query(
      `UPDATE memory_entities
         SET aliases = (SELECT array_agg(DISTINCT x) FROM unnest(array_append(aliases, $2)) x),
             updated_at = now()
       WHERE id=$1`,
      [id, a],
    );
  }

  async resolveEntity(
    userId: string,
    kind: EntityKind,
    query: string,
  ): Promise<ResolveResult> {
    const list = await this.listEntities(userId, kind);
    return resolveEntities(query, list);
  }

  async listEntities(userId: string, kind?: EntityKind): Promise<Entity[]> {
    const res = kind
      ? await this.pool.query(
          `SELECT * FROM memory_entities WHERE user_id=$1 AND kind=$2`,
          [userId, kind],
        )
      : await this.pool.query(
          `SELECT * FROM memory_entities WHERE user_id=$1`,
          [userId],
        );
    return res.rows.map(rowToEntity);
  }

  async linkCoOccurrence(idA: string, idB: string): Promise<void> {
    await this.pool.query(
      `UPDATE memory_entities
         SET co_occurrences = (SELECT array_agg(DISTINCT x) FROM unnest(array_append(co_occurrences, $2)) x)
       WHERE id=$1`,
      [idA, idB],
    );
    await this.pool.query(
      `UPDATE memory_entities
         SET co_occurrences = (SELECT array_agg(DISTINCT x) FROM unnest(array_append(co_occurrences, $2)) x)
       WHERE id=$1`,
      [idB, idA],
    );
  }
}

function rowToEntity(row: {
  id: string;
  user_id: string;
  kind: string;
  canonical_name: string;
  aliases: string[] | null;
  metadata: Record<string, unknown> | null;
  co_occurrences: string[] | null;
  updated_at: string | Date;
}): Entity {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as EntityKind,
    canonicalName: row.canonical_name,
    aliases: row.aliases ?? [],
    metadata: row.metadata ?? {},
    coOccurrences: row.co_occurrences ?? [],
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

export { log as memoryLog };
