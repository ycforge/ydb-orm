/**
 * Batch-query limits (#86): single definition point of the chunk size for
 * IN (...) lists — used by persistence (fetchByColumnIn) and relations
 * (many-to-many join tables, eager/loading of relations).
 */

/**
 * Maximum number of values in a single IN (...) list.
 *
 * Why 500:
 * - YDB limits the query text length (default 10 KB) and the total size of
 *   the gRPC request parameters (~50 MB for parameters, but the query text
 *   is capped more strictly);
 * - each IN (...) element expands into its own placeholder `$pN`
 *   (~5–8 characters of SQL plus a separate request parameter), so a chunk
 *   of 500 values yields ~3–4 KB of SQL text — safely under the limit even
 *   with additional WHERE conditions;
 * - the value is aligned with the batching practice of the YDB CLI itself
 *   (default 1000 parameters per batch), but is more conservative.
 *
 * Large FK/PK lists are split into several sequential queries and the
 * results are merged without duplicates (see chunkInValues).
 */
export const MAX_IN_CLAUSE_VALUES = 500;

/**
 * Splits a list of values into chunks of MAX_IN_CLAUSE_VALUES (or an explicit size).
 * Element order is preserved; the last chunk may be smaller.
 */
import { valueIdentityKey } from './value-identity.js';
export function chunkInValues<T>(
  values: readonly T[],
  size: number = MAX_IN_CLAUSE_VALUES,
): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`Chunk size must be a positive integer, got ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * Deduplicates FK/PK values preserving the order of first occurrence.
 *
 * The deduplication key is the canonical value key (#174): scalars
 * (string/number/bigint/boolean) are compared by value, and Bytes and
 * Date are compared BY VALUE too — two equal `Uint8Array`s or two equal
 * `Date`s collapse into one value even though they are different objects.
 */
export function dedupeInValues<T>(values: readonly T[]): T[] {
  const hasObject = values.some(
    (value) => typeof value === 'object' && value !== null,
  );
  if (!hasObject) {
    // Fast path: all values are primitives (string/number/bigint/boolean/
    // null/undefined). Native Set semantics (SameValueZero with type
    // discrimination and -0/0 normalization) exactly match the canonical
    // value key of single-component primitives (#174), so serializing each
    // value is unnecessary.
    const seen = new Set<T>();
    const out: T[] = [];
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  }
  // Fallback: Bytes/Date present — value-based comparison requires a
  // canonical key.
  const seen = new Map<string, T>();
  for (const value of values) {
    const key = valueIdentityKey([value]);
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
}

/** Default safety row limit for SELECTs without an explicit limit (#133). */
export const DEFAULT_RETRIEVE_LIMIT = 100;

/** Maximum allowed row limit for a single SELECT. */
export const MAX_RETRIEVE_LIMIT = 1000;

/**
 * Resolves the effective LIMIT with explicit semantics (#133):
 * - limit not set — safety default DEFAULT_RETRIEVE_LIMIT;
 * - `0` — LIMIT 0 (empty result), NOT clamped to 1;
 * - positive integer — up to MAX_RETRIEVE_LIMIT (ceiling);
 * - negative, fractional or non-finite value — error.
 *
 * Single definition point of the semantics shared by the query builder and
 * persistence (#158): previously persistence silently clamped limit: 0 → 1
 * and negatives → 1.
 */
export function resolveRetrieveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_RETRIEVE_LIMIT;
  }
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) {
    throw new Error(
      `Invalid LIMIT: ${String(limit)}. LIMIT must be a finite non-negative integer.`,
    );
  }
  return Math.min(limit, MAX_RETRIEVE_LIMIT);
}

/**
 * Resolves the effective OFFSET: not set — 0; fractional values are floored;
 * negative values are clamped to 0.
 */
export function resolveRetrieveOffset(offset: number | undefined): number {
  const num = Number.isFinite(offset) ? Math.floor(offset as number) : 0;
  return Math.max(0, num);
}
