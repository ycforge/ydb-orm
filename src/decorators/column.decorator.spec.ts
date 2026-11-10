import 'reflect-metadata';
import type { YdbPrimitive } from '../core/types.js';
import { YdbColumn, YdbPrimaryColumn } from './column.decorator.js';

/** Column type is interpolated into DDL unquoted — it must be allowlisted. */
describe('YdbColumn type validation (runtime whitelist)', () => {
  it('accepts all YDB primitives and TTL numeric scheme types', () => {
    const t = target();

    const allowed = [
      'Uuid',
      'Utf8',
      'Bytes',
      'Int32',
      'Int64',
      'Bool',
      'Double',
      'Float',
      'Date',
      'Datetime',
      'Timestamp',
      'Json',
      'JsonDocument',
      'Uint32',
      'Uint64',
      'DyNumber',
    ];
    for (const [index, type] of allowed.entries()) {
      expect(() =>
        YdbColumn(type as YdbPrimitive)(t, `field_${index}`),
      ).not.toThrow();
    }
  });

  it('throws for a non-whitelisted type at decoration time', () => {
    const t = target();
    // The column type is interpolated into DDL unquoted — quotes, semicolons
    // and backticks must never survive validation.
    expect(() =>
      YdbColumn(
        'Utf8, PRIMARY KEY (`x`); DROP TABLE `secrets`; --' as unknown as YdbPrimitive,
      )(t, 'field_pwned'),
    ).toThrow(/invalid column type/);
  });

  it('YdbPrimaryColumn applies the same whitelist', () => {
    const t = target();
    expect(() =>
      YdbPrimaryColumn(
        'Int32; UPDATE ydb_migrations SET state = ' as unknown as YdbPrimitive,
      )(t, 'field_pk_pwned'),
    ).toThrow(/invalid column type/);
  });
});

/** A detached function object is enough of a decoration target. */
function target(): object {
  return function ClassProbe() {};
}
