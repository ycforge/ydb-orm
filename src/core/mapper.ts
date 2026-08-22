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

/** Границы знакового 32-битного целого. */
const INT32_MIN = -2147483648; // -2^31
const INT32_MAX = 2147483647; // 2^31 - 1

/** Границы знакового 64-битного целого. */
const INT64_MIN = -9223372036854775808n; // -2^63
const INT64_MAX = 9223372036854775807n; // 2^63 - 1

/**
 * Конструкторы YDB-типов для null-значений (Optional<null>).
 */
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
 * Безопасное строковое представление значения для сообщений об ошибках:
 * не раскрывает содержимое больших строк и бинарных данных.
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
      // Произвольный объект — показываем JSON, а не "[object Object]".
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

/** Суффикс имени поля для сообщения об ошибке (если поле указано). */
function fieldSuffix(field: string | undefined): string {
  return field ? ` (field "${field}")` : '';
}

/** Оборачивает ошибку конвертации, добавляя контекст (поле, тип, значение). */
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
 * Нормализация JS-даты: принимает Date, число (мс от эпохи) или ISO-строку.
 *
 * Внимание (точность): JS `Date` хранит только миллисекунды. YDB `Timestamp` —
 * микросекунды. Конвертация идёт как `getTime() * 1000n`, поэтому
 * субмиллисекундные значения (микро-/наносекунды) принципиально не могут быть
 * сохранены: при записи они обнуляются, при чтении YDB-микросекунды теряют
 * младшие три разряда. Используйте `Timestamp` только для миллисекундной
 * точности.
 */
function toJsDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Проверяет корректность даты; невалидные значения (Invalid Date) отклоняются. */
function toValidJsDate(value: Date | number | string): Date {
  const date = toJsDate(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid Date value (${valuePreview(value)})`);
  }
  return date;
}

/** Обёртки JS-значений в YDB-значения с валидацией типов и диапазонов. */
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
      // JS number небезопасен выше Number.MAX_SAFE_INTEGER (2^53 - 1):
      // BigInt(value) превратит уже округлённое число в другой BigInt.
      throw new TypeError(
        `Int64 value must be a safe integer, got ${valuePreview(value)} (use bigint or string for exact values above 2^53 - 1)`,
      );
    }
    let asBigInt: bigint;
    try {
      asBigInt = BigInt(value);
    } catch (err) {
      // BigInt() бросает сырой RangeError для дробных/NaN — добавим контекст.
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
  // См. JSDoc `toJsDate` про миллисекундную точность Timestamp.
  Timestamp: (value: Date | number | string) =>
    new Timestamp(toValidJsDate(value)),
  Json: (value: any) =>
    new Json(typeof value === 'string' ? value : JSON.stringify(value)),
  JsonDocument: (value: any) =>
    new JsonDocument(typeof value === 'string' ? value : JSON.stringify(value)),
};

/**
 * Преобразует JS-значение в YDB-значение.
 *
 * @param type целевой YDB-тип
 * @param value JS-значение (null → Optional<null>)
 * @param field имя поля для контекста ошибок конвертации (необязательно)
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
