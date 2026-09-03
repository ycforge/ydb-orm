import { YdbPrimitive } from './types.js';
import {
  Uuid,
  UuidType,
  Utf8,
  Utf8Type,
  Bytes,
  BytesType,
  Int32,
  Int32Type,
  Int64,
  Int64Type,
  Bool,
  BoolType,
  Double,
  DoubleType,
  Float,
  FloatType,
  Date as YdbDate,
  DateType,
  Datetime,
  DatetimeType,
  Timestamp,
  TimestampType,
  Json,
  JsonType,
  JsonDocument,
  JsonDocumentType,
} from '@ydbjs/value/primitive';
import { Optional } from '@ydbjs/value/optional';

/** Signed 32-bit integer bounds. */
const INT32_MIN = -2147483648; // -2^31
const INT32_MAX = 2147483647; // 2^31 - 1

/** Signed 64-bit integer bounds. */
const INT64_MIN = -9223372036854775808n; // -2^63
const INT64_MAX = 9223372036854775807n; // 2^63 - 1

/** YDB type constructors for null values (Optional<null>). */
const nullTypeFactories = {
  Uuid: () => new UuidType(),
  Utf8: () => new Utf8Type(),
  Bytes: () => new BytesType(),
  Int32: () => new Int32Type(),
  Int64: () => new Int64Type(),
  Bool: () => new BoolType(),
  Double: () => new DoubleType(),
  Float: () => new FloatType(),
  Date: () => new DateType(),
  Datetime: () => new DatetimeType(),
  Timestamp: () => new TimestampType(),
  Json: () => new JsonType(),
  JsonDocument: () => new JsonDocumentType(),
} satisfies Record<YdbPrimitive, () => unknown>;

/**
 * Safe string representation of a value for error messages:
 * does not expose contents of large strings and binary data.
 */
function valuePreview(value: unknown): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (typeof value === 'string') {
    return value.length > 64
      ? `"${value.slice(0, 64)}…(${value.length} chars)"`
      : JSON.stringify(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (ArrayBuffer.isView(value)) {
    return `<${value.constructor.name} length=${value.byteLength}>`;
  }
  switch (typeof value) {
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return `<function ${value.name ?? 'anonymous'}>`;
    default: {
      // Arbitrary object — show JSON, not "[object Object]".
      try {
        const json = JSON.stringify(value);
        if (json !== undefined) {
          return json.length > 64
            ? `${json.slice(0, 64)}…(${json.length} chars)`
            : json;
        }
      } catch {
        /* circular reference */
      }
      return '<object>';
    }
  }
}

/** Field name suffix for error messages (if field is specified). */
function fieldSuffix(field: string | undefined): string {
  return field ? ` (field "${field}")` : '';
}

/** Wraps a conversion error, adding context (field, type, value). */
function wrapConversionError(
  type: YdbPrimitive,
  value: unknown,
  field: string | undefined,
  err: unknown,
): TypeError {
  const detail = err instanceof Error ? err.message : String(err);
  return new TypeError(
    `Failed to convert value ${valuePreview(value)} to YDB type ${type}${fieldSuffix(field)}: ${detail}`,
  );
}

/**
 * Normalizes a JS date: accepts Date, number (epoch ms), or ISO string.
 *
 * Note (precision): JS `Date` stores only milliseconds. YDB `Timestamp` —
 * microseconds. Conversion is `getTime() * 1000n`, so sub-millisecond
 * values (micro-/nanoseconds) fundamentally cannot be preserved: they are
 * zeroed on write, and YDB microseconds lose the lower three digits on read.
 * Use `Timestamp` only for millisecond precision.
 */
function toJsDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Checks date validity; invalid values (Invalid Date) are rejected. */
function toValidJsDate(value: Date | number | string): Date {
  const date = toJsDate(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid Date value (${valuePreview(value)})`);
  }
  return date;
}

/** Wrappers of JS values into YDB values with type and range validation. */
const valueMappers: Record<YdbPrimitive, (value: any) => unknown> = {
  Uuid: (value: string) => new Uuid(value),
  Utf8: (value: string) => new Utf8(value),
  Bytes: (value: Uint8Array) => new Bytes(value),
  Int32: (value: number) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new TypeError(
        `Int32 value must be an integer, got ${valuePreview(value)}`,
      );
    }
    if (value < INT32_MIN || value > INT32_MAX) {
      throw new RangeError(
        `Int32 value ${value} is out of range [${INT32_MIN}, ${INT32_MAX}]`,
      );
    }
    return new Int32(value);
  },
  Int64: (value: bigint | number | string) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      // JS number is unsafe above Number.MAX_SAFE_INTEGER (2^53 - 1):
      // BigInt(value) would turn the already rounded number into a different BigInt.
      throw new TypeError(
        `Int64 value must be a safe integer, got ${valuePreview(value)} (use bigint or string for exact values above 2^53 - 1)`,
      );
    }
    let asBigInt: bigint;
    try {
      asBigInt = BigInt(value);
    } catch (err) {
      // BigInt() throws a raw RangeError for fractions/NaN — add context.
      throw new TypeError(
        `Int64 value must be an integer, got ${valuePreview(value)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (asBigInt < INT64_MIN || asBigInt > INT64_MAX) {
      throw new RangeError(`Int64 value ${asBigInt} is out of range`);
    }
    return new Int64(asBigInt);
  },
  Bool: (value: boolean) => new Bool(value),
  Double: (value: number) => new Double(value),
  Float: (value: number) => new Float(value),
  Date: (value: Date | number | string) => new YdbDate(toValidJsDate(value)),
  Datetime: (value: Date | number | string) =>
    new Datetime(toValidJsDate(value)),
  // See JSDoc `toJsDate` for millisecond precision of Timestamp.
  Timestamp: (value: Date | number | string) =>
    new Timestamp(toValidJsDate(value)),
  Json: (value: any) =>
    new Json(typeof value === 'string' ? value : JSON.stringify(value)),
  JsonDocument: (value: any) =>
    new JsonDocument(typeof value === 'string' ? value : JSON.stringify(value)),
};

/**
 * Converts a JS value to a YDB value.
 *
 * @param type target YDB type
 * @param value JS value (null → Optional<null>)
 * @param field field name for conversion error context (optional)
 */
export function mapToYdb(type: YdbPrimitive, value: unknown, field?: string) {
  const wrap = valueMappers[type];
  if (!wrap) {
    throw new Error(`Unsupported YDB type: ${type as string}`);
  }

  if (value === undefined) {
    throw new TypeError(
      `Undefined passed to YDB for type ${type}${fieldSuffix(field)}`,
    );
  }

  if (value === null) {
    return new Optional(null, nullTypeFactories[type]());
  }

  try {
    return wrap(value);
  } catch (err) {
    throw wrapConversionError(type, value, field, err);
  }
}
