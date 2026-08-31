import 'reflect-metadata';
import { YdbPrimitive } from '../core/types.js';

/** Metadata key for table TTL (`@YdbTtl`). */
export const YDB_TTL_KEY = 'ydb:ttl';

/**
 * Unit of measure for a numeric TTL column (AS <unit> in YQL).
 * Required for integer columns, forbidden for Date/Datetime/Timestamp.
 */
export type YdbTtlUnit =
  'seconds' | 'milliseconds' | 'microseconds' | 'nanoseconds';

const TTL_UNITS: readonly YdbTtlUnit[] = [
  'seconds',
  'milliseconds',
  'microseconds',
  'nanoseconds',
];

/** Column types usable as TTL without specifying a unit. */
const DATE_LIKE_TTL_TYPES: readonly YdbPrimitive[] = [
  'Date',
  'Datetime',
  'Timestamp',
];

/**
 * Numeric TTL column types per YDB constraints (the value is treated as
 * Unix time and requires a unit). Only unsigned: signed Int32/Int64 are not
 * accepted by YDB for TTL.
 */
const NUMERIC_TTL_TYPES: readonly string[] = ['Uint32', 'Uint64', 'DyNumber'];

/** ISO 8601 duration (for example, "PT2H", "P30D", "P1DT2H30M"). */
const ISO_DURATION_RE =
  /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

/** Microseconds in a second — the internal precision of the YDB Interval type. */
export const MICROSECONDS_PER_SECOND = 1_000_000;

/** Strict per-component ISO 8601 duration parse (for TTL comparison). */
const ISO_DURATION_PARSE_RE =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const MICROS_PER = {
  day: 86_400 * MICROSECONDS_PER_SECOND,
  hour: 3_600 * MICROSECONDS_PER_SECOND,
  minute: 60 * MICROSECONDS_PER_SECOND,
};

/** Result of parsing an ISO duration. */
interface IsoDurationParse {
  /** The duration in whole microseconds (no fraction past µs). */
  micros: bigint;
  /** Has significant fractional digits beyond microseconds. */
  subMicroRemainder: boolean;
}

/**
 * Parses an ISO 8601 duration by component with exact integer arithmetic.
 * Returns null for invalid strings and for intervals with calendar parts
 * (years/months): they have no fixed length and are not supported by the YDB
 * Interval type.
 */
function parseIsoDuration(iso: string): IsoDurationParse | null {
  const match = ISO_DURATION_PARSE_RE.exec(iso);
  if (!match) return null;
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  if (years || months) return null;

  // A fractional part is only allowed on seconds; parse it digit by digit so
  // precision is not lost on float ("0.1" * 10 !== 1).
  const [wholeSeconds = '0', fracSeconds = ''] = (seconds ?? '').split('.');
  let micros =
    BigInt(weeks ?? 0) * 7n * BigInt(MICROS_PER.day) +
    BigInt(days ?? 0) * BigInt(MICROS_PER.day) +
    BigInt(hours ?? 0) * BigInt(MICROS_PER.hour) +
    BigInt(minutes ?? 0) * BigInt(MICROS_PER.minute) +
    BigInt(wholeSeconds || '0') * BigInt(MICROSECONDS_PER_SECOND);
  if (fracSeconds) {
    micros += BigInt((fracSeconds + '000000').slice(0, 6));
  }
  return { micros, subMicroRemainder: /[1-9]/.test(fracSeconds.slice(6)) };
}

/**
 * Converts an ISO 8601 duration to a whole number of microseconds — the
 * internal unit of the YDB Interval type ("PT2H" → 720000000, "PT0.5S" → 500000).
 * The fraction is computed exactly (no floating point); digits after
 * microseconds are dropped deterministically — YDB Interval stores at most 6
 * digits. Use isoDurationToMicrosecondsExact for TTL comparison: truncation
 * hides divergences.
 */
export function isoDurationToMicroseconds(iso: string): number | null {
  const parsed = parseIsoDuration(iso);
  return parsed === null ? null : Number(parsed.micros);
}

/**
 * The strict variant of isoDurationToMicroseconds: returns null for
 * intervals not representable exactly in a YDB Interval — calendar parts and
 * a fractional part finer than microseconds ("PT0.0000001S"). Used when
 * comparing TTL so that an unrepresentable interval does not "match" a DB
 * value after silent truncation.
 */
export function isoDurationToMicrosecondsExact(iso: string): number | null {
  const parsed = parseIsoDuration(iso);
  return parsed !== null && !parsed.subMicroRemainder
    ? Number(parsed.micros)
    : null;
}

/**
 * Reverse conversion of a whole number of microseconds into an ISO 8601
 * duration — the exact inverse of `isoDurationToMicroseconds` (500000 →
 * "PT0.5S", 720000000 → "PT2H", 90000000000 → "P1DT1H"). Used to restore
 * the actual TTL settings from the DB in down-migrations and divergence
 * reports; the fractional part is rendered without losing YDB's
 * microsecond precision.
 */
export function microsecondsToIsoDuration(totalMicros: number): string {
  const micros = Math.max(0, Math.trunc(totalMicros));
  const days = Math.floor(micros / MICROS_PER.day);
  let rest = micros % MICROS_PER.day;
  const hours = Math.floor(rest / MICROS_PER.hour);
  rest %= MICROS_PER.hour;
  const minutes = Math.floor(rest / MICROS_PER.minute);
  rest %= MICROS_PER.minute;
  const wholeSeconds = Math.floor(rest / MICROSECONDS_PER_SECOND);
  const fracMicros = rest % MICROSECONDS_PER_SECOND;

  let duration = 'P';
  if (days) duration += `${days}D`;
  let time = '';
  if (hours) time += `${hours}H`;
  if (minutes) time += `${minutes}M`;
  if (wholeSeconds || fracMicros) {
    let secondsText = String(wholeSeconds);
    if (fracMicros) {
      secondsText += `.${String(fracMicros).padStart(6, '0').replace(/0+$/, '')}`;
    }
    time += `${secondsText}S`;
  }
  if (time) duration += `T${time}`;
  return duration === 'P' ? 'PT0S' : duration;
}

/**
 * Converts an ISO 8601 duration to seconds ("PT2H" → 7200, "P30D" → 2592000).
 * Returns null for intervals with calendar parts (years/months). Fractional
 * seconds yield a fractional result — TTL comparison is done via
 * isoDurationToMicroseconds; this function remains for convenience.
 */
export function isoDurationToSeconds(iso: string): number | null {
  const micros = isoDurationToMicroseconds(iso);
  return micros === null ? null : micros / MICROSECONDS_PER_SECOND;
}

/**
 * Converts a whole number of seconds (the expire_after_seconds format from
 * DescribeTable) into an ISO 8601 duration (7200 → "PT2H", 90000 → "P1DT1H").
 * The fractional part is rounded to seconds; for values with subsecond parts
 * use microsecondsToIsoDuration.
 */
export function secondsToIsoDuration(totalSeconds: number): string {
  return microsecondsToIsoDuration(
    Math.round(totalSeconds) * MICROSECONDS_PER_SECOND,
  );
}

export interface YdbTtlOptions {
  /** ISO 8601 duration (e.g., "PT2H", "P30D", "PT1H"). */
  interval: string;
  /**
   * Column for TTL — must be declared via @YdbColumn.
   * Per YDB constraints, column type: Date/Datetime/Timestamp or
   * numeric Uint32/Uint64/DyNumber (treated as Unix time,
   * then unit is required). Signed Int32/Int64 not accepted by YDB.
   * No defaults: column must be specified explicitly (see issue #81).
   */
  column: string;
  /**
   * Unit for numeric TTL column (AS <unit>), e.g., 'seconds'.
   * Required for Uint32/Uint64/DyNumber, forbidden for date types.
   */
  unit?: YdbTtlUnit;
}

export interface YdbTtlMetadata {
  interval: string;
  column: string;
  unit?: YdbTtlUnit;
}

/**
 * Declarative table TTL (YDB table TTL).
 * Can be applied only once per class.
 * Generates WITH (TTL = Interval(...) ON column) section after CREATE TABLE (...).
 *
 * Inheritance semantics (#92): TTL is bound to the table of the class on which
 * it is declared and is NOT inherited along the prototype chain — a class with
 * its own @YdbEntity declares its own TTL explicitly (or has none), so the
 * parent's TTL on a foreign column does not leak into the child table's DDL.
 * Re-application on a subclass is allowed: the "once" guard looks only at
 * the class's own metadata and does not count the parent's TTL as its own.
 *
 * Format errors (interval, column, unit) are thrown immediately at decoration.
 * Entity schema errors (unknown column, incompatible type,
 * extra/missing unit) are detected at module initialization
 * (validateEntityMetadata) and during schema building (buildExpectedTableSchema) —
 * before DDL generation, see issue #81.
 *
 * @example
 *   @YdbEntity('sessions')
 *   @YdbTtl({ interval: 'PT2H', column: 'expires_at', unit: 'seconds' })
 *   class SessionEntity extends YdbBaseEntity { ... }
 * @param options - TTL options: interval, column, optional unit.
 * @returns Class decorator function.
 * @throws If already applied to the same class.
 */
export function YdbTtl(options: YdbTtlOptions): ClassDecorator {
  return (target) => {
    // Only the class's own metadata (#92): parent TTL must not
    // block declaration of own TTL on subclass.
    const existing = Reflect.getOwnMetadata(YDB_TTL_KEY, target);
    if (existing) {
      throw new Error(
        `@YdbTtl can only be applied once to class "${target.name}"`,
      );
    }
    validateYdbTtlOptions(target.name, options);
    Reflect.defineMetadata(YDB_TTL_KEY, options, target);
  };
}

/**
 * The class's own TTL (not inherited from parent, #92).
 *
 * @param target - Entity class constructor.
 * @returns TTL metadata or undefined.
 */
export function getYdbTtlMetadata(
  target: new (...args: any[]) => any,
): YdbTtlMetadata | undefined {
  return Reflect.getOwnMetadata(YDB_TTL_KEY, target);
}

/**
 * Validates decorator options without considering entity schema (called from @YdbTtl).
 *
 * @param className - Name of the entity class.
 * @param options - TTL options to validate.
 * @throws If options are invalid.
 */
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
  if (parseIsoDuration(options.interval)?.subMicroRemainder) {
    throw new Error(
      `@YdbTtl on class "${className}": interval "${options.interval}" is ` +
        `more precise than a microsecond — YDB Interval supports only integer ` +
        `microseconds (up to 6 fractional second digits)`,
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
 * Validates TTL metadata against entity column schema per YDB constraints:
 * column must exist and have type Date/Datetime/Timestamp (without unit)
 * or Uint32/Uint64/DyNumber (only with unit). Signed Int32/Int64 not accepted
 * by YDB for TTL.
 *
 * Returns list of issues (empty if all OK) — pure function,
 * used by validateEntityMetadata and buildExpectedTableSchema.
 *
 * @param entityName - Entity name for error messages.
 * @param ttl - TTL metadata.
 * @param columns - Entity column schema.
 * @returns Array of issue strings.
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
