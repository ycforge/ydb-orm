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
 * Значения — примитивы YDB (string/number/bigint/boolean/Uint8Array):
 * Set сравнивает их по значению (SameValueZero, включая bigint).
 */
export function dedupeInValues<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
