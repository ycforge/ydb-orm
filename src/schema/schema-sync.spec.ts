import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { YdbEntity } from '../decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../decorators/column.decorator.js';
import { YdbEncrypted } from '../decorators/encryption.decorator.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { getRegisteredYdbEntities } from '../metadata/entity-registry.js';
import { YdbExecutor } from '../core/interfaces.js';
import {
  buildExpectedTableSchema,
  buildExpectedJoinTableSchema,
  buildExpectedSchemas,
  checkTableSchema,
  generateAddColumnsYql,
  generateCreateTableYql,
  YdbSchemaSyncer,
  YdbTableDescription,
} from './schema-sync.js';
import {
  getManyToManyJoinTables,
  ManyToMany,
  JoinTable,
} from '../decorators/relation.decorators.js';
import { EagerLoad } from '../decorators/eager.decorator.js';
import { YdbIndex } from '../decorators/index.decorator.js';

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

@YdbEntity('test_fallback_pk')
class TestFallbackPkEntity extends YdbBaseEntity {
  @YdbColumn('Uuid')
  uuid: string;

  @YdbColumn('Int64')
  amount: bigint;
}

@YdbEntity('test_no_pk')
class TestNoPkEntity extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name: string;
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
): YdbTableDescription => ({ columns: new Map(columns), primaryKey, indexes });

describe('entity registry', () => {
  it('registers classes decorated with @YdbEntity', () => {
    const registered = getRegisteredYdbEntities();
    expect(registered).toContain(TestUserEntity);
    expect(registered).toContain(TestFallbackPkEntity);
  });
});

describe('buildExpectedTableSchema', () => {
  it('builds columns including blind index synthetic columns', () => {
    const schema = buildExpectedTableSchema(meta(TestUserEntity));

    expect(schema.tableName).toBe('test_users');
    expect(schema.columns).toEqual({
      uuid: 'Uuid',
      name: 'Utf8',
      secret: 'Utf8',
      is_active: 'Bool',
      secret_bi: 'Utf8',
    });
    expect(schema.primaryKey).toEqual(['uuid']);
  });

  it('falls back to uuid primary key when @YdbPrimaryColumn is not used', () => {
    const schema = buildExpectedTableSchema(meta(TestFallbackPkEntity));

    expect(schema.primaryKey).toEqual(['uuid']);
  });

  it('throws when primary key column is not declared', () => {
    expect(() => buildExpectedTableSchema(meta(TestNoPkEntity))).toThrow(
      /primary key column "uuid" is not declared/,
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
        '  `secret` Utf8,\n' +
        '  `is_active` Bool,\n' +
        '  `secret_bi` Utf8,\n' +
        '  INDEX `test_users__secret_bi` GLOBAL SYNC ON (`secret_bi`),\n' +
        '  INDEX `test_users__active_name` GLOBAL SYNC ON (`is_active`, `name`),\n' +
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
        ['secret', Type_PrimitiveTypeId.UTF8],
        ['is_active', Type_PrimitiveTypeId.BOOL],
        ['secret_bi', Type_PrimitiveTypeId.UTF8],
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
      ['secret', 'Utf8'],
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
        ['secret', Type_PrimitiveTypeId.UTF8],
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
          ['secret', Type_PrimitiveTypeId.UTF8],
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
          ['secret', Type_PrimitiveTypeId.UTF8],
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
          ['secret', Type_PrimitiveTypeId.UTF8],
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
          ['secret', Type_PrimitiveTypeId.UTF8],
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
        ['secret', Type_PrimitiveTypeId.UTF8],
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
          ['secret', Type_PrimitiveTypeId.UTF8],
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
        ['secret', Type_PrimitiveTypeId.UTF8],
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
          ['secret', Type_PrimitiveTypeId.UTF8],
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
          ['secret', Type_PrimitiveTypeId.UTF8],
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
});
