import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbEnum,
  getYdbEnumMetadata,
  EagerLoad,
  OneToMany,
  YdbSecurityAAD,
  getEagerRelations,
  getYdbEntityMetadata,
} from '../src/index.js';
import { createMockExecutor } from './helpers/mock-executor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Фикстуры @EagerLoad
// ─────────────────────────────────────────────────────────────────────────────

class RelatedStub extends YdbBaseEntity {}

/** Родитель без @EagerLoad — базовый уровень иерархии. */
@YdbEntity('inh_eager_root')
class EagerRoot extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

/** Один уровень наследования: родитель задаёт eager-связь, ребёнок добавляет свою. */
@YdbEntity('inh_eager_parent')
@EagerLoad(['parentItems'])
class EagerParent extends EagerRoot {
  @OneToMany(() => RelatedStub, 'parent_uuid')
  parentItems?: RelatedStub[];
}

@YdbEntity('inh_eager_child')
@EagerLoad(['childItems'])
class EagerChild extends EagerParent {
  @OneToMany(() => RelatedStub, 'child_uuid')
  childItems?: RelatedStub[];
}

/** Ребёнок повторяет имя связи родителя — должно остаться одно вхождение. */
@YdbEntity('inh_eager_dup')
@EagerLoad(['parentItems'])
class EagerDupChild extends EagerParent {
  @OneToMany(() => RelatedStub, 'dup_uuid')
  dupItems?: RelatedStub[];
}

/** Три уровня: grandparent -> parent -> child, каждый добавляет связи. */
@YdbEntity('inh_eager_gp')
@EagerLoad(['gpItem'])
class EagerGrandParent extends YdbBaseEntity {
  @OneToMany(() => RelatedStub, 'gp_uuid')
  gpItem?: RelatedStub;
}

@YdbEntity('inh_eager_mp')
@EagerLoad(['midItemA', 'midItemB'])
class EagerMiddle extends EagerGrandParent {
  @OneToMany(() => RelatedStub, 'mid_uuid')
  midItemA?: RelatedStub;

  @OneToMany(() => RelatedStub, 'mid_uuid')
  midItemB?: RelatedStub;
}

@YdbEntity('inh_eager_lc')
@EagerLoad(['leafItem', 'midItemB'])
class EagerLeaf extends EagerMiddle {
  @OneToMany(() => RelatedStub, 'leaf_uuid')
  leafItem?: RelatedStub;

  @OneToMany(() => RelatedStub, 'leaf_uuid')
  leafDup?: RelatedStub;
}

// ─────────────────────────────────────────────────────────────────────────────
// Фикстуры @YdbEnum
// ─────────────────────────────────────────────────────────────────────────────

enum BaseStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

enum ExtendedStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@YdbEntity('inh_enum_parent')
class EnumParent extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  @YdbEnum({ values: Object.values(BaseStatus), storage: 'Utf8' })
  status!: string;
}

/**
 * Переопределяет enum унаследованного поля: другой список значений
 * и другое хранилище (Utf8 -> Int32).
 */
@YdbEntity('inh_enum_child')
class EnumChild extends EnumParent {
  @YdbColumn('Int32')
  @YdbEnum({ values: Object.values(ExtendedStatus), storage: 'Int32' })
  declare status: ExtendedStatus;
}

/** Повторный @YdbEnum на том же свойстве того же класса: last-write-wins.
 * Декораторы свойств применяются снизу вверх (стандарт TS), поэтому
 * «последнее» выполненное объявление — верхнее в исходнике.
 */
enum RepeatedStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
}

@YdbEntity('inh_enum_repeated')
class EnumRepeated extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  // Применится последним — победит этот список.
  @YdbEnum({ values: Object.values(RepeatedStatus), storage: 'Utf8' })
  @YdbEnum({ values: ['gone'], storage: 'Utf8' })
  status!: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Фикстуры @YdbSecurityAAD
// ─────────────────────────────────────────────────────────────────────────────

@YdbEntity('inh_aad_parent')
class AadParent extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  @YdbSecurityAAD()
  id!: string;
}

/** Наследует AAD-поле родителя и добавляет собственное. */
@YdbEntity('inh_aad_child')
class AadChild extends AadParent {
  @YdbPrimaryColumn('Utf8')
  @YdbSecurityAAD()
  tenant_id!: string;
}

/** Двойное применение на одном и том же поле одного класса. */
@YdbEntity('inh_aad_dup')
class AadDuplicated extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  @YdbSecurityAAD()
  @YdbSecurityAAD()
  id!: string;
}

describe('decorator inheritance semantics (#107)', () => {
  describe('@EagerLoad', () => {
    it('ребёнок без собственного @EagerLoad наследует связи родителя', () => {
      expect(getEagerRelations(EagerRoot)).toEqual([]);
      expect(getEagerRelations(EagerParent)).toEqual(['parentItems']);
    });

    it('собственный @EagerLoad ребёнка не затирает связи родителя (merge)', () => {
      expect(getEagerRelations(EagerChild)).toEqual([
        'parentItems',
        'childItems',
      ]);
    });

    it('повтор имени связи из родителя дедуплицируется', () => {
      expect(getEagerRelations(EagerDupChild)).toEqual(['parentItems']);
    });

    it('multi-level наследование накапливает связи по порядку объявления', () => {
      expect(getEagerRelations(EagerLeaf)).toEqual([
        'gpItem',
        'midItemA',
        'midItemB',
        'leafItem',
      ]);
    });

    it('copy-on-write: объявление на ребёнке не мутирует метаданные родителя', () => {
      // EagerChild / EagerDupChild / EagerLeaf уже декорированы выше —
      // родительские списки должны остаться нетронутыми.
      expect(getEagerRelations(EagerParent)).toEqual(['parentItems']);
      expect(getEagerRelations(EagerGrandParent)).toEqual(['gpItem']);
      expect(getEagerRelations(EagerMiddle)).toEqual([
        'gpItem',
        'midItemA',
        'midItemB',
      ]);
    });

    it('без наследования поведение прежнее: порядок как объявлено', () => {
      expect(getEagerRelations(EagerMiddle)).toEqual([
        'gpItem',
        'midItemA',
        'midItemB',
      ]);
    });
  });

  describe('@YdbEnum', () => {
    afterEach(() => {
      EnumChild.setExecutor(undefined as any);
      EnumRepeated.setExecutor(undefined as any);
    });

    it('переопределение на наследнике заменяет values и storage', () => {
      const childMeta = getYdbEnumMetadata(EnumChild);
      const parentMeta = getYdbEnumMetadata(EnumParent);

      expect(childMeta).toHaveLength(1);
      expect(childMeta[0]).toMatchObject({
        propertyKey: 'status',
        values: ['active', 'archived'],
        storage: 'Int32',
      });

      // Метаданные родителя не затронуты
      expect(parentMeta).toHaveLength(1);
      expect(parentMeta[0]).toMatchObject({
        propertyKey: 'status',
        values: ['active', 'inactive'],
        storage: 'Utf8',
      });
    });

    it('наследник видит эффективные метаданные через proto-chain', () => {
      const meta = getYdbEnumMetadata(EnumChild);
      expect(meta[0].storage).toBe('Int32');
    });

    it('повторное применение на том же классе: last-write-wins', () => {
      const meta = getYdbEnumMetadata(EnumRepeated);
      expect(meta).toHaveLength(1);
      expect(meta[0]).toMatchObject({
        propertyKey: 'status',
        values: ['draft', 'published'],
        storage: 'Utf8',
      });
    });

    it('переопределённые values реально применяются при save (не игнорируются)', async () => {
      const mock = createMockExecutor([[]]);
      EnumChild.setExecutor(mock.executor);

      // Без PK — save идёт по пути INSERT (как в test/ydb-enum.spec.ts).
      const entity = new EnumChild();
      (entity as any).status = ExtendedStatus.ARCHIVED;
      await EnumChild.save(entity);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `inh_enum_child`');
      // Int32-storage ребёнка: ARCHIVED = индекс 1
      const raw =
        q.params.status && typeof q.params.status === 'object'
          ? (q.params.status as any).value
          : q.params.status;
      expect(raw).toBe(1);

      // Значение 'inactive' невалидно для списка ребёнка — значит,
      // применился именно переопределённый список, а не родительский.
      const other = new EnumChild();
      (other as any).status = BaseStatus.INACTIVE;
      await expect(EnumChild.save(other)).rejects.toThrow(
        /Invalid enum value "inactive" for field "status"/,
      );
    });
  });

  describe('@YdbSecurityAAD', () => {
    it('повторное применение на том же поле не дублирует запись', () => {
      const meta = getYdbEntityMetadata(AadDuplicated)!;
      expect(meta.aadFields).toEqual(['id']);
    });

    it('унаследованное AAD-поле + собственное: каждая запись по одному разу', () => {
      const meta = getYdbEntityMetadata(AadChild)!;
      expect(meta.aadFields).toEqual(['id', 'tenant_id']);
    });

    it('метаданные родителя не содержат AAD-полей ребёнка (copy-on-write)', () => {
      const meta = getYdbEntityMetadata(AadParent)!;
      expect(meta.aadFields).toEqual(['id']);
    });
  });
});
