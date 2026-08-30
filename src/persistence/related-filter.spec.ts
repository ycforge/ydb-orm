import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbEncrypted,
  OneToMany,
  ManyToOne,
  ManyToMany,
  JoinTable,
  YdbBaseEntity,
} from '../index.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { createMockExecutor } from '../../test/helpers/mock-executor.js';
import {
  configureTransactionContext,
  createTransactionContext,
  runWithTransactionContext,
} from '../transaction/transaction-context.js';

// ---- Тестовая модель (#17): все типы связей + формы для ошибок ----
// Классы-цели объявляются ДО классов-владельцев singular-связей:
// emitDecoratorMetadata порождает design:type со ссылкой на класс,
// и прямая ссылка «вперёд» упала бы по TDZ.

@YdbEntity('rf_profiles')
class RfProfile extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  bio: string;
}

@YdbEntity('rf_roles')
class RfRole extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  // FK на владельца; составной PK дочерней сущности не мешает o2m-фильтру:
  // соединение идёт по колонке user_uuid, а не по PK цели.
  @YdbPrimaryColumn('Uuid')
  user_uuid: string;

  @YdbColumn('Utf8')
  role: string;

  @YdbColumn('Bool')
  is_admin: boolean;
}

@YdbEntity('rf_tags')
class RfTag extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => RfUser, (user) => user.tags)
  users?: RfUser[];
}

@YdbEntity('rf_bigs')
class RfBig extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  id: string;

  @YdbPrimaryColumn('Uuid')
  part: string;
}

class BareClass extends YdbBaseEntity {}

@YdbEntity('rf_users')
class RfUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  status: string;

  @YdbEncrypted()
  email_encrypted: string;

  @YdbColumn('Uuid')
  profile_uuid: string;

  @OneToMany(() => RfRole, (role) => role.user_uuid)
  roles?: RfRole[];

  @ManyToOne(() => RfProfile, (self) => self.profile_uuid)
  profile?: RfProfile;

  @ManyToMany(() => RfTag)
  @JoinTable('rf_users_rf_tags')
  tags?: RfTag[];
}

// Составной PK корня: one-to-many по первому PK смоделирован быть не может.
@YdbEntity('rf_composites')
class RfComposite extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  tenant_id: string;

  @YdbPrimaryColumn('Uuid')
  user_uuid: string;

  @OneToMany(() => RfRole, (role) => role.user_uuid)
  roles?: RfRole[];

  // m2o на составной PK цели — неподдерживаемая форма.
  @YdbColumn('Uuid')
  big_ref: string;

  @ManyToOne(() => RfBig, (self) => self.big_ref)
  big?: RfBig;

  // m2o с одиночным PK цели — для проверки запрета шифрованных колонок
  // и вложенных related-путей.
  @YdbColumn('Uuid')
  user_link: string;

  @ManyToOne(() => RfUser, (self) => self.user_link)
  linkedUser?: RfUser;
}

// Несовпадение типов join-колонок: Int32 (корень) vs Uuid (FK цели).
@YdbEntity('rf_mismatch_users')
class RfMismatchUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Int32')
  id: number;

  @OneToMany(() => RfRole, (role) => role.user_uuid)
  roles?: RfRole[];
}

// Join-колонка не объявлена на целевой сущности.
@YdbEntity('rf_ghosts')
class RfGhost extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @OneToMany(() => RfProfile, (profile) => profile.missing_col)
  profiles?: RfProfile[];
}

// many-to-many без @JoinTable.
@YdbEntity('rf_orphans')
class RfOrphan extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @ManyToMany(() => RfTag)
  tags?: RfTag[];
}

// Цель связи — класс без @YdbEntity.
@YdbEntity('rf_to_bare')
class RfToBare extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @ManyToOne(() => BareClass, (self) => self.bare_ref)
  bare?: BareClass;

  @YdbColumn('Uuid')
  bare_ref: string;
}

const UUID = '11111111-1111-1111-1111-111111111111';

function mockRuntime(rows: any[][] = [[]], sequential = false) {
  const mock = createMockExecutor(rows, { sequential });
  getEntityRuntime(RfUser).executor = mock.executor;
  return mock;
}

describe('Related-entity filters (#17): findAll({ relation: { column } })', () => {
  afterEach(() => {
    // Глобальные настройки транзакций не должны протекать между тестами.
    configureTransactionContext(undefined);
  });

  it('1. one-to-many: фильтр по одной колонке связанной сущности', async () => {
    const mock = mockRuntime([
      [{ uuid: UUID, status: 'active', profile_uuid: UUID }],
    ]);

    const users = await RfUser.findAll({ roles: { role: 'admin' } });

    expect(users).toHaveLength(1);
    expect(users[0].uuid).toBe(UUID);

    const sql = mock.queries[0].sql;
    expect(sql).toContain('FROM `rf_users`');
    expect(sql).toContain(
      '`uuid` IN (SELECT `user_uuid` FROM `rf_roles` WHERE `role` = $',
    );
    // Полуслияние, а не JOIN: дубликаты корневых строк невозможны.
    expect(sql.toUpperCase()).not.toContain('JOIN');
    expect(sql).not.toContain("'admin'");
    expect(sql).toMatch(/LIMIT 100 OFFSET 0$/);
  });

  it('2. несколько related-предикатов AND с обычными условиями корня', async () => {
    const mock = mockRuntime([]);

    await RfUser.findAll({
      status: 'active',
      profile: { bio: 'engineer' },
      roles: { is_admin: true },
    });

    const sql = mock.queries[0].sql;
    // Корневое равенство + два независимых IN-подзапроса через AND.
    expect(sql).toContain('`status` = $status');
    expect(sql).toContain(
      '`profile_uuid` IN (SELECT `uuid` FROM `rf_profiles` WHERE `bio` = $',
    );
    expect(sql).toContain(
      '`uuid` IN (SELECT `user_uuid` FROM `rf_roles` WHERE `is_admin` = $',
    );
    expect(sql.match(/IN \(SELECT/g)?.length).toBe(2);
    expect((mock.queries[0].params.status as any).value).toBe('active');
  });

  it('3. вложенные логические условия: $or/$and смешивают корень и связи', async () => {
    const mock = mockRuntime([]);

    await RfUser.findAll({
      $or: [{ status: 'banned' }, { roles: { role: 'admin' } }],
    });
    const orSql = mock.queries[0].sql;
    expect(orSql).toContain(
      '(`status` = $status_0_eq OR `uuid` IN (SELECT `user_uuid` FROM `rf_roles` WHERE `role` = $',
    );

    // $or ВНУТРИ предиката связи.
    await RfUser.findAll({
      roles: { $or: [{ role: 'admin' }, { is_admin: true }] },
    });
    const innerOrSql = mock.queries[1].sql;
    expect(innerOrSql).toContain(
      '`uuid` IN (SELECT `user_uuid` FROM `rf_roles` WHERE (`role` = $',
    );
    expect(innerOrSql).toContain('OR `is_admin` = $');

    // Та же связь дважды через $and: два отдельных подзапроса (семантика EXISTS).
    await RfUser.findAll({
      $and: [{ roles: { role: 'admin' } }, { roles: { is_admin: true } }],
    });
    const andSql = mock.queries[2].sql;
    expect(andSql.match(/`uuid` IN \(SELECT `user_uuid`/g)?.length).toBe(2);
    expect(andSql).toContain(') AND `uuid` IN (SELECT');

    // Вложенный related-путь: связь связи.
    getEntityRuntime(RfComposite).executor = mock.executor;
    await RfComposite.findAll({ linkedUser: { roles: { role: 'admin' } } });
    const nestedSql = mock.queries[3].sql;
    expect(nestedSql).toContain(
      '`user_link` IN (SELECT `uuid` FROM `rf_users` WHERE `uuid` IN ' +
        '(SELECT `user_uuid` FROM `rf_roles` WHERE `role` = $',
    );
  });

  it('4. several matching related rows still return the root once (no JOIN)', async () => {
    const mock = mockRuntime([
      [{ uuid: UUID, status: 'active', profile_uuid: UUID }],
    ]);

    const users = await RfUser.findAll({
      roles: { role: 'admin' },
    });

    // Один запрос, одна строка: полуслияние IN не размножает корневые строки.
    expect(mock.queries).toHaveLength(1);
    expect(users).toHaveLength(1);
    expect(mock.queries[0].sql.toUpperCase()).not.toContain('JOIN ');
  });

  it('5. unknown relation/column fails BEFORE executing SQL', async () => {
    const mock = mockRuntime();

    // Неизвестное свойство вообще (не колонка и не связь).
    await expect(RfUser.findAll({ bogus_relation: { x: 1 } })).rejects.toThrow(
      /Unknown field in WHERE: "bogus_relation"/,
    );

    // Связь существует, колонка на цели — нет.
    await expect(RfUser.findAll({ roles: { nope: 1 } })).rejects.toThrow(
      /Unknown field in WHERE: "nope" on entity RfRole/,
    );

    // Невалидная форма предиката.
    await expect(RfUser.findAll({ roles: null as any })).rejects.toThrow(
      /Invalid filter on relation "roles".*got null/,
    );
    await expect(RfUser.findAll({ roles: [{}] as any })).rejects.toThrow(
      /Invalid filter on relation "roles".*got array/,
    );

    expect(mock.executor).not.toHaveBeenCalled();
  });

  it('6. encrypted related column is rejected clearly (incl. blind index)', async () => {
    // RfComposite нужен собственный executor: проверка executor'а происходит
    // до построения WHERE, а валидация шифрованных колонок — до выполнения SQL.
    const mock = createMockExecutor([[[]]]);
    getEntityRuntime(RfComposite).executor = mock.executor;

    // Даже blind index запрещён внутри related-фильтров (#17).
    await expect(
      RfComposite.findAll({ linkedUser: { email_encrypted: 'a@b.c' } }),
    ).rejects.toThrow(
      /Cannot filter related entity RfUser by encrypted field "email_encrypted"/,
    );

    await expect(
      RfComposite.findAll({
        linkedUser: { email_encrypted_bi: 'hash' } as any,
      }),
    ).rejects.toThrow(/blind index column "email_encrypted_bi"/);

    expect(mock.executor).not.toHaveBeenCalled();
  });

  it('7. empty predicate and no-match related rows return correct results', async () => {
    // Пустой предикат {} = «есть хотя бы одна связанная строка».
    const emptyMock = mockRuntime([]);
    const none = await RfUser.findAll({ roles: {} });
    expect(none).toEqual([]);
    expect(emptyMock.queries[0].sql).toContain(
      '`uuid` IN (SELECT `user_uuid` FROM `rf_roles`) LIMIT',
    );

    // Связанные строки есть, но предикат не совпал — пустой результат корней.
    const noMatchMock = mockRuntime([[]]);
    const noMatch = await RfUser.findAll({ roles: { role: 'admin' } });
    expect(noMatch).toEqual([]);
    expect(noMatchMock.queries[0].sql).toContain('WHERE `role` = $');
  });

  it('8. explicit { trx } and ambient transaction paths are preserved', async () => {
    const base = createMockExecutor([[[]]]);
    const trx = createMockExecutor([[[]]]);
    getEntityRuntime(RfUser).executor = base.executor;

    // Явная транзакция.
    await RfUser.findAll({ roles: { role: 'admin' } }, { trx: trx.executor });
    expect(trx.queries).toHaveLength(1);
    expect(base.queries).toHaveLength(0);

    // Ambient auto-join (#98).
    configureTransactionContext({ ambient: true });
    const ambTrx = createMockExecutor([[[]]]);
    await runWithTransactionContext(
      createTransactionContext({
        transactionId: Symbol('related-filter'),
        trx: ambTrx.executor,
        db: base.executor,
        ambient: true,
      }),
      async () => {
        await RfUser.findAll({ roles: { role: 'admin' } });
      },
    );
    expect(ambTrx.queries).toHaveLength(1);
    expect(base.queries).toHaveLength(0);
  });

  it('9. generated YQL binds values via parameters only', async () => {
    const mock = mockRuntime([]);

    const { sql, values } = await RfUser.query()
      .where({ status: 'active', roles: { role: 'admin' } })
      .limit(10)
      .toYql();

    // Ни одного литерала значения в SQL — только плейсхолдеры $param.
    expect(sql).not.toContain('admin');
    expect(sql).not.toContain("'active'");
    expect(sql).toContain('LIMIT 10');
    expect(Object.keys(values)).toContain('role_0_eq');

    await RfUser.count({ roles: { is_admin: true } });
    const countSql = mock.queries[0].sql;
    expect(countSql).toContain('SELECT COUNT(*) AS cnt FROM `rf_users`');
    expect(countSql).toContain(
      '`uuid` IN (SELECT `user_uuid` FROM `rf_roles` WHERE `is_admin` = $',
    );
  });
});

describe('Related-entity filters (#17): unsupported shapes fail clearly', () => {
  beforeEach(() => {
    getEntityRuntime(RfComposite).executor = undefined;
    getEntityRuntime(RfMismatchUser).executor = undefined;
    getEntityRuntime(RfGhost).executor = undefined;
    getEntityRuntime(RfOrphan).executor = undefined;
    getEntityRuntime(RfToBare).executor = undefined;
  });

  function failingRuntime(): ReturnType<typeof createMockExecutor> {
    const mock = createMockExecutor([[[]]]);
    for (const E of [
      RfComposite,
      RfMismatchUser,
      RfGhost,
      RfOrphan,
      RfToBare,
    ]) {
      getEntityRuntime(E).executor = mock.executor;
    }
    return mock;
  }

  it('composite root PK with one-to-many is rejected', async () => {
    const mock = failingRuntime();
    await expect(
      RfComposite.findAll({ roles: { role: 'admin' } }),
    ).rejects.toThrow(/composite primary key \(tenant_id, user_uuid\)/);
    expect(mock.executor).not.toHaveBeenCalled();
  });

  it('composite target PK with many-to-one is rejected', async () => {
    const mock = failingRuntime();
    await expect(RfComposite.findAll({ big: { part: 'x' } })).rejects.toThrow(
      /target entity RfBig has a composite primary key/,
    );
    expect(mock.executor).not.toHaveBeenCalled();
  });

  it('mismatched join column types are rejected before execution', async () => {
    const mock = failingRuntime();
    await expect(
      RfMismatchUser.findAll({ roles: { role: 'admin' } }),
    ).rejects.toThrow(
      /join column types differ.*RfMismatchUser\.id is Int32, RfRole\.user_uuid is Uuid/,
    );
    expect(mock.executor).not.toHaveBeenCalled();
  });

  it('undeclared join column on target is rejected', async () => {
    const mock = failingRuntime();
    await expect(RfGhost.findAll({ profiles: { bio: 'x' } })).rejects.toThrow(
      /join column "missing_col" is not declared on target entity RfProfile/,
    );
    expect(mock.executor).not.toHaveBeenCalled();
  });

  it('many-to-many without @JoinTable is rejected', async () => {
    const mock = failingRuntime();
    await expect(RfOrphan.findAll({ tags: { name: 'x' } })).rejects.toThrow(
      /no @JoinTable is declared/,
    );
    expect(mock.executor).not.toHaveBeenCalled();
  });

  it('target without @YdbEntity is rejected', async () => {
    const mock = failingRuntime();
    await expect(
      RfToBare.findAll({ bare: { uuid: 'x' } as any }),
    ).rejects.toThrow(
      /target entity BareClass is not decorated with @YdbEntity/,
    );
    expect(mock.executor).not.toHaveBeenCalled();
  });
});

describe('Related-entity filters (#17): many-to-many through join table', () => {
  it('builds nested IN subquery via join table and returns hydrated roots', async () => {
    const mock = createMockExecutor([
      [{ uuid: UUID, status: 'active', profile_uuid: UUID }],
    ]);
    getEntityRuntime(RfUser).executor = mock.executor;

    const users = await RfUser.findAll({ tags: { name: 'urgent' } });

    const sql = mock.queries[0].sql;
    expect(sql).toContain(
      '`uuid` IN (SELECT `rf_users_uuid` FROM `rf_users_rf_tags` ' +
        'WHERE `rf_tags_uuid` IN (SELECT `uuid` FROM `rf_tags` WHERE `name` = $',
    );
    expect(users).toHaveLength(1);
    expect(users[0].uuid).toBe(UUID);
  });

  it('mirror side without own @JoinTable resolves flipped join columns', async () => {
    const mock = createMockExecutor([[[]]]);
    getEntityRuntime(RfTag).executor = mock.executor;

    await RfTag.findAll({ users: { status: 'active' } });

    expect(mock.queries[0].sql).toContain(
      '`uuid` IN (SELECT `rf_tags_uuid` FROM `rf_users_rf_tags` ' +
        'WHERE `rf_users_uuid` IN (SELECT `uuid` FROM `rf_users` WHERE `status` = $',
    );
  });
});
