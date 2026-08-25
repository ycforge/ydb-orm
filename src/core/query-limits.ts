/**
 * Лимиты батч-запросов (#86): единая точка определения размера чанка
 * для IN (...) списков — используется persistence (fetchByColumnIn)
 * и relations (join-таблицы many-to-many, eager/loading связей).
 */

/**
 * Максимальное количество значений в одном IN (...) списке.
 *
 * Почему именно 500:
 * - у YDB есть лимит на длину текста запроса (по умолчанию 10 KB) и
 *   суммарный размер параметров gRPC-запроса (~50 MB на параметры,
 *   но текст запроса ограничен жёстче);
 * - каждый элемент IN (...) разворачивается в отдельный плейсхолдер `$pN`
 *   (~5–8 символов текста + отдельный параметр запроса), поэтому чанк из
 *   500 значений даёт ~3–4 KB SQL-текста — с запасом до лимита даже при
 *   дополнительных WHERE-условиях;
 * - значение согласовано с практикой батчинга самого YDB CLI
 *   (дефолт 1000 параметров на batch), но консервативнее.
 *
 * Большие списки FK/PK режутся на несколько последовательных запросов,
 * результаты объединяются без дубликатов (см. chunkInValues).
 */
export const MAX_IN_CLAUSE_VALUES = 500;

/**
 * Режет список значений на чанки по MAX_IN_CLAUSE_VALUES (или явному size).
 * Порядок элементов сохраняется; последний чанк может быть меньше.
 */
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
 * Дедупликация значений FK/PK с сохранением порядка первого вхождения.
 * Set сравнивает по SameValueZero: скаляры (string/number/bigint/boolean)
 * дедуплицируются по значению, а объекты (Uint8Array и т.п.) — по ссылке,
 * поэтому бинарные значения дедуплицируются только при повторе той же
 * ссылки (для FK/PK-потоков это приемлемо).
 */
export function dedupeInValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Защитный лимит строк по умолчанию для SELECT без явного limit (#133). */
export const DEFAULT_RETRIEVE_LIMIT = 100;

/** Максимально допустимый лимит строк в одном SELECT. */
export const MAX_RETRIEVE_LIMIT = 1000;

/**
 * Итоговый LIMIT с явной семантикой (#133):
 * - лимит не задан — защитный дефолт DEFAULT_RETRIEVE_LIMIT;
 * - `0` — LIMIT 0 (пустой результат), НЕ клампится в 1;
 * - положительное целое значение — до MAX_RETRIEVE_LIMIT (потолок);
 * - отрицательное, дробное или неконечное значение — ошибка.
 *
 * Единая точка семантики для query-builder и persistence (#158): раньше
 * persistence молча клампил limit: 0 → 1 и отрицательные → 1.
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
 * Итоговый OFFSET: не задан — 0; дробное округляется вниз;
 * отрицательное клампится в 0.
 */
export function resolveRetrieveOffset(offset: number | undefined): number {
  const num = Number.isFinite(offset) ? Math.floor(offset as number) : 0;
  return Math.max(0, num);
}
