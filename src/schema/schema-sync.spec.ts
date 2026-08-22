import 'reflect-metadata';
import { jest } from '@jest/globals';
import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import {
  CreateSessionResultSchema,
  DescribeTableResultSchema,
  ValueSinceUnixEpochModeSettings_Unit,
} from '@ydbjs/api/table';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import { YdbEntity } from '../decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../decorators/column.decorator.js';
import { YdbEncrypted } from '../decorators/encryption.decorator.js';
import { YdbJson } from '../decorators/json.decorator.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';
import { YdbExecutor } from '../core/interfaces.js';
import {
  buildExpectedTableSchema,
  buildExpectedJoinTableSchema,
  buildExpectedSchemas,
  checkTableSchema,
  checkToIssues,
  diffSchemas,
  generateAddColumnsYql,
  generateCreateTableYql,
  generateResetTtlYql,
  generateSetTtlYql,
  ExpectedTableSchema,
  YdbSchemaSyncer,
  YdbTableDescription,
  YdbTableTtl,
} from './schema-sync.js';
import {
  getManyToManyJoinTables,
  ManyToMany,
  JoinTable,
} from '../decorators/relation.decorators.js';
import { EagerLoad } from '../decorators/eager.decorator.js';
import { YdbIndex } from '../decorators/index.decorator.js';
import { YdbTtl } from '../decorators/ttl.decorator.js';

@YdbEntity('test_users')
@YdbIndex({ columns: ['secret_bi'] })
@YdbIndex({ columns: ['is_active', 'name'], name: 'test_users__active_name' })
class TestUserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  secret: string;

  @YdbColumn('Bool')
  is_active: boolean;
}

@YdbEntity('test_explicit_uuid_pk')
class TestExplicitUuidPkEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Int64')
  amount: bigint;
}

@YdbEntity('test_no_pk')
class TestNoPkEntity extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name: string;
}

@YdbEntity('test_json')
class TestJsonEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Json')
  payload: any;

  @YdbColumn('JsonDocument')
  document: any;

  @YdbJson()
  @YdbColumn('Utf8')
  metadata: any;
}

@YdbEntity('test_tags')
class TestTagEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => TestPhotoEntity, (photo) => photo.tags)
  photos?: TestPhotoEntity[];
}

@YdbEntity('test_sessions')
@YdbTtl({ interval: 'PT2H', column: 'expires_at' })
@YdbIndex({ columns: ['expires_at'] })
class TestSessionEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Datetime')
  expires_at: Date;
}

@YdbEntity('test_ttl_numeric')
@YdbTtl({ interval: 'P30D', column: 'expires_at', unit: 'milliseconds' })
class TestNumericTtlEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  // Uint32 нет в YdbPrimitive — числовые TTL-типы проверяются отдельно
  @YdbColumn('Uint32' as never)
  expires_at: number;
}

@YdbEntity('test_photos')
@EagerLoad(['tags'])
class TestPhotoEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => TestTagEntity, (tag) => tag.photos)
  @JoinTable('test_photo_tag')
  tags?: TestTagEntity[];
}

const meta = (entity: new (...args: any[]) => any) => {
  const m = getYdbEntityMetadata(entity);
  if (!m) throw new Error('no metadata');
  return m;
};

const description = (
  columns: [string, Type_PrimitiveTypeId][],
  primaryKey: string[] = ['uuid'],
  indexes: Array<{ name: string; columns: string[]; unique: boolean }> = [],
  ttl?: YdbTableTtl,
): YdbTableDescription => ({
  columns: new Map(columns),
  primaryKey,
  indexes,
  ...(ttl ? { ttl } : {}),
});

describe('entity registry', () => {
  it('registers classes decorated with @YdbEntity', () => {
    const registered = getRegisteredYdbEntities();
    expect(registered).toContain(TestUserEntity);
    expect(registered).toContain(TestExplicitUuidPkEntity);
  });
});

describe('buildExpectedTableSchema', () => {
  it('builds columns including blind index synthetic columns', () => {
    const schema = buildExpectedTableSchema(meta(TestUserEntity));

    expect(schema.tableName).toBe('test_users');
    expect(schema.columns).toEqual({
      uuid: 'Uuid',
      name: 'Utf8',
      secret: 'Bytes',
      is_active: 'Bool',
      secret_bi: 'Utf8',
    });
    expect(schema.primaryKey).toEqual(['uuid']);
  });

  it('uses declared uuid primary key when @YdbPrimaryColumn is used', () => {
    const schema = buildExpectedTableSchema(meta(TestExplicitUuidPkEntity));

    expect(schema.primaryKey).toEqual(['uuid']);
  });

  it('throws when no primary key is declared', () => {
    expect(() => buildExpectedTableSchema(meta(TestNoPkEntity))).toThrow(
      /no primary key is declared/,
    );
  });
});

describe('buildExpectedJoinTableSchema', () => {
  it('builds join table with two Uuid columns and composite PK', () => {
    const joinTables = getManyToManyJoinTables([
      TestPhotoEntity,
      TestTagEntity,
    ]);
    expect(joinTables).toHaveLength(1);

    const schema = buildExpectedJoinTableSchema(joinTables[0]);
    expect(schema.tableName).toBe('test_photo_tag');
    expect(schema.columns).toEqual({
      test_photos_uuid: 'Uuid',
      test_tags_uuid: 'Uuid',
    });
    expect(schema.primaryKey).toEqual(['test_photos_uuid', 'test_tags_uuid']);
  });
});

describe('buildExpectedSchemas', () => {
  it('includes entity tables and many-to-many join tables', () => {
    const schemas = buildExpectedSchemas([TestPhotoEntity, TestTagEntity]);
    const names = schemas.map((s) => s.tableName);
    expect(names).toContain('test_photos');
    expect(names).toContain('test_tags');
    expect(names).toContain('test_photo_tag');
  });
});

describe('generateCreateTableYql', () => {
  it('generates CREATE TABLE with quoted identifiers, INDEX clauses and PRIMARY KEY', () => {
    const yql = generateCreateTableYql(
      buildExpectedTableSchema(meta(TestUserEntity)),
    );

    expect(yql).toBe(
      'CREATE TABLE `test_users` (\n' +
        '  `uuid` Uuid,\n' +
        '  `name` Utf8,\n' +
        '  `secret` Bytes,\n' +
        '  `is_active` Bool,\n' +
        '  `secret_bi` Utf8,\n' +
        '  INDEX `test_users__secret_bi` GLOBAL SYNC ON (`secret_bi`),\n' +
        '  INDEX `test_users__active_name` GLOBAL SYNC ON (`is_active`, `name`),\n' +
        '  PRIMARY KEY (`uuid`)\n' +
        ')',
    );
  });

  it('generates CREATE TABLE with Json and JsonDocument columns', () => {
    const yql = generateCreateTableYql(
      buildExpectedTableSchema(meta(TestJsonEntity)),
    );

    expect(yql).toBe(
      'CREATE TABLE `test_json` (\n' +
        '  `uuid` Uuid,\n' +
        '  `payload` Json,\n' +
        '  `document` JsonDocument,\n' +
        '  `metadata` Utf8,\n' +
        '  PRIMARY KEY (`uuid`)\n' +
        ')',
    );
  });
});

describe('@YdbIndex metadata', () => {
  it('resolves default index names as {table}__{cols}', () => {
    const schema = buildExpectedTableSchema(meta(TestUserEntity));

    expect(schema.indexes).toEqual([
      { name: 'test_users__secret_bi', columns: ['secret_bi'], unique: false },
      {
        name: 'test_users__active_name',
        columns: ['is_active', 'name'],
        unique: false,
      },
    ]);
  });
});

describe('generateAddColumnsYql', () => {
  it('generates ALTER TABLE with multiple ADD COLUMN clauses', () => {
    const yql = generateAddColumnsYql('test_users', [
      ['name', 'Utf8'],
      ['age', 'Int32'],
    ]);

    expect(yql).toBe(
      'ALTER TABLE `test_users` ADD COLUMN `name` Utf8, ADD COLUMN `age` Int32',
    );
  });
});

describe('checkTableSchema', () => {
  const expected = buildExpectedTableSchema(meta(TestUserEntity));

  it('passes when schema matches', () => {
    const check = checkTableSchema(
      expected,
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['name', Type_PrimitiveTypeId.UTF8],
        ['secret', Type_PrimitiveTypeId.STRING],
        ['is_active', Type_PrimitiveTypeId.BOOL],
        ['secret_bi', Type_PrimitiveTypeId.UTF8],
      ]),
    );

    expect(check.missingColumns).toEqual([]);
    expect(check.typeMismatches).toEqual([]);
  });

  it('passes for Json and JsonDocument columns', () => {
    const jsonExpected = buildExpectedTableSchema(meta(TestJsonEntity));
    const check = checkTableSchema(
      jsonExpected,
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['payload', Type_PrimitiveTypeId.JSON],
        ['document', Type_PrimitiveTypeId.JSON_DOCUMENT],
        ['metadata', Type_PrimitiveTypeId.UTF8],
      ]),
    );

    expect(check.missingColumns).toEqual([]);
    expect(check.typeMismatches).toEqual([]);
    expect(check.extraColumns).toEqual([]);
    expect(check.primaryKeyMatches).toBe(true);
  });

  it('detects missing and extra columns', () => {
    const check = checkTableSchema(
      expected,
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['name', Type_PrimitiveTypeId.UTF8],
        ['legacy', Type_PrimitiveTypeId.UTF8],
      ]),
    );

    expect(check.missingColumns).toEqual([
      ['secret', 'Bytes'],
      ['is_active', 'Bool'],
      ['secret_bi', 'Utf8'],
    ]);
    expect(check.extraColumns).toEqual(['legacy']);
  });

  it('detects type mismatches', () => {
    const check = checkTableSchema(
      expected,
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['name', Type_PrimitiveTypeId.INT32],
        ['secret', Type_PrimitiveTypeId.STRING],
        ['is_active', Type_PrimitiveTypeId.BOOL],
        ['secret_bi', Type_PrimitiveTypeId.UTF8],
      ]),
    );

    expect(check.typeMismatches).toEqual([
      { column: 'name', expected: 'Utf8', actual: 'Int32' },
    ]);
  });

  it('detects primary key mismatch', () => {
    const check = checkTableSchema(
      expected,
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['name'],
      ),
    );

    expect(check.primaryKeyMatches).toBe(false);
  });

  it('reports no index issue when index columns match exactly', () => {
    const check = checkTableSchema(
      expected,
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__secret_bi',
            columns: ['secret_bi'],
            unique: false,
          },
          {
            name: 'test_users__active_name',
            columns: ['is_active', 'name'],
            unique: false,
          },
        ],
      ),
    );

    expect(check.missingIndexes).toEqual([]);
    expect(check.extraIndexes).toEqual([]);
    expect(check.uniqueMismatches).toEqual([]);
    expect(check.indexColumnsMismatches).toEqual([]);
  });

  it('detects index with same name but different columns', () => {
    const check = checkTableSchema(
      expected,
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__secret_bi',
            columns: ['secret_bi'],
            unique: false,
          },
          {
            name: 'test_users__active_name',
            columns: ['name'],
            unique: false,
          },
        ],
      ),
    );

    expect(check.indexColumnsMismatches).toEqual([
      {
        name: 'test_users__active_name',
        expected: ['is_active', 'name'],
        actual: ['name'],
      },
    ]);
  });

  it('detects index with same columns but different order', () => {
    const check = checkTableSchema(
      expected,
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__secret_bi',
            columns: ['secret_bi'],
            unique: false,
          },
          {
            name: 'test_users__active_name',
            columns: ['name', 'is_active'],
            unique: false,
          },
        ],
      ),
    );

    expect(check.indexColumnsMismatches).toEqual([
      {
        name: 'test_users__active_name',
        expected: ['is_active', 'name'],
        actual: ['name', 'is_active'],
      },
    ]);
  });

  it('detects index unique flag mismatch', () => {
    const check = checkTableSchema(
      expected,
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__secret_bi',
            columns: ['secret_bi'],
            unique: false,
          },
          {
            name: 'test_users__active_name',
            columns: ['is_active', 'name'],
            unique: true,
          },
        ],
      ),
    );

    expect(check.uniqueMismatches).toEqual([
      { name: 'test_users__active_name', expected: false, actual: true },
    ]);
    expect(check.missingIndexes).toEqual([]);
    expect(check.extraIndexes).toEqual([]);
    expect(check.indexColumnsMismatches).toEqual([]);
  });
});

describe('checkTableSchema TTL (#88)', () => {
  const ttlExpected = buildExpectedTableSchema(meta(TestSessionEntity));

  const sessionDescription = (
    overrides: Partial<YdbTableDescription> = {},
  ): YdbTableDescription => ({
    columns: new Map([
      ['uuid', Type_PrimitiveTypeId.UUID],
      ['expires_at', Type_PrimitiveTypeId.DATETIME],
    ]),
    primaryKey: ['uuid'],
    indexes: [
      {
        name: 'test_sessions__expires_at',
        columns: ['expires_at'],
        unique: false,
      },
    ],
    ttl: { column: 'expires_at', expireAfterSeconds: 7200 },
    ...overrides,
  });

  it('passes when TTL and indexes match', () => {
    const check = checkTableSchema(ttlExpected, sessionDescription());

    expect(check.missingTtl).toEqual([]);
    expect(check.ttlMismatches).toEqual([]);
    expect(check.extraTtl).toEqual([]);
    expect(check.missingIndexes).toEqual([]);
  });

  it('detects TTL declared by entity but absent in DB', () => {
    const check = checkTableSchema(
      ttlExpected,
      sessionDescription({ ttl: undefined }),
    );

    expect(check.missingTtl).toEqual([
      { expected: { interval: 'PT2H', column: 'expires_at' } },
    ]);
  });

  it('detects changed TTL interval semantically (by seconds)', () => {
    // P1DT0H == 24 часа != PT2H; при этом "PT120M" эквивалентен "PT2H"
    const equalCheck = checkTableSchema(
      ttlExpected,
      sessionDescription({
        ttl: { column: 'expires_at', expireAfterSeconds: 7200 },
      }),
    );
    expect(equalCheck.ttlMismatches).toEqual([]);

    const changedCheck = checkTableSchema(
      ttlExpected,
      sessionDescription({
        ttl: { column: 'expires_at', expireAfterSeconds: 90000 },
      }),
    );
    expect(changedCheck.ttlMismatches).toEqual([
      {
        expected: { interval: 'PT2H', column: 'expires_at' },
        actual: { column: 'expires_at', expireAfterSeconds: 90000 },
      },
    ]);
  });

  it('matches fractional-second TTL without precision loss (#88)', () => {
    // PT0.5S == ровно 500000µs; сравнение в целых микросекундах YDB Interval
    const fractionalExpected = {
      ...ttlExpected,
      ttl: { interval: 'PT0.5S', column: 'expires_at' },
    };
    const equalCheck = checkTableSchema(
      fractionalExpected,
      sessionDescription({
        ttl: { column: 'expires_at', expireAfterSeconds: 0.5 },
      }),
    );
    expect(equalCheck.ttlMismatches).toEqual([]);

    // Сдвиг на микросекунду фиксируется как расхождение
    const changedCheck = checkTableSchema(
      fractionalExpected,
      sessionDescription({
        ttl: { column: 'expires_at', expireAfterSeconds: 0.500001 },
      }),
    );
    expect(changedCheck.ttlMismatches).toHaveLength(1);
  });

  it('treats sub-microsecond intervals as mismatch instead of truncating (#88)', () => {
    // "PT0.0000001S" непредставим в YDB Interval: усечение до 0µs дало бы
    // ложное «совпадение» с TTL = 0 секунд в БД
    const subMicroExpected = {
      ...ttlExpected,
      ttl: { interval: 'PT0.0000001S', column: 'expires_at' },
    };
    const check = checkTableSchema(
      subMicroExpected,
      sessionDescription({
        ttl: { column: 'expires_at', expireAfterSeconds: 0 },
      }),
    );

    expect(check.ttlMismatches).toHaveLength(1);
  });

  it('detects changed TTL column and unit', () => {
    const numericExpected: ExpectedTableSchema = {
      tableName: 'ttl_numeric',
      columns: { uuid: 'Uuid' },
      primaryKey: ['uuid'],
      indexes: [],
      ttl: { interval: 'P30D', column: 'expires_at', unit: 'seconds' },
    };

    const check = checkTableSchema(numericExpected, {
      columns: new Map([['uuid', Type_PrimitiveTypeId.UUID]]),
      primaryKey: ['uuid'],
      indexes: [],
      ttl: {
        column: 'other_col',
        expireAfterSeconds: 2592000,
        unit: 'milliseconds',
      },
    });

    expect(check.ttlMismatches).toEqual([
      {
        expected: { interval: 'P30D', column: 'expires_at', unit: 'seconds' },
        actual: {
          column: 'other_col',
          expireAfterSeconds: 2592000,
          unit: 'milliseconds',
        },
      },
    ]);
  });

  it('treats calendar-part intervals (years/months) as mismatch', () => {
    const calendarExpected = {
      ...ttlExpected,
      ttl: { interval: 'P1M', column: 'expires_at' },
    };
    const check = checkTableSchema(
      calendarExpected,
      sessionDescription({
        ttl: { column: 'expires_at', expireAfterSeconds: 2592000 },
      }),
    );

    expect(check.ttlMismatches).toHaveLength(1);
  });

  it('detects TTL present in DB but absent in entity', () => {
    const plainExpected = buildExpectedTableSchema(
      meta(TestExplicitUuidPkEntity),
    );
    const check = checkTableSchema(plainExpected, {
      columns: new Map([['uuid', Type_PrimitiveTypeId.UUID]]),
      primaryKey: ['uuid'],
      indexes: [],
      ttl: { column: 'created_at', expireAfterSeconds: 3600 },
    });

    expect(check.extraTtl).toEqual([
      { actual: { column: 'created_at', expireAfterSeconds: 3600 } },
    ]);
  });
});

describe('checkToIssues / diffSchemas (#88)', () => {
  const ttlExpected = buildExpectedTableSchema(meta(TestSessionEntity));

  const sessionDescription = (
    overrides: Partial<YdbTableDescription> = {},
  ): YdbTableDescription => ({
    columns: new Map([
      ['uuid', Type_PrimitiveTypeId.UUID],
      ['expires_at', Type_PrimitiveTypeId.DATETIME],
    ]),
    primaryKey: ['uuid'],
    indexes: [
      {
        name: 'test_sessions__expires_at',
        columns: ['expires_at'],
        unique: false,
      },
    ],
    ...overrides,
  });

  it('exposes unique flag mismatch as an issue', () => {
    const check = checkTableSchema(
      buildExpectedTableSchema(meta(TestUserEntity)),
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__active_name',
            columns: ['is_active', 'name'],
            unique: true,
          },
        ],
      ),
    );
    const issues = checkToIssues(check);

    expect(issues).toContainEqual({
      tableName: 'test_users',
      kind: 'unique-mismatch',
      message:
        'Table "test_users" index "test_users__active_name" unique flag mismatch: ' +
        'expected false, actual true',
    });
  });

  it('exposes missing TTL as ttl-missing issue', () => {
    const issues = diffSchemas(
      [ttlExpected],
      [sessionDescription({ ttl: undefined })],
    );

    expect(issues).toContainEqual({
      tableName: 'test_sessions',
      kind: 'ttl-missing',
      message:
        'Table "test_sessions" has no TTL, entity declares PT2H on column "expires_at"',
    });
  });

  it('exposes changed TTL with unit as ttl-mismatch issue', () => {
    const issues = diffSchemas(
      [
        {
          ...ttlExpected,
          ttl: { interval: 'PT2H', column: 'expires_at', unit: 'seconds' },
        },
      ],
      [
        sessionDescription({
          ttl: { column: 'expires_at', expireAfterSeconds: 3600 },
        }),
      ],
    );

    expect(issues).toContainEqual({
      tableName: 'test_sessions',
      kind: 'ttl-mismatch',
      message:
        'Table "test_sessions" TTL mismatch: expected PT2H on column "expires_at" AS SECONDS, ' +
        'actual PT1H on column "expires_at"',
    });
  });

  it('exposes DB-only TTL as ttl-extra issue', () => {
    const plainExpected = buildExpectedTableSchema(
      meta(TestExplicitUuidPkEntity),
    );
    const issues = diffSchemas(
      [plainExpected],
      [
        {
          columns: new Map([['uuid', Type_PrimitiveTypeId.UUID]]),
          primaryKey: ['uuid'],
          indexes: [],
          ttl: { column: 'created_at', expireAfterSeconds: 3600 },
        },
      ],
    );

    expect(issues).toContainEqual({
      tableName: 'test_explicit_uuid_pk',
      kind: 'ttl-extra',
      message:
        'Table "test_explicit_uuid_pk" has TTL PT1H on column "created_at" not present in entity',
    });
  });
});

describe('generateSetTtlYql / generateResetTtlYql', () => {
  it('generates ALTER TABLE SET with TTL expression compatible with WITH-clause', () => {
    expect(
      generateSetTtlYql('sessions', { interval: 'PT2H', column: 'expires_at' }),
    ).toBe(
      'ALTER TABLE `sessions` SET (TTL = Interval("PT2H") ON `expires_at`)',
    );
    expect(
      generateSetTtlYql('sessions', {
        interval: 'P30D',
        column: 'expires_at',
        unit: 'seconds',
      }),
    ).toBe(
      'ALTER TABLE `sessions` SET (TTL = Interval("P30D") ON `expires_at` AS SECONDS)',
    );
  });

  it('generates ALTER TABLE RESET (TTL)', () => {
    expect(generateResetTtlYql('sessions')).toBe(
      'ALTER TABLE `sessions` RESET (TTL)',
    );
  });
});

describe('YdbSchemaSyncer', () => {
  const executor = jest.fn(() => Promise.resolve([])) as unknown as YdbExecutor;
  const executedSql = () =>
    (executor as unknown as jest.Mock).mock.calls.map(
      (c: any) => c[0][0] as string,
    );

  let syncer: YdbSchemaSyncer;

  beforeEach(() => {
    jest.clearAllMocks();
    // driver не используется: describeTable мокается
    syncer = new YdbSchemaSyncer({} as never, executor);
  });

  const mockDescribe = (value: YdbTableDescription | null) =>
    jest.spyOn(syncer as any, 'describeTable').mockResolvedValue(value);

  it('creates table when it does not exist', async () => {
    mockDescribe(null);

    await syncer.sync([TestUserEntity]);

    expect(executedSql()).toEqual([
      generateCreateTableYql(buildExpectedTableSchema(meta(TestUserEntity))),
    ]);
  });

  it('adds missing columns via ALTER TABLE', async () => {
    mockDescribe(
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['name', Type_PrimitiveTypeId.UTF8],
        ['secret', Type_PrimitiveTypeId.STRING],
        ['is_active', Type_PrimitiveTypeId.BOOL],
      ]),
    );

    await syncer.sync([TestUserEntity]);

    expect(executedSql()).toEqual([
      'ALTER TABLE `test_users` ADD COLUMN `secret_bi` Utf8',
      'ALTER TABLE `test_users` ADD INDEX `test_users__secret_bi` GLOBAL SYNC ON (`secret_bi`)',
      'ALTER TABLE `test_users` ADD INDEX `test_users__active_name` GLOBAL SYNC ON (`is_active`, `name`)',
    ]);
  });

  it('does nothing when schema matches', async () => {
    mockDescribe(
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
          ['unknown_extra', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__secret_bi',
            columns: ['secret_bi'],
            unique: false,
          },
          {
            name: 'test_users__active_name',
            columns: ['is_active', 'name'],
            unique: false,
          },
        ],
      ),
    );

    await syncer.sync([TestUserEntity]);

    expect(executedSql()).toEqual([]);
  });

  it('throws on column type mismatch', async () => {
    mockDescribe(
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['name', Type_PrimitiveTypeId.INT64],
        ['secret', Type_PrimitiveTypeId.STRING],
        ['is_active', Type_PrimitiveTypeId.BOOL],
        ['secret_bi', Type_PrimitiveTypeId.UTF8],
      ]),
    );

    await expect(syncer.sync([TestUserEntity])).rejects.toThrow(
      /column type mismatch/,
    );
    expect(executedSql()).toEqual([]);
  });

  it('throws on primary key mismatch', async () => {
    mockDescribe(
      description([['uuid', Type_PrimitiveTypeId.UUID]], ['uuid', 'name']),
    );

    await expect(syncer.sync([TestUserEntity])).rejects.toThrow(
      /primary key mismatch/,
    );
  });

  it('throws on index columns mismatch', async () => {
    mockDescribe(
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__secret_bi',
            columns: ['secret_bi'],
            unique: false,
          },
          {
            name: 'test_users__active_name',
            columns: ['name', 'is_active'],
            unique: false,
          },
        ],
      ),
    );

    await expect(syncer.sync([TestUserEntity])).rejects.toThrow(
      /index columns mismatch/,
    );
    expect(executedSql()).toEqual([]);
  });

  it('verify reports index-columns-mismatch issue', async () => {
    mockDescribe(
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__secret_bi',
            columns: ['secret_bi'],
            unique: false,
          },
          {
            name: 'test_users__active_name',
            columns: ['name'],
            unique: false,
          },
        ],
      ),
    );

    const issues = await syncer.verify([TestUserEntity]);

    expect(issues).toEqual([
      {
        tableName: 'test_users',
        kind: 'index-columns-mismatch',
        message:
          'Table "test_users" index "test_users__active_name" columns mismatch: ' +
          'expected [is_active, name], actual [name]',
      },
    ]);
    expect(executedSql()).toEqual([]);
  });

  it('verify reports issues without executing DDL', async () => {
    mockDescribe(null);

    const issues = await syncer.verify([TestUserEntity]);

    expect(issues).toEqual([
      {
        tableName: 'test_users',
        kind: 'missing-table',
        message: 'Table "test_users" does not exist',
      },
    ]);
    expect(executedSql()).toEqual([]);
  });

  it('verify reports missing TTL and missing index (#88)', async () => {
    mockDescribe({
      columns: new Map([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['expires_at', Type_PrimitiveTypeId.DATETIME],
      ]),
      primaryKey: ['uuid'],
      indexes: [],
    });

    const issues = await syncer.verify([TestSessionEntity]);

    expect(issues).toEqual([
      expect.objectContaining({ kind: 'missing-index' }),
      {
        tableName: 'test_sessions',
        kind: 'ttl-missing',
        message:
          'Table "test_sessions" has no TTL, entity declares PT2H on column "expires_at"',
      },
    ]);
  });

  it('verify reports unique flag mismatch issue (#88)', async () => {
    mockDescribe(
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['name', Type_PrimitiveTypeId.UTF8],
          ['secret', Type_PrimitiveTypeId.STRING],
          ['is_active', Type_PrimitiveTypeId.BOOL],
          ['secret_bi', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [
          {
            name: 'test_users__active_name',
            columns: ['is_active', 'name'],
            unique: true,
          },
        ],
      ),
    );

    const issues = await syncer.verify([TestUserEntity]);

    expect(issues).toContainEqual({
      tableName: 'test_users',
      kind: 'unique-mismatch',
      message:
        'Table "test_users" index "test_users__active_name" unique flag mismatch: ' +
        'expected false, actual true',
    });
    expect(executedSql()).toEqual([]);
  });

  // Синхронизация TTL (#88): отсутствующий ставим, изменённый заменяем,
  // лишний не сбрасываем.
  describe('sync applies TTL changes', () => {
    const sessionDescriptionFull = (ttl?: YdbTableTtl): YdbTableDescription =>
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['expires_at', Type_PrimitiveTypeId.DATETIME],
        ],
        ['uuid'],
        [
          {
            name: 'test_sessions__expires_at',
            columns: ['expires_at'],
            unique: false,
          },
        ],
        ttl,
      );

    const numericDescription = (ttl?: YdbTableTtl): YdbTableDescription =>
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['expires_at', Type_PrimitiveTypeId.UINT32],
        ],
        ['uuid'],
        [],
        ttl,
      );

    it('sets TTL declared by entity but absent in DB', async () => {
      mockDescribe(sessionDescriptionFull());

      await syncer.sync([TestSessionEntity]);

      expect(executedSql()).toEqual([
        generateSetTtlYql('test_sessions', {
          interval: 'PT2H',
          column: 'expires_at',
        }),
      ]);
    });

    it('replaces changed TTL with metadata from entity', async () => {
      mockDescribe(
        sessionDescriptionFull({
          column: 'expires_at',
          expireAfterSeconds: 90000,
        }),
      );

      await syncer.sync([TestSessionEntity]);

      expect(executedSql()).toEqual([
        generateSetTtlYql('test_sessions', {
          interval: 'PT2H',
          column: 'expires_at',
        }),
      ]);
    });

    it('replaces changed numeric TTL including unit', async () => {
      mockDescribe(
        numericDescription({
          column: 'expires_at',
          expireAfterSeconds: 2592000,
          unit: 'seconds',
        }),
      );

      await syncer.sync([TestNumericTtlEntity]);

      expect(executedSql()).toEqual([
        generateSetTtlYql('test_ttl_numeric', {
          interval: 'P30D',
          column: 'expires_at',
          unit: 'milliseconds',
        }),
      ]);
    });

    it('sets numeric TTL with unit when absent in DB', async () => {
      mockDescribe(numericDescription());

      await syncer.sync([TestNumericTtlEntity]);

      expect(executedSql()).toEqual([
        generateSetTtlYql('test_ttl_numeric', {
          interval: 'P30D',
          column: 'expires_at',
          unit: 'milliseconds',
        }),
      ]);
    });

    it('executes no DDL when TTL matches', async () => {
      mockDescribe(
        sessionDescriptionFull({
          column: 'expires_at',
          expireAfterSeconds: 7200,
        }),
      );

      await syncer.sync([TestSessionEntity]);

      expect(executedSql()).toEqual([]);
    });

    it('warns about extra TTL without resetting it', async () => {
      const warnSpy = jest
        .spyOn((syncer as any).logger, 'warn')
        .mockImplementation(() => {});
      mockDescribe(
        description(
          [
            ['uuid', Type_PrimitiveTypeId.UUID],
            ['name', Type_PrimitiveTypeId.UTF8],
            ['secret', Type_PrimitiveTypeId.STRING],
            ['is_active', Type_PrimitiveTypeId.BOOL],
            ['secret_bi', Type_PrimitiveTypeId.UTF8],
          ],
          ['uuid'],
          [
            {
              name: 'test_users__secret_bi',
              columns: ['secret_bi'],
              unique: false,
            },
            {
              name: 'test_users__active_name',
              columns: ['is_active', 'name'],
              unique: false,
            },
          ],
          { column: 'legacy_expires_at', expireAfterSeconds: 3600 },
        ),
      );

      await syncer.sync([TestUserEntity]);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('extra TTL on column "legacy_expires_at"'),
      );
      expect(executedSql()).toEqual([]);
    });
  });
});

describe('YdbSchemaSyncer.describeTable TTL parsing (#88)', () => {
  const sessionResult = anyPack(
    CreateSessionResultSchema,
    create(CreateSessionResultSchema, { sessionId: 'session-ttl-1' }),
  );

  function makeSyncer(describeResponse: unknown): YdbSchemaSyncer {
    const tableClient = {
      createSession: jest.fn(() =>
        Promise.resolve({ operation: { result: sessionResult } }),
      ),
      describeTable: jest.fn(() => Promise.resolve(describeResponse)),
      deleteSession: jest.fn(() => Promise.resolve({})),
    };
    const driver = {
      database: '/local',
      createClient: jest.fn(() => tableClient),
    };
    return new YdbSchemaSyncer(driver as never, {} as YdbExecutor);
  }

  function describeResponse(ttl?: unknown): unknown {
    return {
      operation: {
        status: StatusIds_StatusCode.SUCCESS,
        result: anyPack(
          DescribeTableResultSchema,
          create(DescribeTableResultSchema, {
            columns: [
              {
                name: 'expires_at',
                type: {
                  type: {
                    case: 'typeId',
                    value: Type_PrimitiveTypeId.DATETIME,
                  },
                },
              },
            ],
            primaryKey: ['expires_at'],
            indexes: [],
            ...(ttl ? { ttlSettings: ttl } : {}),
          }),
        ),
      },
    };
  }

  it('parses date-type TTL settings', async () => {
    const syncer = makeSyncer(
      describeResponse({
        mode: {
          case: 'dateTypeColumn',
          value: { columnName: 'expires_at', expireAfterSeconds: 7200 },
        },
      }),
    );

    const desc = await syncer.describeTable('test_sessions');

    expect(desc?.ttl).toEqual({
      column: 'expires_at',
      expireAfterSeconds: 7200,
    });
  });

  it.each([
    [ValueSinceUnixEpochModeSettings_Unit.SECONDS, 'seconds'],
    [ValueSinceUnixEpochModeSettings_Unit.MILLISECONDS, 'milliseconds'],
    [ValueSinceUnixEpochModeSettings_Unit.MICROSECONDS, 'microseconds'],
    [ValueSinceUnixEpochModeSettings_Unit.NANOSECONDS, 'nanoseconds'],
  ] as const)(
    'maps numeric TTL unit from proto enum (%#)',
    async (protoUnit, expectedUnit) => {
      const syncer = makeSyncer(
        describeResponse({
          mode: {
            case: 'valueSinceUnixEpoch',
            value: {
              columnName: 'expires_at',
              columnUnit: protoUnit,
              expireAfterSeconds: 2592000,
            },
          },
        }),
      );

      const desc = await syncer.describeTable('test_sessions');

      expect(desc?.ttl).toEqual({
        column: 'expires_at',
        expireAfterSeconds: 2592000,
        unit: expectedUnit,
      });
    },
  );

  it('treats UNSPECIFIED numeric TTL unit as date-like (no AS suffix)', async () => {
    const syncer = makeSyncer(
      describeResponse({
        mode: {
          case: 'valueSinceUnixEpoch',
          value: {
            columnName: 'expires_at',
            columnUnit: ValueSinceUnixEpochModeSettings_Unit.UNSPECIFIED,
            expireAfterSeconds: 3600,
          },
        },
      }),
    );

    const desc = await syncer.describeTable('test_sessions');

    expect(desc?.ttl).toEqual({
      column: 'expires_at',
      expireAfterSeconds: 3600,
    });
  });

  it('returns undefined ttl when ttlSettings is absent', async () => {
    const syncer = makeSyncer(describeResponse());

    const desc = await syncer.describeTable('test_sessions');

    expect(desc?.ttl).toBeUndefined();
  });
});
