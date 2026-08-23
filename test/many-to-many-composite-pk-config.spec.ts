import 'reflect-metadata';
import { Int64 } from '@ydbjs/value/primitive';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  ManyToMany,
  OneToMany,
  JoinTable,
  EagerLoad,
} from '../src/index.js';
import { getManyToManyJoinTables } from '../src/decorators/relation.decorators.js';
import { buildExpectedSchemas } from '../src/schema/schema-sync.js';
import { validateEntityMetadata } from '../src/metadata/validate-entity.js';
import { YDB_PRIMARY_KEYS_KEY } from '../src/metadata/entity-metadata.js';
import { createMockExecutor } from './helpers/mock-executor.js';

/**
 * Регрессионные тесты #87:
 *  - составной PK в many-to-many отвергается детерминированно во всех путях
 *    (схема, метаданные, eager loading, loadRelations, рантайм join-таблицы);
 *  - невыводимый тип join-колонки — ошибка конфигурации, а не тихий фолбэк Uuid;
 *  - селектор join-колонки валидируется строго: поддерживается ровно одна
 *    форма (target) => target.property, остальное — понятная ошибка;
 *  - схема и рантайм используют одно и то же резолвнутое определение
 *    join-колонок.
 */

const COMPOSITE_PK_RE =
  /composite primary keys[\s\S]*not supported in[\s\S]*many-to-many/;

const validationCtx = {
  encryptionProviderConfigured: true,
  blindIndexProviderConfigured: true,
};

// ---- Составной PK на стороне владельца (#87) ----

@YdbEntity('jc87_comp_tags')
@EagerLoad(['photos'])
class CompTag extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  tag_uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => CompOwnerPhoto, (photo) => photo.tags)
  photos?: CompOwnerPhoto[];
}

@YdbEntity('jc87_comp_photos')
@EagerLoad(['tags'])
class CompOwnerPhoto extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Uuid')
  photo_uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => CompTag, (tag) => tag.photos)
  @JoinTable('jc87_comp_join')
  tags?: CompTag[];
}

// ---- Составной PK на обратной стороне (@JoinTable на владельце с одиночным PK) ----

@YdbEntity('jc87_inv_rights')
class InvRight extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Int64')
  right_id: bigint;

  @ManyToMany(() => InvLeft, (left) => left.rights)
  lefts?: InvLeft[];
}

@YdbEntity('jc87_inv_lefts')
@EagerLoad(['rights'])
class InvLeft extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  left_id: bigint;

  @ManyToMany(() => InvRight, (right) => right.lefts)
  @JoinTable('jc87_inv_join', {
    joinColumn: 'left_ref',
    inverseJoinColumn: 'right_ref',
  })
  rights?: InvRight[];
}

// ---- Составной PK на владельце при зеркальной декларации ----

@YdbEntity('jc87_mirror_lefts')
class MirrorLeft extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  left_id: bigint;

  @ManyToMany(() => MirrorRight, (right) => right.lefts)
  rights?: MirrorRight[];
}

@YdbEntity('jc87_mirror_rights')
class MirrorRight extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Int64')
  right_id: bigint;

  @ManyToMany(() => MirrorLeft, (left) => left.rights)
  @JoinTable('jc87_mirror_join', {
    joinColumn: 'right_ref',
    inverseJoinColumn: 'left_ref',
  })
  lefts?: MirrorLeft[];
}

// ---- Нет первичного ключа вовсе (#87) ----

@YdbEntity('jc87_nopk_b')
class NoPkB extends YdbBaseEntity {
  // Обычная колонка Uuid, НЕ помечена как PK: фолбэка «колонка uuid => PK» нет.
  @YdbColumn('Uuid')
  uuid: string;

  @ManyToMany(() => NoPkA, (a) => a.bs)
  as?: NoPkA[];
}

@YdbEntity('jc87_nopk_a')
class NoPkA extends YdbBaseEntity {
  @YdbColumn('Uuid')
  uuid: string;

  @ManyToMany(() => NoPkB, (b) => b.as)
  @JoinTable('jc87_nopk_join')
  bs?: NoPkB[];
}

// ---- Битые PK-метаданные (PK указывает на необъявленную колонку) ----

@YdbEntity('jc87_ghost_b')
class GhostPeer extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  peer_uuid: string;

  @ManyToMany(() => GhostPk, (o) => o.peers)
  owners?: GhostPk[];
}

@YdbEntity('jc87_ghost_a')
class GhostPk extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  id: bigint;

  @ManyToMany(() => GhostPeer, (p) => p.owners)
  @JoinTable('jc87_ghost_join')
  peers?: GhostPeer[];
}

// ---- Селекторы join-колонок (#87) ----

@YdbEntity('jc87_sel_children')
class SelChild extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Int64')
  parent_ref: bigint;
}

@YdbEntity('jc87_sel_parents')
class SelParent extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  id: bigint;

  // Поддерживаемая форма: ровно одно чтение свойства.
  @OneToMany(() => SelChild, (child) => child.parent_ref)
  children?: SelChild[];
}

@YdbEntity('jc87_bad_chain')
class BadChainSelector extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  // Цепочка свойств — не поддерживается.
  @OneToMany(() => SelChild, (child) => child.parent.ref)
  children?: SelChild[];
}

@YdbEntity('jc87_bad_const')
class BadConstantSelector extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  // Раньше такой селектор молча давал строку 'parent_ref' — угадывание (#87).
  @OneToMany(() => SelChild, () => 'parent_ref')
  children?: SelChild[];
}

@YdbEntity('jc87_bad_call')
class BadMethodCallSelector extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @OneToMany(() => SelChild, (child) => child.getFk())
  children?: SelChild[];
}

@YdbEntity('jc87_no_jc_parent')
class NoJoinColumnParent extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @OneToMany(() => SelChild, undefined as any)
  children?: SelChild[];
}

// ---- Паритет схемы и рантайма (#87) ----

@YdbEntity('jc87_parity_skus')
class ParitySku extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  sku: string;

  @ManyToMany(() => ParityOrder, (order) => order.skus)
  orders?: ParityOrder[];
}

@YdbEntity('jc87_parity_orders')
class ParityOrder extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  order_id: bigint;

  @ManyToMany(() => ParitySku, (sku) => sku.orders)
  @JoinTable('jc87_parity_join', {
    joinColumn: 'order_ref',
    inverseJoinColumn: 'sku_code',
  })
  skus?: ParitySku[];
}

describe('many-to-many composite PK rejection is deterministic in every path (#87)', () => {
  let executors: Array<ReturnType<typeof createMockExecutor>> = [];

  function setup(rows: any[][]) {
    const mock = createMockExecutor(rows, { sequential: true });
    executors.push(mock);
    return mock;
  }

  afterEach(() => {
    for (const Entity of [
      CompTag,
      CompOwnerPhoto,
      InvRight,
      InvLeft,
      MirrorLeft,
      MirrorRight,
      NoPkB,
      NoPkA,
      GhostPeer,
      GhostPk,
      SelChild,
      SelParent,
      BadChainSelector,
      BadConstantSelector,
      BadMethodCallSelector,
      NoJoinColumnParent,
      ParitySku,
      ParityOrder,
    ]) {
      Entity.setExecutor(undefined as any);
    }
    executors = [];
  });

  it('schema generation fails for composite-PK owner with a clear error naming entity and relation', () => {
    expect(() => buildExpectedSchemas([CompOwnerPhoto, CompTag])).toThrow(
      COMPOSITE_PK_RE,
    );

    let message = '';
    try {
      buildExpectedSchemas([CompOwnerPhoto, CompTag]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('CompOwnerPhoto');
    expect(message).toContain('tenant_id, photo_uuid');
    expect(message).toContain('CompOwnerPhoto.tags');
  });

  it('schema generation fails for composite-PK inverse side too (both declaration sides)', () => {
    // @JoinTable объявлена на владельце с одиночным PK...
    expect(() => buildExpectedSchemas([InvLeft, InvRight])).toThrow(
      /InvRight has composite primary keys \(tenant_id, right_id\)/,
    );
    // ...и при зеркальной декларации на самой составной стороне.
    expect(() => buildExpectedSchemas([MirrorLeft, MirrorRight])).toThrow(
      COMPOSITE_PK_RE,
    );
    expect(() => getManyToManyJoinTables([MirrorLeft, MirrorRight])).toThrow(
      COMPOSITE_PK_RE,
    );
  });

  it('eager loading fails on composite PK from both owner and inverse sides', async () => {
    const ownerMock = setup([
      [[{ tenant_id: 't1', photo_uuid: 'u1', title: 'p1' }]],
    ]);
    CompOwnerPhoto.setExecutor(ownerMock.executor);
    await expect(CompOwnerPhoto.findAll()).rejects.toThrow(COMPOSITE_PK_RE);
    // Запрос к join-таблице не выполняется: отказ происходит при резолве.
    expect(ownerMock.queries).toHaveLength(1);

    const inverseMock = setup([[[{ tag_uuid: 'tag1', name: 'n' }]]]);
    CompTag.setExecutor(inverseMock.executor);
    await expect(CompTag.findAll()).rejects.toThrow(COMPOSITE_PK_RE);
    expect(inverseMock.queries).toHaveLength(1);
  });

  it('loadRelations() fails on composite PK identically to eager loading', async () => {
    const photo = new CompOwnerPhoto();
    photo.tenant_id = 't1';
    photo.photo_uuid = '11111111-2222-4333-8444-555555555555';

    // Eager: сущность реально загружена, поэтому резолв связки вызывается.
    CompOwnerPhoto.setExecutor(
      setup([[[{ tenant_id: 't1', photo_uuid: 'u1', title: 'p1' }]]]).executor,
    );
    let eagerMessage = '';
    try {
      await CompOwnerPhoto.findAll();
    } catch (err) {
      eagerMessage = (err as Error).message;
    }

    CompOwnerPhoto.setExecutor(setup([[[]]]).executor);
    let loadMessage = '';
    try {
      await photo.loadRelations(['tags']);
    } catch (err) {
      loadMessage = (err as Error).message;
    }

    // Один и тот же резолвер → одно и то же сообщение об ошибке.
    expect(eagerMessage).toMatch(COMPOSITE_PK_RE);
    expect(loadMessage).toBe(eagerMessage);
  });

  it('composite-PK rejection surfaces as a validation issue at module init', () => {
    const ownerIssues = validateEntityMetadata(CompOwnerPhoto, validationCtx);
    expect(ownerIssues.some((i) => COMPOSITE_PK_RE.test(i))).toBe(true);

    // Валидация обратной стороны находит ту же проблему через декларацию владельца.
    const rightIssues = validateEntityMetadata(InvRight, validationCtx);
    expect(rightIssues.some((i) => COMPOSITE_PK_RE.test(i))).toBe(true);
    expect(rightIssues.some((i) => i.includes('InvRight'))).toBe(true);
  });
});

describe('no silent Uuid fallback for join-column types (#87)', () => {
  afterEach(() => {
    NoPkA.setExecutor(undefined as any);
  });

  it('entity without any primary key fails everywhere instead of assuming Uuid', async () => {
    expect(() => getManyToManyJoinTables([NoPkA, NoPkB])).toThrow(
      /NoPkA declares no primary key/,
    );

    // Ни схема, ни рантайм не порождают таблицу с молчаливыми Uuid-колонками.
    // Схема сущности падает раньше join-таблицы — тоже без фолбэка.
    expect(() => buildExpectedSchemas([NoPkA, NoPkB])).toThrow(
      /no primary key is declared/,
    );

    NoPkA.setExecutor(createMockExecutor([[[]]]).executor);
    const a = new NoPkA();
    a.uuid = '11111111-2222-4333-8444-555555555555';

    // Рантайм падает на первом же guard'e (getPrimaryKey или резолв join-таблицы):
    // в любом случае это явная ошибка конфигурации, а не молчаливый Uuid.
    let runtimeMessage = '';
    try {
      await a.loadRelations(['bs']);
    } catch (err) {
      runtimeMessage = (err as Error).message;
    }
    expect(runtimeMessage).toContain('NoPkA');
    expect(runtimeMessage.toLowerCase()).toContain('primary key');
    expect(runtimeMessage).not.toMatch(/\bUuid\b/);
  });

  it('PK metadata pointing to an undeclared column names the PK, never falls back to Uuid', () => {
    Reflect.defineMetadata(YDB_PRIMARY_KEYS_KEY, ['ghost_id'], GhostPk);

    let message = '';
    try {
      getManyToManyJoinTables([GhostPk, GhostPeer]);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('ghost_id');
    expect(message).toContain('GhostPk');
    expect(message).toContain('there is no implicit fallback');
    // Никакого «подставим Uuid» в ошибке и в построенной схеме нет.
    expect(message).not.toMatch(/\bUuid\b/);
    expect(() => buildExpectedSchemas([GhostPk, GhostPeer])).toThrow(
      /ghost_id/,
    );
  });
});

describe('join-column selector resolution is strict (#87)', () => {
  afterEach(() => {
    for (const Entity of [
      SelParent,
      BadChainSelector,
      BadConstantSelector,
      BadMethodCallSelector,
      NoJoinColumnParent,
    ]) {
      Entity.setExecutor(undefined as any);
    }
  });

  it('supported selector (target) => target.property resolves the correct column at runtime', async () => {
    const childRow = { uuid: 'c1', parent_ref: 7n };
    const mock = createMockExecutor([[[childRow]]], { sequential: true });
    SelParent.setExecutor(mock.executor);

    const parent = new SelParent();
    parent.id = 7n;
    await parent.loadRelations(['children']);

    expect(mock.queries[0].sql).toContain('`parent_ref` IN ($p0)');
    expect(mock.queries[0].params.p0).toBeInstanceOf(Int64);
    expect(parent.children?.map((c) => c.uuid)).toEqual(['c1']);
  });

  it('unsupported selectors fail validation and runtime instead of producing a guessed name', async () => {
    const cases: Array<[typeof YdbBaseEntity, RegExp]> = [
      [BadChainSelector, /unsupported selector form \(target\.parent\.ref\)/],
      // Раньше константный селектор молча проходил со строкой 'parent_ref'.
      [BadConstantSelector, /target argument was not used/],
      [BadMethodCallSelector, /only direct property access is supported/],
    ];

    for (const [Entity, re] of cases) {
      const issues = validateEntityMetadata(Entity, validationCtx);
      const hasIssue = issues.some((i) =>
        i.includes('Invalid join column selector'),
      );
      if (!hasIssue) {
        throw new Error(
          `${Entity.name}: expected a validation issue, got: ${JSON.stringify(issues)}`,
        );
      }

      Entity.setExecutor(createMockExecutor([[[]]]).executor);
      const instance = new (Entity as any)();
      instance.uuid = '11111111-2222-4333-8444-555555555555';
      await expect(instance.loadRelations(['children'])).rejects.toThrow(re);
      await expect(instance.loadRelations(['children'])).rejects.toThrow(
        /Invalid join column selector for relation "children"/,
      );
    }
  });

  it('missing join column declaration fails with a configuration error, not undefined', async () => {
    NoJoinColumnParent.setExecutor(createMockExecutor([[[]]]).executor);

    const issues = validateEntityMetadata(NoJoinColumnParent, validationCtx);
    expect(issues.some((i) => i.includes('Join column is required'))).toBe(
      true,
    );

    const instance = new NoJoinColumnParent();
    instance.uuid = '11111111-2222-4333-8444-555555555555';
    await expect(instance.loadRelations(['children'])).rejects.toThrow(
      /Join column is required for relation "children" on NoJoinColumnParent/,
    );
  });
});

describe('schema and runtime use the same join-column resolution (#87)', () => {
  afterEach(() => {
    ParityOrder.setExecutor(undefined as any);
  });

  it('runtime SELECT reads exactly the columns of the generated schema with exact types', async () => {
    const [def] = getManyToManyJoinTables([ParityOrder, ParitySku]);
    const expected = buildExpectedSchemas([ParityOrder, ParitySku]).find(
      (s) => s.tableName === 'jc87_parity_join',
    )!;

    // Сгенерированная схема построена из того же определения.
    expect(expected.columns).toEqual({
      order_ref: 'Int64',
      sku_code: 'Utf8',
    });
    expect(expected.primaryKey).toEqual(['order_ref', 'sku_code']);
    expect(def.joinColumnType).toBe('Int64');
    expect(def.inverseJoinColumnType).toBe('Utf8');

    // Рантайм читает ровно эти колонки и биндит параметры по типу PK владельца.
    // Запросов два: выборка связей из join-таблицы и дозагрузка Sku по PK.
    const mock = createMockExecutor(
      [[[{ order_ref: 10n, sku_code: 'a1' }]], [[{ sku: 'a1' }]]],
      { sequential: true },
    );
    ParityOrder.setExecutor(mock.executor);

    const order = new ParityOrder();
    order.order_id = 10n;
    await order.loadRelations(['skus']);

    expect(mock.queries[0].sql).toBe(
      'SELECT `order_ref`, `sku_code` FROM `jc87_parity_join` WHERE `order_ref` IN ($p0)',
    );
    expect(mock.queries[0].params.p0).toBeInstanceOf(Int64);
    expect(order.skus?.map((s) => s.sku)).toEqual(['a1']);
  });
});
