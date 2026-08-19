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
} from '@ydbjs/value/primitive';
import { Optional } from '@ydbjs/value/optional';

/** Конструкторы YDB-типов для null-значений (Optional<null>). */
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
} satisfies Record<YdbPrimitive, () => unknown>;

/** Нормализация JS-даты: принимает Date, число (мс) или ISO-строку. */
function toJsDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Обёртки JS-значений в YDB-значения. */
const valueMappers: Record<YdbPrimitive, (value: any) => unknown> = {
  Uuid: (value: string) => new Uuid(value),
  Utf8: (value: string) => new Utf8(value),
  Bytes: (value: Uint8Array) => new Bytes(value),
  Int32: (value: number) => new Int32(value),
  Int64: (value: bigint | number | string) => new Int64(BigInt(value)),
  Bool: (value: boolean) => new Bool(value),
  Double: (value: number) => new Double(value),
  Float: (value: number) => new Float(value),
  Date: (value: Date | number | string) => new YdbDate(toJsDate(value)),
  Datetime: (value: Date | number | string) => new Datetime(toJsDate(value)),
  Timestamp: (value: Date | number | string) => new Timestamp(toJsDate(value)),
};

export function mapToYdb(type: YdbPrimitive, value: unknown) {
  const wrap = valueMappers[type];
  if (!wrap) {
    throw new Error(`Unsupported YDB type: ${type as string}`);
  }

  if (value === undefined) {
    throw new Error(`Undefined passed to YDB for type ${type}`);
  }

  if (value === null) {
    return new Optional(null, nullTypeFactories[type]());
  }

  return wrap(value);
}
