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

/**
 * Числовые типы TTL-колонок по ограничениям YDB (значение трактуется как
 * Unix-время и требует указания unit). Только беззнаковые: знаковые
 * Int32/Int64 YDB для TTL не принимает.
 */
const NUMERIC_TTL_TYPES: readonly string[] = ['Uint32', 'Uint64', 'DyNumber'];

/** ISO 8601 duration (например, "PT2H", "P30D", "P1DT2H30M"). */
const ISO_DURATION_RE =
  /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

/** Строгий разбор ISO 8601 duration по компонентам (для сравнения TTL). */
const ISO_DURATION_PARSE_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const SECONDS_PER = {
  day: 86400,
  hour: 3600,
  minute: 60,
};

/**
 * Приводит ISO 8601 duration к секундам ("PT2H" → 7200, "P30D" → 2592000).
 * Возвращает null для интервалов с календарными частями (годы/месяцы):
 * у них нет фиксированной длины, надёжно сравнить их с секундами из
 * DescribeTable нельзя.
 */
export function isoDurationToSeconds(iso: string): number | null {
  const match = ISO_DURATION_PARSE_RE.exec(iso);
  if (!match) return null;
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  if (years || months) return null;
  return (
    Number(weeks ?? 0) * 7 * SECONDS_PER.day +
    Number(days ?? 0) * SECONDS_PER.day +
    Number(hours ?? 0) * SECONDS_PER.hour +
    Number(minutes ?? 0) * SECONDS_PER.minute +
    Number(seconds ?? 0)
  );
}

/**
 * Обратное преобразование секунд в ISO 8601 duration — используется для
 * восстановления фактических настроек TTL из БД в down-миграциях
 * и сообщениях о расхождениях (7200 → "PT2H", 90000 → "P1DT1H").
 */
export function secondsToIsoDuration(totalSeconds: number): string {
  let rest = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(rest / SECONDS_PER.day);
  rest -= days * SECONDS_PER.day;
  const hours = Math.floor(rest / SECONDS_PER.hour);
  rest -= hours * SECONDS_PER.hour;
  const minutes = Math.floor(rest / SECONDS_PER.minute);
  const seconds = rest - minutes * SECONDS_PER.minute;

  let duration = 'P';
  if (days) duration += `${days}D`;
  const time =
    `${hours ? `${hours}H` : ''}` +
    `${minutes ? `${minutes}M` : ''}` +
    `${seconds ? `${seconds}S` : ''}`;
  if (time) duration += `T${time}`;
  return duration === 'P' ? 'PT0S' : duration;
}

export interface YdbTtlOptions {
  /** ISO 8601 duration (например, "PT2H", "P30D", "PT1H"). */
  interval: string;
  /**
   * Колонка для TTL — должна быть объявлена через @YdbColumn.
   * По ограничениям YDB тип колонки: Date/Datetime/Timestamp либо
   * числовой Uint32/Uint64/DyNumber (трактуется как Unix-время,
   * тогда обязателен unit). Знаковые Int32/Int64 YDB не допускает.
   * Дефолтов нет: колонка указывается явно (см. issue #81).
   */
  column: string;
  /**
   * Единица измерения числовой TTL-колонки (AS <unit>), например 'seconds'.
   * Обязательна для Uint32/Uint64/DyNumber, запрещена для дат.
   */
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
 * Ошибки формата (interval, column, unit) бросаются сразу при декорировании.
 * Ошибки относительно схемы сущности (неизвестная колонка, несовместимый тип,
 * лишний/недостающий unit) обнаруживаются при инициализации модуля
 * (validateEntityMetadata) и при построении схемы (buildExpectedTableSchema) —
 * до генерации DDL, см. issue #81.
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
 * Проверяет TTL-метаданные против схемы колонок сущности по ограничениям YDB:
 * колонка должна существовать и иметь тип Date/Datetime/Timestamp (без unit)
 * либо Uint32/Uint64/DyNumber (только с unit). Знаковые Int32/Int64 YDB
 * для TTL не принимает.
 *
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
      `${type} — YDB TTL requires Date/Datetime/Timestamp or ` +
      `numeric Uint32/Uint64/DyNumber with "unit"`,
  );
  return issues;
}
