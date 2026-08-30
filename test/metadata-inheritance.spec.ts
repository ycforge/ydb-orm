import 'reflect-metadata';
import { jest } from '@jest/globals';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbIndex,
  YdbTtl,
  YdbEncrypted,
  EagerLoad,
  getYdbEntityMetadata,
  getYdbIndexesMetadata,
  getYdbTtlMetadata,
  getEagerRelations,
  getRegisteredYdbEntities,
  buildExpectedTableSchema,
  buildExpectedSchemas,
  generateCreateTableYql,
  validateEntityMetadata,
  validationIssuesToMessages,
  YdbSchemaSyncer,
} from '../src/index.js';
import type { ExpectedTableSchema } from '../src/index.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import type { YdbExecutor } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Регресс-тесты #92: семантика наследования метаданных.
//
// Правила (зафиксированы здесь и в README):
//  1. Сущностью является только класс с СОБСТВЕННЫМ @YdbEntity. Подкласс без
//     своего декоратора — не сущность: не наследует tableName родителя,
//     не попадает в реестр и в expected-схемы (иначе — дубликаты таблиц
//     в sync/verify/migration).
//  2. Колонки/PK/AAD/enum наследуются с copy-on-write (как и раньше).
//  3. @YdbIndex и @YdbTtl привязаны к таблице класса и НЕ наследуются:
//     класс со своей таблицей объявляет их явно. Унаследованные «по цепочке»
//     индексы/TTL родителя раньше попадали в DDL дочерней таблицы и могли
//     ссылаться на чужие колонки (например, secret_bi или переопределённый
//     тип TTL-колонки) — уроняя CREATE TABLE.
//  4. @EagerLoad наследуется объединением списков (семантика #107).
//  5. Две разные сущности с одним tableName — ошибка при построении схемы.
// ─────────────────────────────────────────────────────────────────────────────

/** Родитель: индексы, TTL, шифрованное поле с blind index. */
@YdbEntity('mih_parent')
@YdbIndex({ columns: ['email'] })
@YdbTtl({ interval: 'PT2H', column: 'expires_at' })
class ParentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  email!: string;

  @YdbEncrypted({ blindIndex: true })
  @YdbColumn('Utf8')
  secret!: string;

  @YdbColumn('Datetime')
  expires_at!: Date;
}

/**
 * Ребёнок со своей таблицей и дополнительной колонкой. Колонки родителя
 * (включая шифрование) наследуются как прежде — меняется только имя таблицы.
 */
@YdbEntity('mih_child_plain')
class PlainChildEntity extends ParentEntity {
  @YdbColumn('Utf8')
  nickname!: string;
}

/**
 * Ребёнок переопределяет тип TTL-колонки родителя на несовместимый с TTL.
 * Раньше унаследованный по цепочке @YdbTtl валидировался против схемы
 * ребёнка и ронял buildExpectedTableSchema («unsupported type Int32»),
 * а без валидации — генерировал невалидный DDL. Теперь TTL не наследуется.
 */
@YdbEntity('mih_child_retyped')
class RetypedTtlChildEntity extends ParentEntity {
  // Тип колонки в БД переопределяется декоратором (TS-тип фикстуры не важен)
  @YdbColumn('Int32')
  declare expires_at: Date;
}

/** Многоуровневая иерархия: gp -> mid -> leaf. */
@YdbEntity('mih_gp')
class GrandParentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  base_field!: string;
}

@YdbEntity('mih_mid')
@YdbIndex({ columns: ['base_field'] })
@YdbTtl({ interval: 'P1D', column: 'mid_expires_at' })
class MiddleEntity extends GrandParentEntity {
  @YdbColumn('Datetime')
  mid_expires_at!: Date;
}

@YdbEntity('mih_leaf')
class LeafEntity extends MiddleEntity {
  @YdbColumn('Int32')
  leaf_field!: number;
}

/** Подкласс БЕЗ собственного @YdbEntity — не сущность (#92). */
class UndecoratedSubEntity extends ParentEntity {
  @YdbColumn('Int32')
  extra!: number;
}

/** Ребёнок объявляет собственные индекс и TTL поверх родительских. */
@YdbEntity('mih_override_child')
@YdbIndex({ columns: ['nickname'], name: 'mih_override_child__nick' })
@YdbTtl({ interval: 'P7D', column: 'expires_at' })
class OverrideChildEntity extends ParentEntity {
  @YdbColumn('Utf8')
  nickname!: string;
}

/** @EagerLoad: сохранение семантики #107 при собственных таблицах. */
@YdbEntity('mih_eager_parent')
@EagerLoad(['parentRel'])
class EagerParentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('mih_eager_child')
@EagerLoad(['childRel'])
class EagerChildEntity extends EagerParentEntity {}

/** Дубликат tableName: родитель и ребёнок декорированы одной таблицей. */
@YdbEntity('mih_dup_table')
class DupParentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('mih_dup_table')
class DupChildEntity extends DupParentEntity {}

/** Дубликат tableName: две независимые сущности. */
@YdbEntity('mih_clash')
class ClashAEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('mih_clash')
class ClashBEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

/** Независимая валидная сущность — контроль отсутствия ложных срабатываний. */
@YdbEntity('mih_independent')
class IndependentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Bool')
  active!: boolean;
}

const meta = (entity: new (...args: any[]) => any) => {
  const m = getYdbEntityMetadata(entity);
  if (!m) throw new Error(`no metadata for ${entity.name}`);
  return m;
};

const ctx = {
  encryptionProviderConfigured: true,
  blindIndexProviderConfigured: true,
};

describe('metadata inheritance (#92)', () => {
  describe('собственный @YdbEntity обязателен', () => {
    it('подкласс без собственного @YdbEntity не является сущностью', () => {
      expect(getYdbEntityMetadata(UndecoratedSubEntity)).toBeUndefined();
    });

    it('подкласс без @YdbEntity не регистрируется в глобальном реестре', () => {
      const registered = getRegisteredYdbEntities();
      expect(registered).toContain(ParentEntity);
      expect(registered).not.toContain(UndecoratedSubEntity);
    });

    it('buildExpectedSchemas не создаёт вторую схему для таблицы родителя', () => {
      const schemas = buildExpectedSchemas([
        ParentEntity,
        UndecoratedSubEntity,
      ]);
      const names = schemas.map((s) => s.tableName);
      // Ровно одна схема на таблицу, несмотря на два класса в списке
      expect(names).toEqual(['mih_parent']);
    });

    it('validateEntityMetadata ясно сообщает про отсутствие @YdbEntity', () => {
      expect(
        validationIssuesToMessages(
          validateEntityMetadata(UndecoratedSubEntity, ctx),
        ),
      ).toEqual([
        'Class UndecoratedSubEntity is not decorated with @YdbEntity',
      ]);
    });

    it('Active Record на подклассе без @YdbEntity падает с понятной ошибкой', async () => {
      const mock = createMockExecutor([[]]);
      UndecoratedSubEntity.setExecutor(mock.executor);

      await expect(UndecoratedSubEntity.findAll()).rejects.toThrow(
        'Entity UndecoratedSubEntity is not decorated with @YdbEntity',
      );

      UndecoratedSubEntity.setExecutor(undefined);
    });
  });

  describe('одиночное наследование: колонки наследуются, таблица — своя', () => {
    it('ребёнок наследует схему/PK родителя и имеет своё имя таблицы', () => {
      const m = meta(PlainChildEntity);
      expect(m.tableName).toBe('mih_child_plain');
      expect(m.schema).toMatchObject({
        uuid: 'Uuid',
        email: 'Utf8',
        // Шифрованное поле родителя (Bytes + secret_bi) наследуется как прежде
        secret: 'Bytes',
        nickname: 'Utf8',
        expires_at: 'Datetime',
      });
      expect(m.primaryKeys).toEqual(['uuid']);
      expect(buildExpectedTableSchema(m).columns.secret_bi).toBe('Utf8');
    });
  });

  describe('многоуровневое наследование', () => {
    it('колонки накапливаются по уровням, у каждого класса своя таблица', () => {
      expect(meta(GrandParentEntity).tableName).toBe('mih_gp');
      expect(meta(MiddleEntity).tableName).toBe('mih_mid');
      expect(meta(LeafEntity).tableName).toBe('mih_leaf');

      expect(Object.keys(meta(LeafEntity).schema).sort()).toEqual([
        'base_field',
        'leaf_field',
        'mid_expires_at',
        'uuid',
      ]);
      expect(meta(GrandParentEntity).schema).not.toHaveProperty('leaf_field');
    });
  });

  describe('@YdbIndex не наследуется', () => {
    it('у класса со своей таблицей нет индексов родителя', () => {
      expect(getYdbIndexesMetadata(ParentEntity)).toHaveLength(1);
      expect(getYdbIndexesMetadata(PlainChildEntity)).toEqual([]);
      expect(buildExpectedTableSchema(meta(PlainChildEntity)).indexes).toEqual(
        [],
      );
    });

    it('индекс среднего уровня не протекает на grandparent и leaf', () => {
      expect(getYdbIndexesMetadata(MiddleEntity)).toHaveLength(1);
      expect(getYdbIndexesMetadata(GrandParentEntity)).toEqual([]);
      expect(getYdbIndexesMetadata(LeafEntity)).toEqual([]);
    });

    it('унаследованный TTL больше не валидируется против схемы ребёнка и не попадает в DDL', () => {
      // RetypedTtlChildEntity переопределяет тип колонки expires_at на Int32:
      // если бы TTL родителя наследовался, buildExpectedTableSchema упал бы
      // с «unsupported type Int32», а без валидации — сгенерировал бы
      // невалидный DDL. Теперь у ребёнка просто нет TTL.
      expect(() =>
        buildExpectedTableSchema(meta(RetypedTtlChildEntity)),
      ).not.toThrow();
      expect(
        buildExpectedTableSchema(meta(RetypedTtlChildEntity)).ttl,
      ).toBeUndefined();

      const yql = generateCreateTableYql(
        buildExpectedTableSchema(meta(PlainChildEntity)),
      );
      expect(yql).not.toContain('TTL =');
    });
  });

  describe('@YdbTtl не наследуется', () => {
    it('у класса со своей таблицей нет TTL родителя — схема строится без ошибок', () => {
      expect(getYdbTtlMetadata(PlainChildEntity)).toBeUndefined();
      expect(
        buildExpectedTableSchema(meta(PlainChildEntity)).ttl,
      ).toBeUndefined();

      // TTL среднего уровня не протекает на grandparent и leaf
      expect(getYdbTtlMetadata(GrandParentEntity)).toBeUndefined();
      expect(getYdbTtlMetadata(LeafEntity)).toBeUndefined();
      expect(getYdbTtlMetadata(MiddleEntity)).toBeDefined();
    });

    it('наследник может объявить СВОЙ TTL (guard «один раз» смотрит только свои метаданные)', () => {
      expect(() =>
        buildExpectedTableSchema(meta(OverrideChildEntity)),
      ).not.toThrow();

      const childSchema = buildExpectedTableSchema(meta(OverrideChildEntity));
      expect(childSchema.ttl).toEqual({
        interval: 'P7D',
        column: 'expires_at',
      });
      expect(childSchema.indexes).toEqual([
        {
          name: 'mih_override_child__nick',
          columns: ['nickname'],
          unique: false,
        },
      ]);

      // Метаданные родителя не тронуты (copy-on-write)
      expect(getYdbTtlMetadata(ParentEntity)).toEqual({
        interval: 'PT2H',
        column: 'expires_at',
      });
      expect(getYdbIndexesMetadata(ParentEntity)).toEqual([
        { columns: ['email'] },
      ]);
    });
  });

  describe('@EagerLoad: семантика #107 сохранена', () => {
    it('связи родителя и ребёнка объединяются, у каждого класса своя таблица', () => {
      expect(getEagerRelations(EagerParentEntity)).toEqual(['parentRel']);
      expect(getEagerRelations(EagerChildEntity)).toEqual([
        'parentRel',
        'childRel',
      ]);
      expect(meta(EagerChildEntity).tableName).toBe('mih_eager_child');
    });
  });

  describe('copy-on-write', () => {
    it('добавление колонок/индексов/TTL у наследника не мутирует метаданные родителя', () => {
      const parentSchema = buildExpectedTableSchema(meta(ParentEntity));

      // OverrideChildEntity уже декорирован выше — родитель не изменился
      expect(parentSchema.columns).not.toHaveProperty('nickname');
      expect(parentSchema.indexes).toEqual([
        { name: 'mih_parent__email', columns: ['email'], unique: false },
      ]);
      expect(parentSchema.ttl).toEqual({
        interval: 'PT2H',
        column: 'expires_at',
      });

      // И у промежуточных уровней многоуровневой иерархии тоже
      expect(
        buildExpectedTableSchema(meta(GrandParentEntity)).columns,
      ).not.toHaveProperty('leaf_field');
      expect(
        buildExpectedTableSchema(meta(MiddleEntity)).columns,
      ).not.toHaveProperty('leaf_field');
    });
  });

  describe('дубликаты tableName детектируются', () => {
    it('родитель и ребёнок с одной таблицей — ошибка с именами классов', () => {
      expect(() =>
        buildExpectedSchemas([DupParentEntity, DupChildEntity]),
      ).toThrow(
        'Duplicate table name "mih_dup_table": entities DupParentEntity ' +
          'and DupChildEntity both map to it',
      );
    });

    it('две независимые сущности с одной таблицей — та же ошибка', () => {
      expect(() => buildExpectedSchemas([ClashAEntity, ClashBEntity])).toThrow(
        'Duplicate table name "mih_clash"',
      );
    });

    it('повтор одного и того же класса в списке дедуплицируется', () => {
      const schemas = buildExpectedSchemas([
        IndependentEntity,
        IndependentEntity,
      ]);
      expect(schemas).toHaveLength(1);
      expect(schemas[0].tableName).toBe('mih_independent');
    });
  });

  describe('одна консистентная ожидаемая схема на таблицу', () => {
    let schemas: ExpectedTableSchema[];

    beforeEach(() => {
      schemas = buildExpectedSchemas([
        ParentEntity,
        UndecoratedSubEntity,
        LeafEntity,
        IndependentEntity,
        IndependentEntity,
      ]);
    });

    it('имена таблиц уникальны', () => {
      const names = schemas.map((s) => s.tableName);
      expect(new Set(names).size).toBe(names.length);
      // UndecoratedSubEntity не добавляет вторую схему для mih_parent
      expect(names.sort()).toEqual([
        'mih_independent',
        'mih_leaf',
        'mih_parent',
      ]);
    });

    it('sync выполняет CREATE TABLE ровно один раз на таблицу', async () => {
      const executor = jest.fn(() =>
        Promise.resolve([]),
      ) as unknown as YdbExecutor;
      const syncer = new YdbSchemaSyncer({} as never, executor);
      jest.spyOn(syncer, 'describeTable').mockResolvedValue(null);

      await syncer.sync([ParentEntity, UndecoratedSubEntity]);

      const executedSql = (): string[] =>
        (executor as unknown as jest.Mock).mock.calls.map(
          (c: any) => c[0][0] as string,
        );
      expect(executedSql()).toEqual([
        generateCreateTableYql(buildExpectedTableSchema(meta(ParentEntity))),
      ]);
    });

    it('verify выдаёт ровно один набор issues на таблицу', async () => {
      const executor = jest.fn(() =>
        Promise.resolve([]),
      ) as unknown as YdbExecutor;
      const syncer = new YdbSchemaSyncer({} as never, executor);
      jest.spyOn(syncer, 'describeTable').mockResolvedValue(null);

      const issues = await syncer.verify([
        ParentEntity,
        UndecoratedSubEntity,
        IndependentEntity,
      ]);

      expect(issues).toEqual([
        {
          tableName: 'mih_parent',
          kind: 'missing-table',
          message: 'Table "mih_parent" does not exist',
        },
        {
          tableName: 'mih_independent',
          kind: 'missing-table',
          message: 'Table "mih_independent" does not exist',
        },
      ]);
    });
  });

  describe('валидные независимые сущности не затронуты', () => {
    it('метаданные независимой сущности строятся как прежде', () => {
      const schema = buildExpectedTableSchema(meta(IndependentEntity));
      expect(schema).toEqual({
        tableName: 'mih_independent',
        columns: { uuid: 'Uuid', active: 'Bool' },
        primaryKey: ['uuid'],
        indexes: [],
        ttl: undefined,
      });
      expect(validateEntityMetadata(IndependentEntity, ctx)).toEqual([]);
    });
  });
});
