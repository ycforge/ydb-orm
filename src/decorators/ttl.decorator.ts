import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';

export const YDB_TTL_KEY = 'ydb:ttl';

/**
 * Единица измерения числовой TTL-колонки (AS <unit> в YQL).
 * Обязательна для целочисленных колонок, запрещена для Date/Datetime/Timestamp.
 */
export type YdbTtlUnit =
  'seconds' | 'milliseconds' | 'microseconds' | 'nanoseconds';

const TTL_UNITS: readonly YdbTtlUnit[] = [
  'seconds',
  'milliseconds',
  'microseconds',
  'nanoseconds',
];

/** Типы колонок, которые можно использовать как TTL без указания unit. */
const DATE_LIKE_TTL_TYPES: readonly YdbPrimitive[] = [
  'Date',
  'Datetime',
  'Timestamp',
];

/** Целочисленные типы, допустимые для TTL только с AS <unit>. */
const NUMERIC_TTL_TYPES: readonly YdbPrimitive[] = ['Int32', 'Int64'];

/** ISO 8601 duration (например, "PT2H", "P30D", "P1DT2H30M"). */
const ISO_DURATION_RE =
  /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

export interface YdbTtlOptions {
  /** ISO 8601 duration (например, "PT2H", "P30D", "PT1H"). */
  interval: string;
  /**
   * Колонка для TTL — должна быть объявлена через @YdbColumn и иметь
   * тип Date/Datetime/Timestamp либо целочисленный (тогда обязателен unit).
   */
  column: string;
  /** Единица измерения числовой TTL-колонки (AS <unit>), например 'seconds'. */
  unit?: YdbTtlUnit;
}

export interface YdbTtlMetadata {
  interval: string;
  column: string;
  unit?: YdbTtlUnit;
}

/**
 * Декларативный TTL таблицы (YDB table TTL).
 * Можно применить только один раз на класс.
 * Генерирует секцию WITH (TTL = Interval(...) ON column) после CREATE TABLE (...).
 *
 * @example
 *   @YdbEntity('sessions')
 *   @YdbTtl({ interval: 'PT2H', column: 'expires_at', unit: 'seconds' })
 *   class SessionEntity extends YdbBaseEntity { ... }
 */
export function YdbTtl(options: YdbTtlOptions): ClassDecorator {
  return (target) => {
    const existing = Reflect.getMetadata(YDB_TTL_KEY, target);
    if (existing) {
      throw new Error(
        `@YdbTtl can only be applied once to class "${target.name}"`,
      );
    }
    validateYdbTtlOptions(target.name, options);
    Reflect.defineMetadata(YDB_TTL_KEY, options, target);
  };
}

export function getYdbTtlMetadata(
  target: new (...args: any[]) => any,
): YdbTtlMetadata | undefined {
  return Reflect.getMetadata(YDB_TTL_KEY, target);
}

/** Проверяет опции декоратора без учёта схемы сущности (вызывается из @YdbTtl). */
function validateYdbTtlOptions(
  className: string,
  options: YdbTtlOptions,
): void {
  if (!options?.interval || !ISO_DURATION_RE.test(options.interval)) {
    throw new Error(
      `@YdbTtl on class "${className}": ` +
        `interval must be a valid ISO 8601 duration (e.g. "PT2H", "P30D"), ` +
        `got "${options?.interval}"`,
    );
  }
  if (!options.column || typeof options.column !== 'string') {
    throw new Error(
      `@YdbTtl on class "${className}": ` +
        `"column" is required — specify an existing Date/Datetime/Timestamp ` +
        `(or integer with "unit") column explicitly`,
    );
  }
  if (options.unit !== undefined && !TTL_UNITS.includes(options.unit)) {
    throw new Error(
      `@YdbTtl on class "${className}": invalid unit "${String(options.unit)}" — ` +
        `expected one of: ${TTL_UNITS.join(', ')}`,
    );
  }
}

/**
 * Проверяет TTL-метаданные против схемы колонок сущности.
 * Возвращает список проблем (пустой, если всё в порядке) — чистая функция,
 * используется validateEntityMetadata и buildExpectedTableSchema.
 */
export function validateYdbTtlAgainstSchema(
  entityName: string,
  ttl: YdbTtlMetadata,
  columns: Record<string, YdbPrimitive>,
): string[] {
  const issues: string[] = [];
  const type = columns[ttl.column];

  if (!type) {
    issues.push(
      `entity "${entityName}": @YdbTtl column "${ttl.column}" ` +
        `is not declared via @YdbColumn`,
    );
    return issues;
  }

  if (DATE_LIKE_TTL_TYPES.includes(type)) {
    if (ttl.unit !== undefined) {
      issues.push(
        `entity "${entityName}": @YdbTtl unit cannot be specified ` +
          `for ${type} column "${ttl.column}"`,
      );
    }
    return issues;
  }

  if (NUMERIC_TTL_TYPES.includes(type)) {
    if (!ttl.unit) {
      issues.push(
        `entity "${entityName}": @YdbTtl requires "unit" ` +
          `(e.g. { unit: 'seconds' }) for numeric column "${ttl.column}" of type ${type}`,
      );
    }
    return issues;
  }

  issues.push(
    `entity "${entityName}": @YdbTtl column "${ttl.column}" has unsupported type ` +
      `${type} — use Date/Datetime/Timestamp or Int32/Int64 with "unit"`,
  );
  return issues;
}
