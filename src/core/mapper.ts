import { YdbPrimitive } from './types.js';
import {
  Uuid,
  UuidType,
  Utf8,
  Utf8Type,
  Int32,
  Int32Type,
  Int64,
  Int64Type,
  Bool,
  BoolType,
  Double,
  DoubleType,
} from '@ydbjs/value/primitive';
import { Optional } from '@ydbjs/value/optional';

/** Конструкторы YDB-типов для null-значений (Optional<null>). */
const nullTypeFactories = {
  Uuid: () => new UuidType(),
  Utf8: () => new Utf8Type(),
  Int32: () => new Int32Type(),
  Int64: () => new Int64Type(),
  Bool: () => new BoolType(),
  Double: () => new DoubleType(),
} satisfies Record<YdbPrimitive, () => unknown>;

/** Обёртки JS-значений в YDB-значения. */
const valueMappers: Record<YdbPrimitive, (value: any) => unknown> = {
  Uuid: (value: string) => new Uuid(value),
  Utf8: (value: string) => new Utf8(value),
  Int32: (value: number) => new Int32(value),
  Int64: (value: bigint | number | string) => new Int64(BigInt(value)),
  Bool: (value: boolean) => new Bool(value),
  Double: (value: number) => new Double(value),
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
