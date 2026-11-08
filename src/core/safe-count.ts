/**
 * Safe conversion of a COUNT(*) result (#245).
 *
 * YDB returns the YQL Int64 type, which the driver may expose as `bigint`,
 * `number` or `string`. The public `count()` API is typed as
 * `Promise<number>`, so a value above `Number.MAX_SAFE_INTEGER` (2^53 - 1)
 * cannot be represented exactly. Instead of silently rounding, such a value
 * is rejected with an explicit error.
 */

/** Upper bound of safe integers: 2^53 - 1. */
const MAX_SAFE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

/** Lower bound of safe integers: -(2^53 - 1). */
const MIN_SAFE_COUNT = -MAX_SAFE_COUNT;

function unsafeCountError(value: bigint, source: string): Error {
  return new Error(
    `COUNT(*) result ${value.toString()} (${source}) exceeds the safe integer ` +
      `range ±${Number.MAX_SAFE_INTEGER}. count() returns a JavaScript number ` +
      `and cannot represent this value exactly; narrow the query with a WHERE ` +
      `clause or aggregate fewer rows.`,
  );
}

function invalidCountError(value: unknown): Error {
  return new Error(
    `COUNT(*) result ${JSON.stringify(value, bigintReplacer)} is not a valid integer count.`,
  );
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Converts a COUNT(*) result into a safe `number`.
 *
 * - `undefined`/`null` — `0` (the current default behavior);
 * - `bigint` — exact comparison against the 2^53 - 1 boundary;
 * - `number` — only a safe integer is accepted;
 * - `string` — parsed as an integer (`bigint`, with a `number` fallback);
 *   an empty or whitespace-only string is invalid, not zero.
 *
 * A value outside the safe range is rejected with an error — there is no
 * silent rounding.
 */
export function toSafeCount(value: unknown): number {
  if (value === undefined || value === null) return 0;

  const source = typeof value;
  let count: bigint;

  if (typeof value === 'bigint') {
    count = value;
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw invalidCountError(value);
    }
    count = BigInt(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // BigInt('') is 0n, which would silently turn a malformed driver response
    // into a zero count.
    if (trimmed === '') throw invalidCountError(value);
    try {
      count = BigInt(trimmed);
    } catch {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) return parsed;
      throw invalidCountError(value);
    }
  } else {
    throw invalidCountError(value);
  }

  if (count > MAX_SAFE_COUNT || count < MIN_SAFE_COUNT) {
    throw unsafeCountError(count, source);
  }
  return Number(count);
}
