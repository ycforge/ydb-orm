import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToMany,
  JoinTable,
  EagerLoad,
} from '../src/index.js';
import { getManyToManyJoinTables } from '../src/decorators/relation.decorators.js';
import { buildExpectedSchemas } from '../src/schema/schema-sync.js';
import { createMockExecutor } from './helpers/mock-executor.js';

/**
 * Глобальная согласованность рантайма и схемы (#139): конфликт объявлений
 * одного имени join-таблицы, не видимый внутри пары сущностей (объявление
 * в другом месте модели), должен одинаково отвергаться schema sync/verify/
 * миграциями и рантайм-чтением relations.
 *
 * Реестр @YdbEntity изолирован на файл теста, поэтому «вторгающаяся»
 * сущность живёт здесь отдельно от остальных спеков.
 */

// Валидная пара: зеркальные эквивалентные декларации одной таблицы
@YdbEntity('fp_parents')
@EagerLoad(['children'])
class FpParentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  parent_id: bigint;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => FpChildEntity, (child) => child.parents)
  @JoinTable('fp_join', {
    joinColumn: 'parent_ref',
    inverseJoinColumn: 'child_key',
  })
  children?: FpChildEntity[];
}

@YdbEntity('fp_children')
class FpChildEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  child_key: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => FpParentEntity, (parent) => parent.children)
  @JoinTable('fp_join', {
    joinColumn: 'child_key',
    inverseJoinColumn: 'parent_ref',
  })
  parents?: FpParentEntity[];
}

// Вторгающаяся пара: то же имя таблицы, другое физическое описание
@YdbEntity('fp_intruders')
class FpIntruderEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  intruder_id: bigint;

  @YdbColumn('Utf8')
  tag: string;

  @ManyToMany(() => FpOtherEntity, (other) => other.intruders)
  @JoinTable('fp_join')
  others?: FpOtherEntity[];
}

@YdbEntity('fp_others')
class FpOtherEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  other_code: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => FpIntruderEntity, (intruder) => intruder.others)
  intruders?: FpIntruderEntity[];
}

describe('foreign conflicting join-table declarations (#139)', () => {
  afterEach(() => {
    for (const Entity of [
      FpParentEntity,
      FpChildEntity,
      FpIntruderEntity,
      FpOtherEntity,
    ]) {
      Entity.setExecutor(undefined as any);
    }
  });

  it('schema generation accepts the pair alone and rejects it with the intruder', () => {
    const alone = getManyToManyJoinTables([FpParentEntity, FpChildEntity]);
    expect(alone).toHaveLength(1);
    expect(alone[0].tableName).toBe('fp_join');
    expect(alone[0].joinColumn).toBe('parent_ref');

    expect(() =>
      getManyToManyJoinTables([
        FpParentEntity,
        FpChildEntity,
        FpIntruderEntity,
        FpOtherEntity,
      ]),
    ).toThrow(/Conflicting definitions for many-to-many join table "fp_join"/);
  });

  it('buildExpectedSchemas (sync/verify/migrations) fails on the same set', () => {
    expect(() =>
      buildExpectedSchemas([
        FpParentEntity,
        FpChildEntity,
        FpIntruderEntity,
        FpOtherEntity,
      ]),
    ).toThrow(/Conflicting definitions for many-to-many join table "fp_join"/);
  });

  it('explicit loadRelations fails identically at runtime', async () => {
    const mock = createMockExecutor([[]]);
    FpParentEntity.setExecutor(mock.executor);

    const parent = new FpParentEntity();
    parent.parent_id = 1n;

    await expect(parent.loadRelations(['children'])).rejects.toThrow(
      /Conflicting definitions for many-to-many join table "fp_join"[\s\S]*FpIntruderEntity\.others/,
    );
    expect(mock.queries).toHaveLength(0);
  });

  it('eager loading fails identically at runtime', async () => {
    const mock = createMockExecutor([[[{ parent_id: 1n, name: 'p' }]]], {
      sequential: true,
    });
    FpParentEntity.setExecutor(mock.executor);

    await expect(FpParentEntity.findAll()).rejects.toThrow(
      /Conflicting definitions for many-to-many join table "fp_join"[\s\S]*FpIntruderEntity\.others/,
    );
  });
});
