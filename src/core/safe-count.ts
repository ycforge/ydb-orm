/**
 * Безопасное приведение результата COUNT(*) (#245).
 *
 * YDB возвращает YQL-тип Int64, который в драйвере может прийти как `bigint`,
 * `number` либо `string`. Публичный API `count()` типизирован как
 * `Promise<number>`, поэтому значение выше `Number.MAX_SAFE_INTEGER`
 * (2^53 - 1) не может быть представлено точно. Вместо молчаливого округления
 * такое значение отклоняется явной ошибкой.
 */

/** Верхняя граница безопасных целых: 2^53 - 1. */
const MAX_SAFE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

/** Нижняя граница безопасных целых: -(2^53 - 1). */
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
 * Приводит результат COUNT(*) к безопасному `number`.
 *
 * - `undefined`/`null` — `0` (текущее поведение по умолчанию);
 * - `bigint` — точное сравнение с границей 2^53 - 1;
 * - `number` — принимается только безопасное целое;
 * - `string` — парсится как целое (`bigint`, с фолбэком на `number`).
 *
 * Значение вне безопасного диапазона отклоняется ошибкой — молчаливого
 * округления нет.
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
