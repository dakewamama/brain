/**
 * Entity resolution — the "one person, many names" problem.
 *
 * A user calls the same person "Mum", "Mama", "Chinelo", "my mother". Memory must
 * resolve all of these to one canonical entity. This module is the PURE logic
 * (no DB): alias generation, fuzzy scoring, and a resolve() that returns the best
 * match with a confidence, or asks to disambiguate when it's a close call.
 *
 * Principle: suggest, don't guess. A wrong merge (paying the wrong person) is far
 * worse than asking "which Priya?". So resolve() surfaces ambiguity instead of
 * silently picking.
 */

export type EntityKind = "person" | "place" | "payment_method";

export interface Entity {
  id: string;
  userId: string;
  kind: EntityKind;
  canonicalName: string;
  aliases: string[];
  metadata: Record<string, unknown>; // bankCode, accountNumber, phone, coords…
  coOccurrences: string[]; // ids of entities seen together
  updatedAt: number;
}

export interface ResolveResult {
  match: Entity | null;
  confidence: number; // 0..1 for the top match
  /** Set when two+ candidates are close — the caller should ask the user. */
  ambiguous: boolean;
  candidates: Array<{ entity: Entity; score: number }>;
}

const STOP_ALIASES = new Set(["my", "the", "a", "to", "for", "mr", "mrs", "ms"]);

/** Name-derived aliases: the full name plus each meaningful token, lowercased.
 *  Relationship aliases ("mum") are added explicitly when the user states them. */
export function generateAliases(canonicalName: string): string[] {
  const full = canonicalName.trim().toLowerCase();
  if (!full) return [];
  const tokens = full
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length > 1 && !STOP_ALIASES.has(t));
  return unique([full, ...tokens]);
}

export function withAlias(aliases: string[], alias: string): string[] {
  const a = alias.trim().toLowerCase();
  return a ? unique([...aliases, a]) : aliases;
}

/** Dice coefficient over character bigrams: a cheap, dependency-free fuzzy score
 *  in [0,1]. Mirrors what pg_trgm gives us server-side for the same purpose. */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  if (bx.length === 0 || by.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of bx) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of by) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (bx.length + by.length);
}

/** Best alias score for a query against one entity. */
export function scoreEntity(query: string, entity: Entity): number {
  let best = 0;
  for (const alias of entity.aliases) {
    const s = similarity(query, alias);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Resolve a free-text reference to a canonical entity.
 * - threshold: minimum score to consider a match at all (default 0.55).
 * - margin: if the 2nd-best is within this of the best, it's ambiguous (default 0.12).
 */
export function resolve(
  query: string,
  entities: Entity[],
  opts: { threshold?: number; margin?: number } = {},
): ResolveResult {
  const threshold = opts.threshold ?? 0.55;
  const margin = opts.margin ?? 0.12;
  const scored = entities
    .map((entity) => ({ entity, score: scoreEntity(query, entity) }))
    .filter((c) => c.score >= threshold)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { match: null, confidence: 0, ambiguous: false, candidates: [] };
  }
  const ambiguous =
    scored.length > 1 && scored[0].score - scored[1].score < margin;
  return {
    match: ambiguous ? null : scored[0].entity,
    confidence: scored[0].score,
    ambiguous,
    candidates: scored.slice(0, 3),
  };
}

/** Confidence that a new mention is the SAME entity as an existing one, from name
 *  similarity, whether they've co-occurred, and recency. Conservative by design. */
export function mergeConfidence(
  nameScore: number,
  coOccurred: boolean,
  ageMs: number,
): number {
  const recency = Math.max(0, 1 - ageMs / (1000 * 60 * 60 * 24 * 30)); // 30-day decay
  return Math.min(1, nameScore * 0.7 + (coOccurred ? 0.2 : 0) + recency * 0.1);
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}
