import 'reflect-metadata';
import { YdbEntity } from '../src/decorators/entity.decorator.js';
import {
  YdbPrimaryColumn,
  YdbColumn,
} from '../src/decorators/column.decorator.js';
import { YdbBaseEntity } from '../src/entity/base-entity.js';
import {
  YdbTtl,
  getYdbTtlMetadata,
  isoDurationToMicroseconds,
  isoDurationToMicrosecondsExact,
  isoDurationToSeconds,
  microsecondsToIsoDuration,
  secondsToIsoDuration,
  validateYdbTtlAgainstSchema,
} from '../src/decorators/ttl.decorator.js';
import {
  buildExpectedTableSchema,
  checkTableSchema,
  generateCreateTableYql,
  generateSetTtlYql,
  generateTtlWithClause,
  ExpectedTableSchema,
  YdbTableDescription,
} from '../src/schema/schema-sync.js';
import { YdbPrimitive } from '../src/core/types.js';
import {
  validateEntityMetadata,
  validationIssuesToMessages,
} from '../src/metadata/validate-entity.js';
import { getYdbEntityMetadata } from '../src/metadata/entity-metadata.js';

const meta = (entity: new (...args: any[]) => any) => {
  const m = getYdbEntityMetadata(entity);
  if (!m) throw new Error('no metadata');
  return m;
};

const validationCtx = {
  encryptionProviderConfigured: true,
  blindIndexProviderConfigured: true,
};

/**
 * Uint32/Uint64/DyNumber пока не входят в YdbPrimitive (отдельная задача),
 * поэтому для тестов числовых TTL-колонок схема колонок приводится напрямую.
 */
const cols = (o: Record<string, string>) =>
  o as unknown as Record<string, YdbPrimitive>;

@YdbEntity('ttl_sessions')
@YdbTtl({ interval: 'PT2H', column: 'expires_at' })
class TtlSessionEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  token: string;

  @YdbColumn('Datetime')
  expires_at: string;
}

// Знаковые Int64 YDB для TTL не принимает (только Uint32/Uint64/DyNumber)
@YdbEntity('ttl_signed_numeric')
@YdbTtl({ interval: 'P30D', column: 'expires_at', unit: 'seconds' })
class TtlSignedNumericEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Int64')
  expires_at: bigint;
}

@YdbEntity('no_ttl_entity')
class NoTtlEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;
}

class TtlDuplicateEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;
}

describe('@YdbTtl', () => {
  it('stores TTL metadata on class', () => {
    const ttl = getYdbTtlMetadata(TtlSessionEntity);
    expect(ttl).toEqual({ interval: 'PT2H', column: 'expires_at' });
  });

  it('stores TTL with unit as provided', () => {
    const ttl = getYdbTtlMetadata(TtlSignedNumericEntity);
    expect(ttl).toEqual({
      interval: 'P30D',
      column: 'expires_at',
      unit: 'seconds',
    });
  });

  it('returns undefined for entity without TTL', () => {
    const ttl = getYdbTtlMetadata(NoTtlEntity);
    expect(ttl).toBeUndefined();
  });

  it('throws when applied twice to the same class', () => {
    // Apply first @YdbTtl — should succeed
    YdbTtl({ interval: 'PT2H', column: 'uuid' })(TtlDuplicateEntity);
    expect(getYdbTtlMetadata(TtlDuplicateEntity)).toEqual({
      interval: 'PT2H',
      column: 'uuid',
    });

    // Apply second @YdbTtl — should throw
    expect(() => {
      YdbTtl({ interval: 'P1D', column: 'uuid' })(TtlDuplicateEntity);
    }).toThrow(/can only be applied once/);
  });

  it('throws when column is not specified (no default to PK)', () => {
    class TtlNoColumnEntity extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid: string;
    }
    expect(() => {
      (YdbTtl as (options: any) => ClassDecorator)({ interval: 'PT2H' })(
        TtlNoColumnEntity,
      );
    }).toThrow(/"column" is required/);
  });

  it('throws on invalid interval format', () => {
    class TtlBadIntervalEntity extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid: string;
    }
    expect(() => {
      YdbTtl({ interval: '2 hours', column: 'uuid' })(TtlBadIntervalEntity);
    }).toThrow(/ISO 8601 duration/);
  });

  it('throws on unknown unit', () => {
    class TtlBadUnitEntity extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid: string;
    }
    expect(() => {
      (YdbTtl as (options: any) => ClassDecorator)({
        interval: 'PT1H',
        column: 'expires_at',
        unit: 'weeks',
      })(TtlBadUnitEntity);
    }).toThrow(/invalid unit/);
  });
});

describe('validateYdbTtlAgainstSchema', () => {
  it('accepts Datetime column without unit', () => {
    expect(
      validateYdbTtlAgainstSchema(
        'E',
        { interval: 'PT2H', column: 'expires_at' },
        cols({ expires_at: 'Datetime' }),
      ),
    ).toEqual([]);
  });

  it('accepts Date and Timestamp columns without unit', () => {
    expect(
      validateYdbTtlAgainstSchema(
        'E',
        { interval: 'P1D', column: 'd' },
        cols({ d: 'Date' }),
      ),
    ).toEqual([]);
    expect(
      validateYdbTtlAgainstSchema(
        'E',
        { interval: 'PT1H', column: 'ts' },
        cols({ ts: 'Timestamp' }),
      ),
    ).toEqual([]);
  });

  it.each(['Uint32', 'Uint64', 'DyNumber'])(
    'requires unit for numeric %s column',
    (type) => {
      const issues = validateYdbTtlAgainstSchema(
        'E',
        { interval: 'PT2H', column: 'created_at' },
        cols({ created_at: type }),
      );
      expect(issues).toEqual([expect.stringContaining('requires "unit"')]);
    },
  );

  it.each([
    ['Uint32', 'seconds'],
    ['Uint64', 'milliseconds'],
    ['DyNumber', 'nanoseconds'],
  ] as const)('accepts numeric %s column with unit %s', (type, unit) => {
    expect(
      validateYdbTtlAgainstSchema(
        'E',
        { interval: 'PT2H', column: 'created_at', unit },
        cols({ created_at: type }),
      ),
    ).toEqual([]);
  });

  it('rejects signed Int64 column (YDB TTL allows only unsigned numerics)', () => {
    const issues = validateYdbTtlAgainstSchema(
      'E',
      { interval: 'PT2H', column: 'created_at', unit: 'seconds' },
      cols({ created_at: 'Int64' }),
    );
    expect(issues).toEqual([
      expect.stringContaining(
        'unsupported type Int64 — YDB TTL requires Date/Datetime/Timestamp or numeric Uint32/Uint64/DyNumber',
      ),
    ]);
  });

  it('rejects unknown TTL column', () => {
    expect(
      validateYdbTtlAgainstSchema(
        'E',
        { interval: 'PT2H', column: 'missing' },
        cols({ created_at: 'Datetime' }),
      ),
    ).toEqual([expect.stringContaining('"missing" is not declared')]);
  });

  it('forbids unit for Date-like column', () => {
    expect(
      validateYdbTtlAgainstSchema(
        'E',
        { interval: 'PT2H', column: 'created_at', unit: 'seconds' },
        cols({ created_at: 'Timestamp' }),
      ),
    ).toEqual([expect.stringContaining('unit cannot be specified')]);
  });

  it('rejects unsupported column type', () => {
    expect(
      validateYdbTtlAgainstSchema(
        'E',
        { interval: 'PT2H', column: 'name' },
        cols({ name: 'Utf8' }),
      ),
    ).toEqual([expect.stringContaining('unsupported type Utf8')]);
  });
});

describe('ExpectedTableSchema with TTL', () => {
  it('includes TTL in schema when decorator is present', () => {
    const schema = buildExpectedTableSchema(meta(TtlSessionEntity));
    expect(schema.ttl).toEqual({
      interval: 'PT2H',
      column: 'expires_at',
    });
  });

  it('has no TTL when decorator is absent', () => {
    const schema = buildExpectedTableSchema(meta(NoTtlEntity));
    expect(schema.ttl).toBeUndefined();
  });

  it('throws when TTL column is not declared', () => {
    @YdbEntity('ttl_unknown_col')
    @YdbTtl({ interval: 'PT2H', column: 'missing_column' })
    class TtlUnknownColumnEntity extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid: string;
    }
    expect(() =>
      buildExpectedTableSchema(meta(TtlUnknownColumnEntity)),
    ).toThrow(/"missing_column" is not declared/);
  });

  it('throws when TTL references PK of unsupported type (no default to PK)', () => {
    @YdbEntity('ttl_on_pk_uuid')
    @YdbTtl({ interval: 'PT2H', column: 'uuid' })
    class TtlOnPkUuidEntity extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid: string;
    }
    expect(() => buildExpectedTableSchema(meta(TtlOnPkUuidEntity))).toThrow(
      /unsupported type Uuid/,
    );
  });

  it('throws when TTL column has signed numeric type (Int64)', () => {
    expect(() =>
      buildExpectedTableSchema(meta(TtlSignedNumericEntity)),
    ).toThrow(
      /unsupported type Int64 — YDB TTL requires Date\/Datetime\/Timestamp or numeric Uint32\/Uint64\/DyNumber/,
    );
  });
});

describe('validateEntityMetadata with TTL', () => {
  it('returns no issues for valid TTL entity', () => {
    expect(validateEntityMetadata(TtlSessionEntity, validationCtx)).toEqual([]);
  });

  it('reports unknown TTL column', () => {
    @YdbEntity('ttl_validate_unknown')
    @YdbTtl({ interval: 'PT2H', column: 'missing_column' })
    class TtlValidateUnknownEntity extends YdbBaseEntity {
      @YdbPrimaryColumn('Uuid')
      uuid: string;
    }
    const issues = validateEntityMetadata(
      TtlValidateUnknownEntity,
      validationCtx,
    );
    expect(validationIssuesToMessages(issues)).toHaveLength(1);
    expect(validationIssuesToMessages(issues)[0]).toContain(
      '"missing_column" is not declared',
    );
  });

  it('reports signed numeric TTL column as unsupported type', () => {
    const issues = validateEntityMetadata(
      TtlSignedNumericEntity,
      validationCtx,
    );
    expect(validationIssuesToMessages(issues)).toHaveLength(1);
    expect(validationIssuesToMessages(issues)[0]).toContain(
      'Uint32/Uint64/DyNumber',
    );
  });
});

describe('generateCreateTableYql with TTL', () => {
  it('puts TTL into WITH clause after CREATE TABLE body', () => {
    const schema = buildExpectedTableSchema(meta(TtlSessionEntity));
    const yql = generateCreateTableYql(schema);

    // Тело таблицы закрывается до WITH, TTL — внутри WITH
    const bodyEnd = yql.indexOf('\n)');
    const ttlIndex = yql.indexOf('TTL');
    expect(bodyEnd).toBeGreaterThan(0);
    expect(ttlIndex).toBeGreaterThan(bodyEnd);

    expect(yql).toContain(
      'WITH (\n  TTL = Interval("PT2H") ON `expires_at`\n)',
    );
  });

  it('puts TTL with AS unit into WITH clause for numeric column', () => {
    // Uint64-колонку нельзя объявить через @YdbPrimitive, поэтому схема собирается вручную
    const schema: ExpectedTableSchema = {
      tableName: 'ttl_numeric',
      columns: cols({ id: 'Utf8', expires_at: 'Uint64' }),
      primaryKey: ['id'],
      indexes: [],
      ttl: { interval: 'P30D', column: 'expires_at', unit: 'seconds' },
    };
    const yql = generateCreateTableYql(schema);

    expect(yql).toBe(
      'CREATE TABLE `ttl_numeric` (\n' +
        '  `id` Utf8,\n' +
        '  `expires_at` Uint64,\n' +
        '  PRIMARY KEY (`id`)\n' +
        ')\n' +
        'WITH (\n' +
        '  TTL = Interval("P30D") ON `expires_at` AS SECONDS\n' +
        ')',
    );
  });

  it('does not include TTL clause when decorator is absent', () => {
    const schema = buildExpectedTableSchema(meta(NoTtlEntity));
    const yql = generateCreateTableYql(schema);

    expect(yql).not.toContain('TTL');
    expect(yql).not.toContain('WITH');
  });

  it('generates valid full CREATE TABLE with TTL in WITH clause', () => {
    const schema = buildExpectedTableSchema(meta(TtlSessionEntity));
    const yql = generateCreateTableYql(schema);

    expect(yql).toBe(
      'CREATE TABLE `ttl_sessions` (\n' +
        '  `uuid` Uuid,\n' +
        '  `token` Utf8,\n' +
        '  `expires_at` Datetime,\n' +
        '  PRIMARY KEY (`uuid`)\n' +
        ')\n' +
        'WITH (\n' +
        '  TTL = Interval("PT2H") ON `expires_at`\n' +
        ')',
    );
  });

  it('generates TTL clause via generateTtlWithClause helper', () => {
    expect(
      generateTtlWithClause({ interval: 'PT2H', column: 'expires_at' }),
    ).toBe('WITH (\n  TTL = Interval("PT2H") ON `expires_at`\n)');
    expect(
      generateTtlWithClause({
        interval: 'P30D',
        column: 'expires_at',
        unit: 'milliseconds',
      }),
    ).toBe(
      'WITH (\n  TTL = Interval("P30D") ON `expires_at` AS MILLISECONDS\n)',
    );
  });
});

describe('ISO 8601 duration helpers (#88)', () => {
  it('converts ISO duration to seconds', () => {
    expect(isoDurationToSeconds('PT2H')).toBe(7200);
    expect(isoDurationToSeconds('P30D')).toBe(2592000);
    expect(isoDurationToSeconds('P1DT2H30M')).toBe(95400);
    expect(isoDurationToSeconds('PT90S')).toBe(90);
    expect(isoDurationToSeconds('P1W')).toBe(604800);
    // Семантически равные записи дают одно и то же число секунд
    expect(isoDurationToSeconds('PT1H')).toBe(isoDurationToSeconds('PT60M'));
  });

  it('returns null for calendar parts and invalid strings', () => {
    // У годов/месяцев нет фиксированной длины — сравнить с секундами нельзя
    expect(isoDurationToSeconds('P1Y')).toBeNull();
    expect(isoDurationToSeconds('P1M')).toBeNull();
    expect(isoDurationToSeconds('2 hours')).toBeNull();
    expect(isoDurationToSeconds('')).toBeNull();
  });

  it('converts seconds back to ISO duration', () => {
    expect(secondsToIsoDuration(7200)).toBe('PT2H');
    expect(secondsToIsoDuration(2592000)).toBe('P30D');
    expect(secondsToIsoDuration(90000)).toBe('P1DT1H');
    expect(secondsToIsoDuration(0)).toBe('PT0S');
    expect(secondsToIsoDuration(-5)).toBe('PT0S');
  });

  it('round-trips seconds through ISO duration', () => {
    for (const seconds of [1, 59, 3600, 86399, 86400, 90061, 2592000]) {
      expect(isoDurationToSeconds(secondsToIsoDuration(seconds))).toBe(seconds);
    }
  });
});

describe('ISO duration microsecond precision (#88)', () => {
  it('parses fractional seconds to exact microseconds', () => {
    expect(isoDurationToMicroseconds('PT0.5S')).toBe(500000);
    expect(isoDurationToMicroseconds('PT1.25S')).toBe(1250000);
    expect(isoDurationToMicroseconds('PT0.000001S')).toBe(1);
    // Официальный пример из документации YDB Interval
    expect(isoDurationToMicroseconds('P1W2DT2H3M4.567890S')).toBe(
      ((7 + 2) * 24 * 3600 + 2 * 3600 + 3 * 60) * 1000000 + 4567890,
    );
  });

  it('truncates digits beyond microseconds deterministically', () => {
    // YDB Interval хранит максимум 6 знаков после секунды
    expect(isoDurationToMicroseconds('PT0.0000004S')).toBe(0);
    expect(isoDurationToMicroseconds('PT4.5678909S')).toBe(4567890);
    expect(isoDurationToMicroseconds('PT4.5678909S')).toBe(
      isoDurationToMicroseconds('PT4.5678901S'),
    );
  });

  it('renders microseconds back to ISO duration exactly', () => {
    expect(microsecondsToIsoDuration(500000)).toBe('PT0.5S');
    expect(microsecondsToIsoDuration(1250000)).toBe('PT1.25S');
    expect(microsecondsToIsoDuration(1)).toBe('PT0.000001S');
    expect(microsecondsToIsoDuration(1500000)).toBe('PT1.5S');
    expect(microsecondsToIsoDuration(7_200_000_000)).toBe('PT2H');
    // Хвостовые нули дробной части не пишутся: .567890 → .56789
    expect(microsecondsToIsoDuration(784_984_567_890)).toBe('P9DT2H3M4.56789S');
    expect(microsecondsToIsoDuration(0)).toBe('PT0S');
  });

  it('is value-round-trip safe: iso → µs → iso preserves the duration', () => {
    const cases = [
      'PT0.5S',
      'PT1.25S',
      'PT0.000001S',
      'PT2.000002S',
      'P1W2DT2H3M4.567890S',
      'PT2H',
      'P30D',
      'P1DT1H30M15S',
    ];
    for (const iso of cases) {
      const micros = isoDurationToMicroseconds(iso);
      expect(micros).not.toBeNull();
      // Повторный разбор нормализованной строки даёт те же микросекунды —
      // diff/verify/миграции стабильны после round-trip
      expect(
        isoDurationToMicroseconds(microsecondsToIsoDuration(micros!)),
      ).toBe(micros);
    }
  });

  it('round-trips canonical strings byte-identically', () => {
    // Каноническая форма: без недель (они рендерятся днями) и без
    // хвостовых нулей в дробной части
    const canonical = [
      'PT0.5S',
      'PT1.25S',
      'PT0.000001S',
      'PT2H',
      'P30D',
      'P1DT1H30M15S',
    ];
    for (const iso of canonical) {
      expect(microsecondsToIsoDuration(isoDurationToMicroseconds(iso)!)).toBe(
        iso,
      );
    }
  });

  it('normalizes equivalent spellings to identical microseconds', () => {
    // Недели → дни, .567890 == .56789
    expect(isoDurationToMicroseconds('P1W2DT2H3M4.567890S')).toBe(
      isoDurationToMicroseconds('P9DT2H3M4.56789S'),
    );
  });

  it('round-trips integer microseconds without loss', () => {
    const values = [1, 999999, 1000000, 1500000, 3600000000, 86_400_000_000];
    for (const micros of values) {
      expect(isoDurationToMicroseconds(microsecondsToIsoDuration(micros))).toBe(
        micros,
      );
    }
  });
});

describe('Exact microsecond conversion (#88)', () => {
  it('accepts intervals representable in YDB Interval exactly', () => {
    expect(isoDurationToMicrosecondsExact('PT2H')).toBe(7_200_000_000);
    expect(isoDurationToMicrosecondsExact('PT0.5S')).toBe(500000);
    // Хвостовые нули за пределами микросекунд не мешают точности
    expect(isoDurationToMicrosecondsExact('PT0.5000000S')).toBe(500000);
    // Официальный пример из документации YDB: ровно 6 знаков дроби
    expect(isoDurationToMicrosecondsExact('P1W2DT2H3M4.567890S')).toBe(
      isoDurationToMicroseconds('P1W2DT2H3M4.567890S'),
    );
  });

  it('returns null for sub-microsecond precision instead of truncating', () => {
    expect(isoDurationToMicrosecondsExact('PT0.0000001S')).toBeNull();
    expect(isoDurationToMicrosecondsExact('PT4.5678909S')).toBeNull();
  });

  it('returns null for calendar parts and invalid strings', () => {
    expect(isoDurationToMicrosecondsExact('P1M')).toBeNull();
    expect(isoDurationToMicrosecondsExact('P1Y2M')).toBeNull();
    expect(isoDurationToMicrosecondsExact('nope')).toBeNull();
  });

  it('rejects @YdbTtl intervals more precise than a microsecond', () => {
    class SubMicroEntity {}
    expect(() =>
      YdbTtl({ interval: 'PT0.0000001S', column: 'expires_at' })(
        SubMicroEntity,
      ),
    ).toThrow(/more precise than a microsecond/);
  });

  it('still accepts up to 6 fractional digits at decoration time', () => {
    class MaxPrecisionEntity {}
    expect(() =>
      YdbTtl({ interval: 'PT4.567890S', column: 'expires_at' })(
        MaxPrecisionEntity,
      ),
    ).not.toThrow();
  });
});

describe('TTL DDL units for numeric columns (#88)', () => {
  const units = [
    ['seconds', 'SECONDS'],
    ['milliseconds', 'MILLISECONDS'],
    ['microseconds', 'MICROSECONDS'],
    ['nanoseconds', 'NANOSECONDS'],
  ] as const;

  it.each(units)(
    'generates SET TTL with AS %s for numeric column',
    (unit, sqlUnit) => {
      expect(
        generateSetTtlYql('events', {
          interval: 'P1D',
          column: 'created_at',
          unit,
        }),
      ).toBe(
        `ALTER TABLE \`events\` SET (TTL = Interval("P1D") ON \`created_at\` AS ${sqlUnit})`,
      );
    },
  );

  it.each(units)(
    'puts AS %s into WITH clause of CREATE TABLE for Uint32 column',
    (unit, sqlUnit) => {
      const schema: ExpectedTableSchema = {
        tableName: 'ttl_events',
        columns: cols({ id: 'Utf8', created_at: 'Uint32' }),
        primaryKey: ['id'],
        indexes: [],
        ttl: { interval: 'P7D', column: 'created_at', unit },
      };

      expect(generateCreateTableYql(schema)).toBe(
        'CREATE TABLE `ttl_events` (\n' +
          '  `id` Utf8,\n' +
          '  `created_at` Uint32,\n' +
          '  PRIMARY KEY (`id`)\n' +
          ')\n' +
          `WITH (\n  TTL = Interval("P7D") ON \`created_at\` AS ${sqlUnit}\n)`,
      );
    },
  );

  it.each([['Uint32'], ['Uint64'], ['DyNumber']] as const)(
    `matches TTL on %s column by unit and seconds`,
    (columnType) => {
      const schema: ExpectedTableSchema = {
        tableName: 'ttl_numeric',
        columns: cols({ uuid: 'Uuid', expires_at: columnType }),
        primaryKey: ['uuid'],
        indexes: [],
        ttl: {
          interval: 'PT2H',
          column: 'expires_at',
          unit: 'milliseconds',
        },
      };
      const description = (): YdbTableDescription => ({
        columns: new Map(),
        primaryKey: ['uuid'],
        indexes: [],
        ttl: {
          column: 'expires_at',
          expireAfterSeconds: 7200,
          unit: 'milliseconds',
        },
      });

      // Ровно 2 часа — совпадение независимо от типа числовой колонки
      expect(checkTableSchema(schema, description()).ttlMismatches).toEqual([]);

      const changed = checkTableSchema(schema, {
        ...description(),
        ttl: {
          column: 'expires_at',
          expireAfterSeconds: 7201,
          unit: 'milliseconds',
        },
      });
      expect(changed.ttlMismatches).toHaveLength(1);

      // Расхождение unit тоже фиксируется
      const wrongUnit = checkTableSchema(schema, {
        ...description(),
        ttl: {
          column: 'expires_at',
          expireAfterSeconds: 7200,
          unit: 'seconds',
        },
      });
      expect(wrongUnit.ttlMismatches).toHaveLength(1);
    },
  );
});
