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
import { IssueMessageSchema, StatusIds_StatusCode } from '@ydbjs/api/operation';
import { YdbEntity } from '../../decorators/entity.decorator.js';
import {
  YdbColumn,
  YdbPrimaryColumn,
} from '../../decorators/column.decorator.js';
import { YdbEncrypted } from '../../decorators/encryption.decorator.js';
import { YdbJson } from '../../decorators/json.decorator.js';
import { YdbBaseEntity } from '../../entity/base-entity.js';
import { getYdbEntityMetadata } from '../../metadata/entity-metadata.js';
import { getRegisteredYdbEntities } from '../../metadata/entity-registry.js';
import { YdbExecutor } from '../../core/interfaces.js';
import { YdbPrimitive } from '../../core/types.js';
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
  joinTableDefinitionsEquivalent,
  ManyToMany,
  JoinTable,
} from '../../decorators/relation.decorators.js';
import { EagerLoad } from '../../decorators/eager.decorator.js';
import { YdbIndex } from '../../decorators/index.decorator.js';
import { YdbTtl } from '../../decorators/ttl.decorator.js';

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

// #89: составной PK — порядок колонок значим при сравнении схем
@YdbEntity('test_composite_pk')
class TestCompositePkEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Uuid')
  id: string;

  @YdbColumn('Int64')
  amount: bigint;
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

// Сущность для проверки не-примитивных типов в БД (#91)
@YdbEntity('test_unsupported_types')
class TestUnsupportedTypesEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  price: string;
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

// #90: many-to-many с не-uuid PK (кастомные имена свойств)
@YdbEntity('test_articles')
class TestArticleEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  article_id: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => TestAuthorEntity, (author) => author.articles)
  @JoinTable('test_article_author')
  authors?: TestAuthorEntity[];
}

@YdbEntity('test_authors')
class TestAuthorEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  author_id: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => TestArticleEntity, (article) => article.authors)
  articles?: TestArticleEntity[];
}

// #90: разные PK-типы на сторонах связи (Int64 ↔ Utf8) + явные имена колонок
@YdbEntity('test_orders')
class TestOrderEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  order_id: bigint;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => TestSkuEntity, (sku) => sku.orders)
  @JoinTable('test_order_sku', {
    joinColumn: 'order_ref',
    inverseJoinColumn: 'sku_code',
  })
  skus?: TestSkuEntity[];
}

@YdbEntity('test_skus')
class TestSkuEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  sku: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => TestOrderEntity, (order) => order.skus)
  orders?: TestOrderEntity[];
}

// #90: составной PK на стороне owner — явный отказ
@YdbEntity('test_m2m_comp_users')
class TestCompositeUserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Uuid')
  user_uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => TestCompositeRoleEntity, (role) => role.users)
  @JoinTable('test_composite_user_role')
  roles?: TestCompositeRoleEntity[];
}

@YdbEntity('test_m2m_comp_roles')
class TestCompositeRoleEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  role_uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => TestCompositeUserEntity, (user) => user.roles)
  users?: TestCompositeUserEntity[];
}

// #90/#139: зеркальные декларации одной join-таблицы на обеих сторонах —
// физически эквивалентны, дедуплицируются безопасно
@YdbEntity('test_sym_lefts')
class TestSymLeftEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  left_id: bigint;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => TestSymRightEntity, (right) => right.lefts)
  @JoinTable('test_sym_join', {
    joinColumn: 'left_ref',
    inverseJoinColumn: 'right_code',
  })
  rights?: TestSymRightEntity[];
}

@YdbEntity('test_sym_rights')
class TestSymRightEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  right_code: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => TestSymLeftEntity, (left) => left.rights)
  @JoinTable('test_sym_join', {
    joinColumn: 'right_code',
    inverseJoinColumn: 'left_ref',
  })
  lefts?: TestSymLeftEntity[];
}

// #139: конфликтующие объявления одного имени таблицы
// (разные пары сущностей с разными PK-типами)
@YdbEntity('test_dup_orders')
class TestDupOrderEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  order_id: bigint;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => TestDupItemEntity, (item) => item.orders)
  @JoinTable('test_duplicated_join')
  items?: TestDupItemEntity[];
}

@YdbEntity('test_dup_items')
class TestDupItemEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  item_uuid: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => TestDupOrderEntity, (order) => order.items)
  orders?: TestDupOrderEntity[];
}

@YdbEntity('test_dup_users')
class TestDupUserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  user_id: bigint;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => TestDupGroupEntity, (group) => group.users)
  @JoinTable('test_duplicated_join')
  groups?: TestDupGroupEntity[];
}

@YdbEntity('test_dup_groups')
class TestDupGroupEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  group_id: bigint;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => TestDupUserEntity, (user) => user.groups)
  users?: TestDupUserEntity[];
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

// #89: описание таблицы с составным PK; primaryKey передаётся явно,
// чтобы проверять перестановки порядка
const compositePkExpected = buildExpectedTableSchema(
  meta(TestCompositePkEntity),
);
const compositePkDescription = (primaryKey: string[]): YdbTableDescription =>
  description(
    [
      ['tenant_id', Type_PrimitiveTypeId.UTF8],
      ['id', Type_PrimitiveTypeId.UUID],
      ['amount', Type_PrimitiveTypeId.INT64],
    ],
    primaryKey,
  );

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

  it('derives column names from actual PK property names, not {table}_uuid (#90)', () => {
    const joinTables = getManyToManyJoinTables([
      TestArticleEntity,
      TestAuthorEntity,
    ]);
    expect(joinTables).toHaveLength(1);

    const [jt] = joinTables;
    // PK называются article_id/author_id — дефолтные имена выводятся из них
    expect(jt.joinColumn).toBe('test_articles_article_id');
    expect(jt.inverseJoinColumn).toBe('test_authors_author_id');

    const schema = buildExpectedJoinTableSchema(jt);
    expect(schema.columns).toEqual({
      test_articles_article_id: 'Uuid',
      test_authors_author_id: 'Uuid',
    });
    expect(schema.primaryKey).toEqual([
      'test_articles_article_id',
      'test_authors_author_id',
    ]);
  });

  it('derives non-uuid PK types (Int64 owner, Utf8 inverse) and keeps explicit column names (#90)', () => {
    const joinTables = getManyToManyJoinTables([
      TestOrderEntity,
      TestSkuEntity,
    ]);
    expect(joinTables).toHaveLength(1);

    const [jt] = joinTables;
    expect(jt.joinColumn).toBe('order_ref');
    expect(jt.inverseJoinColumn).toBe('sku_code');
    expect(jt.joinColumnType).toBe('Int64');
    expect(jt.inverseJoinColumnType).toBe('Utf8');

    const schema = buildExpectedJoinTableSchema(jt);
    expect(schema.columns).toEqual({
      order_ref: 'Int64',
      sku_code: 'Utf8',
    });
    expect(schema.primaryKey).toEqual(['order_ref', 'sku_code']);
  });

  it('definition always carries explicit column types; schema builds from it as-is (#87)', () => {
    // Единственный источник имён/типов — resolveRelationJoinTableDefinition:
    // типы обязательны и выводятся только там (ошибкой конфигурации, без
    // молчаливого фолбэка). Отдельного пути вывода типов в схеме нет (#87).
    const [jt] = getManyToManyJoinTables([TestOrderEntity, TestSkuEntity]);
    expect(jt.joinColumnType).toBe('Int64');
    expect(jt.inverseJoinColumnType).toBe('Utf8');

    const schema = buildExpectedJoinTableSchema(jt);
    expect(schema.columns).toEqual({ order_ref: 'Int64', sku_code: 'Utf8' });
  });

  it('rejects composite primary keys with a clear error instead of a broken schema (#90)', () => {
    expect(() =>
      getManyToManyJoinTables([
        TestCompositeUserEntity,
        TestCompositeRoleEntity,
      ]),
    ).toThrow(/composite primary keys.*not supported in.*many-to-many/s);
  });
});

describe('duplicate join-table declarations (#139)', () => {
  it('deduplicates the same entity class passed twice', () => {
    const joinTables = getManyToManyJoinTables([
      TestPhotoEntity,
      TestPhotoEntity,
      TestTagEntity,
    ]);
    expect(joinTables).toHaveLength(1);
    expect(joinTables[0].tableName).toBe('test_photo_tag');
  });

  it('deduplicates mirrored declarations on both sides of a relation', () => {
    const joinTables = getManyToManyJoinTables([
      TestSymLeftEntity,
      TestSymRightEntity,
    ]);
    // Оба объявления описывают одну физическую таблицу — остаётся одно
    expect(joinTables).toHaveLength(1);

    const jt = joinTables[0];
    expect(jt.tableName).toBe('test_sym_join');
    // Первое объявление (от left): колонка left → left_ref (Int64)
    expect(jt.joinColumn).toBe('left_ref');
    expect(jt.joinColumnType).toBe('Int64');
    expect(jt.inverseJoinColumn).toBe('right_code');
    expect(jt.inverseJoinColumnType).toBe('Utf8');

    const schema = buildExpectedJoinTableSchema(jt);
    expect(schema.columns).toEqual({ left_ref: 'Int64', right_code: 'Utf8' });
  });

  it('throws listing all definitions when declarations conflict', () => {
    let error: Error | undefined;
    try {
      getManyToManyJoinTables([
        TestDupOrderEntity,
        TestDupItemEntity,
        TestDupUserEntity,
        TestDupGroupEntity,
      ]);
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain(
      'Conflicting definitions for many-to-many join table "test_duplicated_join"',
    );
    // В ошибке перечислены оба определения с сущностями и колонками/типами
    expect(error!.message).toContain('TestDupOrderEntity.items');
    expect(error!.message).toContain(
      'test_dup_orders_order_id:Int64, test_dup_items_item_uuid:Uuid',
    );
    expect(error!.message).toContain('TestDupUserEntity.groups');
    expect(error!.message).toContain(
      'test_dup_users_user_id:Int64, test_dup_groups_group_id:Int64',
    );
  });

  it('treats mirrored declarations with different column names as conflicting', () => {
    // test_sym_join объявлен зеркально корректно; проверим, что подмена
    // имени колонки на одной стороне даёт конфликт
    const [fromLeft] = getManyToManyJoinTables([TestSymLeftEntity]);
    const [fromRight] = getManyToManyJoinTables([TestSymRightEntity]);

    const skewedRight = {
      ...fromRight,
      joinColumn: 'skewed_column',
    };
    expect(joinTableDefinitionsEquivalent(fromLeft, skewedRight)).toBe(false);
    expect(joinTableDefinitionsEquivalent(fromLeft, fromRight)).toBe(true);
  });
});

describe('buildExpectedJoinTableSchema DDL compatibility (#90)', () => {
  it('generates CREATE TABLE matching the columns the relations code reads', () => {
    const schemas = buildExpectedSchemas([TestOrderEntity, TestSkuEntity]);
    const jt = schemas.find((s) => s.tableName === 'test_order_sku');
    expect(jt).toBeDefined();

    const yql = generateCreateTableYql(jt!);
    expect(yql).toBe(
      'CREATE TABLE `test_order_sku` (\n' +
        '  `order_ref` Int64,\n' +
        '  `sku_code` Utf8,\n' +
        '  PRIMARY KEY (`order_ref`, `sku_code`)\n' +
        ')',
    );
  });

  it('keeps default uuid-based names for uuid-PK entities (backward compatibility)', () => {
    const schemas = buildExpectedSchemas([TestPhotoEntity, TestTagEntity]);
    const jt = schemas.find((s) => s.tableName === 'test_photo_tag');
    expect(jt?.columns).toEqual({
      test_photos_uuid: 'Uuid',
      test_tags_uuid: 'Uuid',
    });
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

describe('composite primary key comparison (#89)', () => {
  it('passes for identical composite PKs', () => {
    const check = checkTableSchema(
      compositePkExpected,
      compositePkDescription(['tenant_id', 'id']),
    );

    expect(check.primaryKeyMatches).toBe(true);
    expect(check.primaryKeyOrderMismatch).toBe(false);
    expect(check.missingPrimaryKeyColumns).toEqual([]);
    expect(check.extraPrimaryKeyColumns).toEqual([]);
  });

  it('preserves behavior for identical single-column PKs', () => {
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
      ),
    );

    expect(check.primaryKeyMatches).toBe(true);
    expect(check.missingPrimaryKeyColumns).toEqual([]);
    expect(check.extraPrimaryKeyColumns).toEqual([]);
    expect(check.primaryKeyOrderMismatch).toBe(false);
  });

  it('treats reordered composite PKs as different schemas', () => {
    const check = checkTableSchema(
      compositePkExpected,
      compositePkDescription(['id', 'tenant_id']),
    );

    expect(check.primaryKeyMatches).toBe(false);
    // Чистая перестановка: наборы колонок равны — диагностируется именно порядок
    expect(check.primaryKeyOrderMismatch).toBe(true);
    expect(check.missingPrimaryKeyColumns).toEqual([]);
    expect(check.extraPrimaryKeyColumns).toEqual([]);
  });

  it('distinguishes missing PK columns from reorder', () => {
    const check = checkTableSchema(
      compositePkExpected,
      compositePkDescription(['tenant_id']),
    );

    expect(check.primaryKeyMatches).toBe(false);
    expect(check.primaryKeyOrderMismatch).toBe(false);
    expect(check.missingPrimaryKeyColumns).toEqual(['id']);
    expect(check.extraPrimaryKeyColumns).toEqual([]);
  });

  it('distinguishes extra PK columns from reorder', () => {
    const check = checkTableSchema(
      compositePkExpected,
      compositePkDescription(['tenant_id', 'id', 'amount']),
    );

    expect(check.primaryKeyMatches).toBe(false);
    expect(check.primaryKeyOrderMismatch).toBe(false);
    expect(check.missingPrimaryKeyColumns).toEqual([]);
    expect(check.extraPrimaryKeyColumns).toEqual(['amount']);
  });

  it('reports reordered PK via diffSchemas with both orders', () => {
    const issues = diffSchemas(
      [compositePkExpected],
      [compositePkDescription(['id', 'tenant_id'])],
    );

    expect(issues).toContainEqual({
      tableName: 'test_composite_pk',
      kind: 'primary-key-mismatch',
      message:
        'Table "test_composite_pk" primary key column order mismatch: ' +
        'expected [tenant_id, id], actual [id, tenant_id]',
    });
  });

  it('reports missing and extra PK columns distinctly in issues', () => {
    const missingIssues = checkToIssues(
      checkTableSchema(compositePkExpected, compositePkDescription(['id'])),
    );
    expect(missingIssues).toContainEqual({
      tableName: 'test_composite_pk',
      kind: 'primary-key-mismatch',
      message:
        'Table "test_composite_pk" primary key mismatch (missing [tenant_id])',
    });

    const extraIssues = checkToIssues(
      checkTableSchema(
        compositePkExpected,
        compositePkDescription(['id', 'tenant_id', 'amount']),
      ),
    );
    expect(extraIssues).toContainEqual({
      tableName: 'test_composite_pk',
      kind: 'primary-key-mismatch',
      message:
        'Table "test_composite_pk" primary key mismatch (unexpected [amount])',
    });
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

  it('verify reports reordered composite PK as a mismatch (#89)', async () => {
    mockDescribe(compositePkDescription(['id', 'tenant_id']));

    const issues = await syncer.verify([TestCompositePkEntity]);

    expect(issues).toEqual([
      {
        tableName: 'test_composite_pk',
        kind: 'primary-key-mismatch',
        message:
          'Table "test_composite_pk" primary key column order mismatch: ' +
          'expected [tenant_id, id], actual [id, tenant_id]',
      },
    ]);
    expect(executedSql()).toEqual([]);
  });

  it('verify passes for identical composite PKs (#89)', async () => {
    mockDescribe(compositePkDescription(['tenant_id', 'id']));

    const issues = await syncer.verify([TestCompositePkEntity]);

    expect(issues).toEqual([]);
  });

  it('sync throws on reordered composite PK and executes no DDL (#89)', async () => {
    mockDescribe(compositePkDescription(['id', 'tenant_id']));

    await expect(syncer.sync([TestCompositePkEntity])).rejects.toThrow(
      /primary key mismatch \(expected \[tenant_id, id\], actual \[id, tenant_id\]\)/,
    );
    expect(executedSql()).toEqual([]);
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

// Регресс-тесты #91: describeTable различает «таблицы нет» и другие
// SCHEME_ERROR, а не-примитивные типы не деградируют до «typeId=0».
describe('YdbSchemaSyncer.describeTable: not-found vs other errors (#91)', () => {
  const sessionResult = anyPack(
    CreateSessionResultSchema,
    create(CreateSessionResultSchema, { sessionId: 'session-nf-1' }),
  );

  const issueMsg = (
    message: string,
    children?: ReturnType<typeof issueMsg>[],
  ) =>
    create(IssueMessageSchema, {
      message,
      severity: 1,
      ...(children?.length ? { issues: children } : {}),
    });

  function makeDescribeTableSyncer(describeResponse: unknown): {
    syncer: YdbSchemaSyncer;
    executedSql: () => string[];
  } {
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
    const executor = jest.fn(() => Promise.resolve([]));
    return {
      syncer: new YdbSchemaSyncer(
        driver as never,
        executor as unknown as YdbExecutor,
      ),
      executedSql: () =>
        (executor as unknown as jest.Mock).mock.calls.map((c: any) =>
          String(c[0]?.[0] ?? ''),
        ),
    };
  }

  it('returns null on NOT_FOUND status', async () => {
    const { syncer } = makeDescribeTableSyncer({
      operation: { status: StatusIds_StatusCode.NOT_FOUND },
    });

    await expect(syncer.describeTable('missing_table')).resolves.toBeNull();
  });

  it('returns null when SCHEME_ERROR reports that the path does not exist', async () => {
    const { syncer } = makeDescribeTableSyncer({
      operation: {
        status: StatusIds_StatusCode.SCHEME_ERROR,
        issues: [issueMsg("path '/local/missing_table' does not exist")],
      },
    });

    await expect(syncer.describeTable('missing_table')).resolves.toBeNull();
  });

  it('returns null for «not found» nested inside issue tree', async () => {
    const { syncer } = makeDescribeTableSyncer({
      operation: {
        status: StatusIds_StatusCode.SCHEME_ERROR,
        issues: [
          issueMsg('Scheme error', [
            issueMsg("Path '/local/missing_table' not found"),
          ]),
        ],
      },
    });

    await expect(syncer.describeTable('missing_table')).resolves.toBeNull();
  });

  it('propagates permission-style SCHEME_ERROR with context instead of returning null', async () => {
    const { syncer } = makeDescribeTableSyncer({
      operation: {
        status: StatusIds_StatusCode.SCHEME_ERROR,
        issues: [issueMsg('Access denied: no permissions for path')],
      },
    });

    await expect(syncer.describeTable('secret_table')).rejects.toThrow(
      'DescribeTable failed for "/local/secret_table": ' +
        'status=SCHEME_ERROR; Access denied: no permissions for path',
    );
  });

  it('treats issues-less SCHEME_ERROR as an error, not as missing table', async () => {
    // ydb-platform/ydb#7791: DescribeTable может не прислать issues вовсе.
    // Без текста «не существует» это нельзя считать not-found (#91).
    const { syncer } = makeDescribeTableSyncer({
      operation: { status: StatusIds_StatusCode.SCHEME_ERROR },
    });

    await expect(syncer.describeTable('maybe_table')).rejects.toThrow(
      'status=SCHEME_ERROR (no issues reported)',
    );
  });

  it('propagates non-scheme failures with readable status name', async () => {
    const { syncer } = makeDescribeTableSyncer({
      operation: {
        status: StatusIds_StatusCode.UNAUTHORIZED,
        issues: [issueMsg('Token expired')],
      },
    });

    await expect(syncer.describeTable('users')).rejects.toThrow(
      'DescribeTable failed for "/local/users": status=UNAUTHORIZED; Token expired',
    );
  });

  it('does not attempt CREATE TABLE when DescribeTable failed for a reason other than not-found (#91)', async () => {
    const { syncer, executedSql } = makeDescribeTableSyncer({
      operation: {
        status: StatusIds_StatusCode.SCHEME_ERROR,
        issues: [issueMsg("path '/local/test_users': Access denied")],
      },
    });

    await expect(syncer.sync([TestUserEntity])).rejects.toThrow(
      /Access denied/,
    );

    // Ни CREATE TABLE, ни какого-либо другого DDL
    expect(executedSql()).toEqual([]);
  });

  it('still creates table on a genuine NOT_FOUND (#91)', async () => {
    const { syncer, executedSql } = makeDescribeTableSyncer({
      operation: { status: StatusIds_StatusCode.NOT_FOUND },
    });

    await syncer.sync([TestUserEntity]);

    expect(executedSql()).toEqual([
      generateCreateTableYql(buildExpectedTableSchema(meta(TestUserEntity))),
    ]);
  });
});

describe('DescribeTable non-primitive column types (#91)', () => {
  const sessionResult = anyPack(
    CreateSessionResultSchema,
    create(CreateSessionResultSchema, { sessionId: 'session-types-1' }),
  );

  function makeTypeSyncer(
    columns: Array<{
      name: string;
      type: unknown;
    }>,
  ): YdbSchemaSyncer {
    const tableClient = {
      createSession: jest.fn(() =>
        Promise.resolve({ operation: { result: sessionResult } }),
      ),
      describeTable: jest.fn(() =>
        Promise.resolve({
          operation: {
            status: StatusIds_StatusCode.SUCCESS,
            result: anyPack(
              DescribeTableResultSchema,
              create(DescribeTableResultSchema, {
                columns: columns as never,
                primaryKey: ['uuid'],
                indexes: [],
              }),
            ),
          },
        }),
      ),
      deleteSession: jest.fn(() => Promise.resolve({})),
    };
    const driver = {
      database: '/local',
      createClient: jest.fn(() => tableClient),
    };
    return new YdbSchemaSyncer(driver as never, {} as YdbExecutor);
  }

  it('collects decimal/list/pg columns into unsupportedColumns instead of typeId=0', async () => {
    const syncer = makeTypeSyncer([
      {
        name: 'uuid',
        type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.UUID } },
      },
      {
        name: 'price',
        type: {
          type: { case: 'decimalType', value: { precision: 22, scale: 9 } },
        },
      },
      {
        name: 'tags',
        type: {
          type: {
            case: 'listType',
            value: {
              item: {
                type: { case: 'typeId', value: Type_PrimitiveTypeId.UTF8 },
              },
            },
          },
        },
      },
      {
        name: 'ext_id',
        type: {
          type: {
            case: 'pgType',
            value: { typeName: 'int4', oid: 23, typeModifier: '' },
          },
        },
      },
    ]);

    const desc = await syncer.describeTable('mixed_table');

    // Примитивная колонка осталась в columns…
    expect(desc?.columns.get('uuid')).toBe(Type_PrimitiveTypeId.UUID);
    // …а не-примитивные ушли в unsupportedColumns с фактическим типом
    expect(desc?.columns.has('price')).toBe(false);
    expect(desc?.unsupportedColumns).toEqual(
      new Map([
        ['price', 'decimal(22,9)'],
        ['tags', 'list<utf8>'],
        ['ext_id', 'pg<int4>'],
      ]),
    );
  });

  it('keeps Optional wrapper in the rendered type description', async () => {
    const syncer = makeTypeSyncer([
      {
        name: 'amount',
        type: {
          type: {
            case: 'optionalType',
            value: {
              item: {
                type: {
                  case: 'decimalType',
                  value: { precision: 22, scale: 9 },
                },
              },
            },
          },
        },
      },
    ]);

    const desc = await syncer.describeTable('optional_decimal');

    expect(desc?.unsupportedColumns?.get('amount')).toBe('decimal(22,9)?');
  });

  it('checkTableSchema treats unsupported declared column as type mismatch with actual type', () => {
    const expected = buildExpectedTableSchema(meta(TestUnsupportedTypesEntity));
    const existing: YdbTableDescription = {
      columns: new Map([['uuid', Type_PrimitiveTypeId.UUID]]),
      primaryKey: ['uuid'],
      indexes: [],
      unsupportedColumns: new Map([['price', 'decimal(22,9)']]),
    };

    const check = checkTableSchema(expected, existing);

    expect(check.missingColumns).toEqual([]);
    expect(check.typeMismatches).toEqual([
      { column: 'price', expected: 'Utf8', actual: 'decimal(22,9)' },
    ]);
    expect(checkToIssues(check)).toEqual([
      {
        tableName: 'test_unsupported_types',
        kind: 'type-mismatch',
        message:
          'Table "test_unsupported_types" column "price" type mismatch: ' +
          'expected Utf8, actual decimal(22,9)',
      },
    ]);
  });

  it('reports undeclared non-primitive columns as extra columns', () => {
    const existing: YdbTableDescription = {
      ...description(
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
      unsupportedColumns: new Map([['legacy_amount', 'list<utf8>?']]),
    };

    const check = checkTableSchema(
      buildExpectedTableSchema(meta(TestUserEntity)),
      existing,
    );

    expect(check.extraColumns).toEqual(['legacy_amount']);
  });

  it('verify reports unsupported column type with actual type info, not typeId=0', async () => {
    const syncer = makeTypeSyncer([
      {
        name: 'uuid',
        type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.UUID } },
      },
      {
        name: 'price',
        type: {
          type: { case: 'decimalType', value: { precision: 22, scale: 9 } },
        },
      },
    ]);

    const issues = await syncer.verify([TestUnsupportedTypesEntity]);

    expect(issues).toEqual([
      {
        tableName: 'test_unsupported_types',
        kind: 'type-mismatch',
        message:
          'Table "test_unsupported_types" column "price" type mismatch: ' +
          'expected Utf8, actual decimal(22,9)',
      },
    ]);
  });

  it('sync throws on unsupported column type and executes no DDL', async () => {
    const tableClient = {
      createSession: jest.fn(() =>
        Promise.resolve({ operation: { result: sessionResult } }),
      ),
      describeTable: jest.fn(() =>
        Promise.resolve({
          operation: {
            status: StatusIds_StatusCode.SUCCESS,
            result: anyPack(
              DescribeTableResultSchema,
              create(DescribeTableResultSchema, {
                columns: [
                  {
                    name: 'uuid',
                    type: {
                      type: {
                        case: 'typeId',
                        value: Type_PrimitiveTypeId.UUID,
                      },
                    },
                  },
                  {
                    name: 'price',
                    type: {
                      type: {
                        case: 'decimalType',
                        value: { precision: 22, scale: 9 },
                      },
                    },
                  },
                ] as never,
                primaryKey: ['uuid'],
                indexes: [],
              }),
            ),
          },
        }),
      ),
      deleteSession: jest.fn(() => Promise.resolve({})),
    };
    const driver = {
      database: '/local',
      createClient: jest.fn(() => tableClient),
    };
    const executor = jest.fn(() => Promise.resolve([]));
    const syncer = new YdbSchemaSyncer(
      driver as never,
      executor as unknown as YdbExecutor,
    );

    await expect(syncer.sync([TestUnsupportedTypesEntity])).rejects.toThrow(
      /column type mismatch \(price: expected Utf8, actual decimal\(22,9\)\)/,
    );
    expect((executor as unknown as jest.Mock).mock.calls).toEqual([]);
  });
});

/**
 * #23: детекция вероятных переименований колонок. Чистые литеральные
 * схемы — без декораторов, чтобы точно управлять PK/индексами/TTL.
 */
describe('checkTableSchema: column rename hints (#23)', () => {
  // Сущность переименовала label -> title; в БД осталась label
  const renameExpected = (overrides: Partial<ExpectedTableSchema> = {}) => ({
    tableName: 'photos',
    columns: { uuid: 'Uuid', title: 'Utf8' } as Record<string, YdbPrimitive>,
    primaryKey: ['uuid'],
    indexes: [],
    ...overrides,
  });

  it('suggests a rename for one missing + one extra column of the same type', () => {
    const check = checkTableSchema(
      renameExpected(),
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['label', Type_PrimitiveTypeId.UTF8],
      ]),
    );

    expect(check.missingColumns).toEqual([['title', 'Utf8']]);
    expect(check.extraColumns).toEqual(['label']);
    expect(check.likelyRenames).toEqual([{ from: 'label', to: 'title' }]);
  });

  it('does not guess when several candidates exist (#23)', () => {
    const ambiguousExpected: ExpectedTableSchema = {
      tableName: 'photos',
      columns: { uuid: 'Uuid', title: 'Utf8', flag: 'Bool' },
      primaryKey: ['uuid'],
      indexes: [],
    };
    const check = checkTableSchema(
      ambiguousExpected,
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['label', Type_PrimitiveTypeId.UTF8],
        ['legacy_flag', Type_PrimitiveTypeId.BOOL],
      ]),
    );

    expect(check.extraColumns).toEqual(['label', 'legacy_flag']);
    expect(check.likelyRenames).toEqual([]);
  });

  it('does not suggest a rename when types differ', () => {
    const check = checkTableSchema(
      renameExpected({ columns: { uuid: 'Uuid', title: 'Int32' } }),
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['label', Type_PrimitiveTypeId.UTF8],
      ]),
    );

    expect(check.likelyRenames).toEqual([]);
  });

  it('does not suggest a rename for primary key columns (#23)', () => {
    const pkInDb = checkTableSchema(
      renameExpected(),
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['label', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid', 'label'],
      ),
    );
    expect(pkInDb.likelyRenames).toEqual([]);

    const pkInEntity = checkTableSchema(
      renameExpected({ primaryKey: ['uuid', 'title'] }),
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['label', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid', 'label'],
      ),
    );
    expect(pkInEntity.likelyRenames).toEqual([]);
  });

  it('does not suggest a rename when columns participate in indexes (#23)', () => {
    const indexedInDb = checkTableSchema(
      renameExpected(),
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['label', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [{ name: 'photos__label', columns: ['label'], unique: false }],
      ),
    );
    expect(indexedInDb.likelyRenames).toEqual([]);

    const indexedInEntity = checkTableSchema(
      renameExpected({
        indexes: [{ name: 'photos__title', columns: ['title'], unique: false }],
      }),
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['label', Type_PrimitiveTypeId.UTF8],
      ]),
    );
    expect(indexedInEntity.likelyRenames).toEqual([]);
  });

  it('does not suggest a rename when columns are TTL columns (#23)', () => {
    const ttlInDb = checkTableSchema(
      renameExpected(),
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['label', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [],
        { column: 'label', expireAfterSeconds: 3600 },
      ),
    );
    expect(ttlInDb.likelyRenames).toEqual([]);

    const ttlInEntity = checkTableSchema(
      renameExpected({ ttl: { interval: 'PT1H', column: 'title' } }),
      description(
        [
          ['uuid', Type_PrimitiveTypeId.UUID],
          ['label', Type_PrimitiveTypeId.UTF8],
        ],
        ['uuid'],
        [],
        { column: 'label', expireAfterSeconds: 3600 },
      ),
    );
    expect(ttlInEntity.likelyRenames).toEqual([]);
  });

  it('does not suggest a rename when blind-index metadata is involved (#23)', () => {
    const biSiblingInDb = checkTableSchema(
      renameExpected({ columns: { uuid: 'Uuid', title: 'Utf8' } }),
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['label', Type_PrimitiveTypeId.UTF8],
        ['label_bi', Type_PrimitiveTypeId.UTF8],
      ]),
    );
    expect(biSiblingInDb.likelyRenames).toEqual([]);

    const syntheticTarget = checkTableSchema(
      {
        tableName: 'photos',
        columns: { uuid: 'Uuid', title: 'Utf8', title_bi: 'Utf8' },
        primaryKey: ['uuid'],
        indexes: [],
      },
      description([
        ['uuid', Type_PrimitiveTypeId.UUID],
        ['label', Type_PrimitiveTypeId.UTF8],
      ]),
    );
    expect(syntheticTarget.likelyRenames).toEqual([]);
  });

  it('does not suggest a rename for unsupported actual types (#91)', () => {
    const withUnsupported: YdbTableDescription = {
      columns: new Map([['uuid', Type_PrimitiveTypeId.UUID]]),
      primaryKey: ['uuid'],
      unsupportedColumns: new Map([['label', 'decimal(22,9)']]),
    };

    const result = checkTableSchema(renameExpected(), withUnsupported);
    // Тип label неизвестен (#91) — сравнение типов невозможно, подсказки нет.
    expect(result.extraColumns).toEqual(['label']);
    expect(result.missingColumns).toEqual([['title', 'Utf8']]);
    expect(result.typeMismatches).toEqual([]);
    expect(result.likelyRenames).toEqual([]);
  });
});

describe('rename-suggestion diagnostics consistency (#23)', () => {
  const expected: ExpectedTableSchema = {
    tableName: 'photos',
    columns: { uuid: 'Uuid', title: 'Utf8' },
    primaryKey: ['uuid'],
    indexes: [],
  };
  const existing: YdbTableDescription = {
    columns: new Map([
      ['uuid', Type_PrimitiveTypeId.UUID],
      ['label', Type_PrimitiveTypeId.UTF8],
    ]),
    primaryKey: ['uuid'],
  };

  it('reports missing + extra + suggestion together via checkToIssues', () => {
    const issues = checkToIssues(checkTableSchema(expected, existing));

    expect(issues.map((i) => i.kind)).toEqual([
      'missing-column',
      'extra-column',
      'rename-suggestion',
    ]);
    expect(issues[2].message).toBe(
      'Table "photos" column "label" may have been renamed to "title" — ' +
        'review the data before migrating manually',
    );
  });

  it('diffSchemas includes the same suggestion issue', () => {
    const issues = diffSchemas([expected], [existing]);

    expect(issues.filter((i) => i.kind === 'rename-suggestion')).toHaveLength(
      1,
    );
    // Расхождение само по себе не «закрыто» подсказкой: колонки по-прежнему
    // числятся отсутствующей и лишней.
    expect(issues.filter((i) => i.kind === 'missing-column')).toHaveLength(1);
    expect(issues.filter((i) => i.kind === 'extra-column')).toHaveLength(1);
  });

  it('emits no suggestion without a likely rename', () => {
    const issues = diffSchemas([expected], [null]);

    expect(issues.map((i) => i.kind)).toEqual(['missing-table']);
  });
});
