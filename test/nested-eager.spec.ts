import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToMany,
  ManyToOne,
  ManyToMany,
  JoinTable,
  EagerLoad,
  AfterFind,
  getOrCreateRepository,
  MAX_IN_CLAUSE_VALUES,
} from '../src/index.js';
import {
  runWithTransactionContext,
  configureTransactionContext,
} from '../src/transaction/transaction-context.js';
import { createMockExecutor } from './helpers/mock-executor.js';

/**
 * Регрессионные тесты #16: вложенная eager-загрузка многоуровневых путей
 * (@EagerLoad(['tags.owner'])), без N+1 на любой глубине.
 *
 * Модель: rootPhoto (m2m tags) -> Tag (m2o owner) -> User.
 * Для путей, свободных от m2m, используется цепочка Album(1:N photo) ->
 * photo(m2m tags) -> tag(m2o owner) -> user.
 */

// ---- Одноуровневая модель (регрессия: eager не сломан) ----

@YdbEntity('nea_photos')
@EagerLoad(['tags'])
class OneLevelPhoto extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @ManyToMany(() => OneLevelTag, (t) => t.photos)
  @JoinTable('nea_photo_tag', {
    joinColumn: 'photo_uuid',
    inverseJoinColumn: 'tag_uuid',
  })
  tags?: any[];
}

@YdbEntity('nea_tags')
class OneLevelTag extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => OneLevelPhoto, (p) => p.tags)
  photos?: any[];
}

// ---- Двухуровневая модель: photo -> (m2m) tags -> (m2o) owner ----

@YdbEntity('neb_photos')
@EagerLoad(['tags.owner'])
class TwoLevelPhoto extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => TwoLevelTag, (t) => t.photos)
  @JoinTable('neb_photo_tag', {
    joinColumn: 'photo_uuid',
    inverseJoinColumn: 'tag_uuid',
  })
  tags?: any[];

  @ManyToOne(() => TwoLevelUser, 'user_uuid')
  owner?: any;
}

@YdbEntity('neb_tags')
class TwoLevelTag extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbColumn('Utf8')
  owner_uuid: string;

  @ManyToOne(() => TwoLevelUser, 'owner_uuid')
  owner?: any;

  @ManyToMany(() => TwoLevelPhoto, (p) => p.tags)
  photos?: any[];
}

@YdbEntity('neb_users')
class TwoLevelUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  login: string;
}

// ---- Трёхуровневая модель: album(1:N)photos(m2m)tags(m2o)user ----

@YdbEntity('nec_albums')
@EagerLoad(['photos.tags.owner'])
class ThreeLevelAlbum extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @OneToMany(() => ThreeLevelPhoto, 'album_uuid')
  photos?: any[];
}

@YdbEntity('nec_photos')
class ThreeLevelPhoto extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  album_uuid: string;

  @YdbColumn('Utf8')
  user_uuid: string;

  @ManyToMany(() => ThreeLevelTag, (t) => t.photos)
  @JoinTable('nec_photo_tag', {
    joinColumn: 'photo_uuid',
    inverseJoinColumn: 'tag_uuid',
  })
  tags?: any[];

  @ManyToOne(() => ThreeLevelUser, 'user_uuid')
  user?: any;
}

@YdbEntity('nec_tags')
class ThreeLevelTag extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbColumn('Utf8')
  owner_uuid: string;

  @ManyToOne(() => ThreeLevelUser, 'owner_uuid')
  owner?: any;

  @ManyToMany(() => ThreeLevelPhoto, (p) => p.tags)
  photos?: any[];
}

@YdbEntity('nec_users')
class ThreeLevelUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  login: string;
}

// ---- Self-referencing eager-путь для проверки завершимости (#83/#16) ----

@YdbEntity('nef_nodes')
@EagerLoad(['parent.parent'])
class SelfNode extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  name?: string;

  @YdbColumn('Uuid')
  parentUuid?: string;

  @ManyToOne(() => SelfNode, (e) => e.parentUuid)
  parent?: SelfNode;
}

// ---- Цикл for послеFind-порядка (#83/#107) ----

const afterFindCalls: string[] = [];

@YdbEntity('neg_photo')
@EagerLoad(['tags.owner'])
class OrderPhoto extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @ManyToMany(() => OrderTag, (t) => t.photos)
  @JoinTable('neg_photo_tag', {
    joinColumn: 'photo_uuid',
    inverseJoinColumn: 'tag_uuid',
  })
  tags?: any[];

  @AfterFind
  onFound() {
    afterFindCalls.push(`photo:${this.uuid}`);
  }
}

@YdbEntity('neg_tag')
class OrderTag extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @YdbColumn('Utf8')
  owner_uuid: string;

  @ManyToOne(() => OrderUser, 'owner_uuid')
  owner?: any;

  @AfterFind
  onFound() {
    afterFindCalls.push(`tag:${this.uuid}:owner=${this.owner?.uuid ?? '-'}`);
  }
}

@YdbEntity('neg_user')
class OrderUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  login: string;

  @AfterFind
  onFound() {
    afterFindCalls.push(`user:${this.uuid}`);
  }
}

@YdbEntity('nek_invalid')
@EagerLoad(['nope.owner'])
class InvalidPathPhoto extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;
}

function photo(uuid: string): TwoLevelPhoto {
  const p = new TwoLevelPhoto();
  p.uuid = uuid;
  p.title = '';
  return p;
}

describe('#16: вложенная eager-load', () => {
  afterEach(() => {
    afterFindCalls.length = 0;
    OneLevelPhoto.setExecutor(undefined as any);
    OneLevelTag.setExecutor(undefined as any);
    TwoLevelPhoto.setExecutor(undefined as any);
    TwoLevelTag.setExecutor(undefined as any);
    TwoLevelUser.setExecutor(undefined as any);
    ThreeLevelAlbum.setExecutor(undefined as any);
    ThreeLevelPhoto.setExecutor(undefined as any);
    ThreeLevelTag.setExecutor(undefined as any);
    ThreeLevelUser.setExecutor(undefined as any);
    SelfNode.setExecutor(undefined as any);
    OrderPhoto.setExecutor(undefined as any);
    OrderTag.setExecutor(undefined as any);
    OrderUser.setExecutor(undefined as any);
    InvalidPathPhoto.setExecutor(undefined as any);
  });

  it('одноуровневая eager-load остаётся без изменений', async () => {
    const roots = Array.from({ length: 3 }, (_, i) => {
      const p = new OneLevelPhoto();
      p.uuid = `a${i}`;
      return p;
    });
    const linkRows = roots.flatMap((p) => [
      { photo_uuid: p.uuid, tag_uuid: `${p.uuid}-1` },
      { photo_uuid: p.uuid, tag_uuid: `${p.uuid}-2` },
    ]);
    const tagRows = linkRows.map((l) => ({
      uuid: l.tag_uuid,
      label: l.tag_uuid,
    }));

    const mock = createMockExecutor([[linkRows], [tagRows]], {
      sequential: true,
    });
    OneLevelPhoto.setExecutor(mock.executor);
    OneLevelTag.setExecutor(mock.executor);

    await getOrCreateRepository(OneLevelPhoto).relations.loadEagerRelations(
      roots,
    );

    expect(mock.queries).toHaveLength(2);
    expect(mock.queries[0].sql).toContain('FROM `nea_photo_tag`');
    expect(mock.queries[0].sql).toContain('`photo_uuid` IN');
    expect(Object.keys(mock.queries[0].params)).toHaveLength(3);
    expect(mock.queries[1].sql).toContain('FROM `nea_tags`');

    for (const r of roots) {
      expect(r.tags?.map((t) => t.uuid).sort()).toEqual([
        `${r.uuid}-1`,
        `${r.uuid}-2`,
      ]);
    }
  });

  it('tags.owner загружается на двух уровнях', async () => {
    const p = photo('p1');
    const linkRows = [
      { photo_uuid: 'p1', tag_uuid: 't1' },
      { photo_uuid: 'p1', tag_uuid: 't2' },
    ];
    const tagRows = [
      { uuid: 't1', name: 'first', owner_uuid: 'u1' },
      { uuid: 't2', name: 'second', owner_uuid: 'u2' },
    ];
    const userRows = [
      { uuid: 'u1', login: 'alice' },
      { uuid: 'u2', login: 'bob' },
    ];

    const mock = createMockExecutor([[linkRows], [tagRows], [userRows]], {
      sequential: true,
    });
    TwoLevelPhoto.setExecutor(mock.executor);
    TwoLevelTag.setExecutor(mock.executor);
    TwoLevelUser.setExecutor(mock.executor);

    await getOrCreateRepository(TwoLevelPhoto).relations.loadEagerRelations([
      p,
    ]);

    // join-таблица + теги + владельцы — 3 батч-запроса.
    expect(mock.queries).toHaveLength(3);
    expect(mock.queries[0].sql).toContain('FROM `neb_photo_tag`');
    expect(mock.queries[1].sql).toContain('FROM `neb_tags`');
    expect(mock.queries[2].sql).toContain('FROM `neb_users`');
    expect(mock.queries[2].sql).toContain('`uuid` IN');

    expect(p.tags).toHaveLength(2);
    expect(p.tags?.[0].owner?.login).toBe('alice');
    expect(p.tags?.[1].owner?.login).toBe('bob');
  });

  it('трёхуровневый путь (album -> photos -> tags -> owner)', async () => {
    const album = new ThreeLevelAlbum();
    album.uuid = 'al1';

    const photoRows = [
      { uuid: 'ph1', album_uuid: 'al1', user_uuid: '' },
      { uuid: 'ph2', album_uuid: 'al1', user_uuid: '' },
    ];
    const linkRows = [
      { photo_uuid: 'ph1', tag_uuid: 'tagA' },
      { photo_uuid: 'ph2', tag_uuid: 'tagB' },
    ];
    const tagRows = [
      { uuid: 'tagA', name: 'x', owner_uuid: 'own1' },
      { uuid: 'tagB', name: 'y', owner_uuid: 'own2' },
    ];
    const userRows = [
      { uuid: 'own1', login: 'u1' },
      { uuid: 'own2', login: 'u2' },
    ];

    const mock = createMockExecutor(
      [[photoRows], [linkRows], [tagRows], [userRows]],
      { sequential: true },
    );
    ThreeLevelAlbum.setExecutor(mock.executor);
    ThreeLevelPhoto.setExecutor(mock.executor);
    ThreeLevelTag.setExecutor(mock.executor);
    ThreeLevelUser.setExecutor(mock.executor);

    await getOrCreateRepository(ThreeLevelAlbum).relations.loadEagerRelations([
      album,
    ]);

    // photos + join + tags + owner = 4 батч-запроса на 4 уровнях пути.
    expect(mock.queries).toHaveLength(4);

    expect(album.photos).toHaveLength(2);
    expect(album.photos?.[0].tags?.[0].owner?.login).toBe('u1');
    expect(album.photos?.[1].tags?.[0].owner?.login).toBe('u2');
  });

  it('100 корней не дают per-root запросов ни на одном уровне', async () => {
    const roots = Array.from({ length: 100 }, (_, i) =>
      photo(`ph${String(i).padStart(3, '0')}`),
    );
    const linkRows = roots.map((p) => ({
      photo_uuid: p.uuid,
      tag_uuid: `tag-${p.uuid}`,
    }));
    const tagRows = linkRows.map((l) => ({
      uuid: l.tag_uuid,
      name: l.tag_uuid,
      owner_uuid: `user-${l.photo_uuid}`,
    }));
    const userRows = tagRows.map((t) => ({
      uuid: t.owner_uuid,
      login: t.owner_uuid,
    }));

    const mock = createMockExecutor([[linkRows], [tagRows], [userRows]], {
      sequential: true,
    });
    TwoLevelPhoto.setExecutor(mock.executor);
    TwoLevelTag.setExecutor(mock.executor);
    TwoLevelUser.setExecutor(mock.executor);

    await getOrCreateRepository(TwoLevelPhoto).relations.loadEagerRelations(
      roots,
    );

    // ровно 3 запроса: join + теги + владельцы — независимо от 100 корней,
    // каждый с 100 параметрами IN (...).
    expect(mock.queries).toHaveLength(3);
    expect(mock.queries.map((q) => Object.keys(q.params).length)).toEqual([
      100, 100, 100,
    ]);
    for (const r of roots) {
      expect(r.tags?.[0].owner?.uuid).toBe(`user-${r.uuid}`);
    }
  });

  it('пустые промежуточные наборы не выполняют лишних SQL', async () => {
    const p = photo('p1');
    // join-таблица возвращает ноль ссылок.
    const mock = createMockExecutor([[[]]], { sequential: true });
    TwoLevelPhoto.setExecutor(mock.executor);

    await getOrCreateRepository(TwoLevelPhoto).relations.loadEagerRelations([
      p,
    ]);

    // Только 1 запрос (join). Выборка тегов и владельцев не выполняется.
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain('FROM `neb_photo_tag`');
    expect(p.tags).toEqual([]);
  });

  it('дубликаты промежуточных ключей исключаются до IN (...)', async () => {
    const a = photo('a');
    const b = photo('b');
    const share = photo('a'); // тот же PK, что у a — дубликат владельца
    const roots = [a, share, b];
    b.uuid = 'b2';

    const linkRows = [
      { photo_uuid: a.uuid, tag_uuid: 'tag1' },
      { photo_uuid: share.uuid, tag_uuid: 'tag1' },
      { photo_uuid: b.uuid, tag_uuid: 'tag2' },
    ];
    const tagRows = [
      { uuid: 'tag1', name: 'x', owner_uuid: 'u1' },
      { uuid: 'tag2', name: 'y', owner_uuid: 'u2' },
    ];
    const userRows = [
      { uuid: 'u1', login: 'a' },
      { uuid: 'u2', login: 'b' },
    ];

    const mock = createMockExecutor([[linkRows], [tagRows], [userRows]], {
      sequential: true,
    });
    TwoLevelPhoto.setExecutor(mock.executor);
    TwoLevelTag.setExecutor(mock.executor);
    TwoLevelUser.setExecutor(mock.executor);

    await getOrCreateRepository(TwoLevelPhoto).relations.loadEagerRelations(
      roots,
    );

    expect(mock.queries).toHaveLength(3);
    // join IN (...) должен содержать уникальные ключи: a, b2 → 2 параметра.
    expect(Object.keys(mock.queries[0].params)).toHaveLength(2);
    // У дубликата владельца (share, тот же PK, что у a) свой массив тегов,
    // но не разделяемый с оригиналом.
    expect(roots[0].tags).not.toBe(roots[2].tags);
    expect(roots[0].tags?.[0]?.uuid).toBe('tag1');
    expect(roots[2].tags?.[0]?.uuid).toBe('tag2');
  });

  it(`чанкинг тегов при >${MAX_IN_CLAUSE_VALUES} использует несколько IN`, async () => {
    const photoCount = 700;
    const roots = Array.from({ length: photoCount }, (_, i) =>
      photo(`p${String(i).padStart(4, '0')}`),
    );
    const linkRows = roots.map((p) => ({
      photo_uuid: p.uuid,
      tag_uuid: `t${p.uuid}`,
    }));
    const tagRows = linkRows.map((l) => ({
      uuid: l.tag_uuid,
      name: l.tag_uuid,
      owner_uuid: 'u-common',
    }));

    const mock = createMockExecutor(
      [[linkRows], [tagRows], [[{ uuid: 'u-common', login: 'common' }]]],
      { sequential: true },
    );
    TwoLevelPhoto.setExecutor(mock.executor);
    TwoLevelTag.setExecutor(mock.executor);
    TwoLevelUser.setExecutor(mock.executor);

    await getOrCreateRepository(TwoLevelPhoto).relations.loadEagerRelations(
      roots,
    );

    const tagQueries = mock.queries.filter((q) =>
      q.sql.includes('FROM `neb_tags`'),
    );
    // 700 тегов → чанки 500 + 200.
    expect(tagQueries).toHaveLength(2);
    expect(tagQueries.map((q) => Object.keys(q.params).length)).toEqual([
      MAX_IN_CLAUSE_VALUES,
      photoCount - MAX_IN_CLAUSE_VALUES,
    ]);
  });

  it('циклическая self-referencing eager-связь завершается безопасно', async () => {
    const nodeA = new SelfNode();
    nodeA.uuid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaaaaaa';
    nodeA.name = 'A';
    const nodeB = new SelfNode();
    nodeB.uuid = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbbbb';
    nodeB.name = 'B';
    // Цикл в данных: A -> B -> A.
    nodeA.parentUuid = nodeB.uuid;
    nodeB.parentUuid = nodeA.uuid;

    const rootRows = [
      { uuid: nodeA.uuid, name: 'A', parentUuid: nodeB.uuid },
      { uuid: nodeB.uuid, name: 'B', parentUuid: nodeA.uuid },
    ];
    const batch = [
      { uuid: nodeB.uuid, name: 'B', parentUuid: nodeA.uuid },
      { uuid: nodeA.uuid, name: 'A', parentUuid: nodeB.uuid },
    ];

    const mock = createMockExecutor([[rootRows], [batch], [batch]], {
      sequential: true,
    });
    SelfNode.setExecutor(mock.executor);

    const found = await SelfNode.findAll();

    // Ровно 3 запроса: корни + два уровня parent (путь конечен), без рекурсии.
    expect(found).toHaveLength(2);
    expect(mock.queries).toHaveLength(3);
    expect(found[0].parent?.name).toBe('B');
    // Глубина пути фиксирована — третий уровень не загружается.
    expect(found[0].parent?.parent?.name).toBe('A');
  });

  it('afterFind срабатывает ровно один раз и в документированном порядке', async () => {
    const rootRows = [{ uuid: 'p1', title: '' }];
    const linkRows = [{ photo_uuid: 'p1', tag_uuid: 't1' }];
    const tagRows = [{ uuid: 't1', name: 'x', owner_uuid: 'u1' }];
    const userRows = [{ uuid: 'u1', login: 'alice' }];

    const mock = createMockExecutor(
      [[rootRows], [linkRows], [tagRows], [userRows]],
      { sequential: true },
    );
    OrderPhoto.setExecutor(mock.executor);
    OrderTag.setExecutor(mock.executor);
    OrderUser.setExecutor(mock.executor);

    await OrderPhoto.findAll();

    // Каждый инстанс — ровно один afterFind. Порядок — потомки раньше
    // родителей (leaf -> промежуточный -> корень), и последний увидел
    // присоединённые связи.
    expect(afterFindCalls).toEqual(['user:u1', 'tag:t1:owner=u1', 'photo:p1']);
    // Пять гидратированных инстансов (корень + тег + user) — три срабатывания.
    expect(afterFindCalls).toHaveLength(3);
  });

  it('явный { trx } использует один транзакционный executor на всех уровнях', async () => {
    const p = photo('p1');
    const linkRows = [{ photo_uuid: 'p1', tag_uuid: 't1' }];
    const tagRows = [{ uuid: 't1', name: 'x', owner_uuid: 'u1' }];
    const userRows = [{ uuid: 'u1', login: 'a' }];

    const dbMock = createMockExecutor([[]]);
    const trxMock = createMockExecutor([[linkRows], [tagRows], [userRows]], {
      sequential: true,
    });
    TwoLevelPhoto.setExecutor(dbMock.executor);
    TwoLevelTag.setExecutor(dbMock.executor);
    TwoLevelUser.setExecutor(dbMock.executor);

    await getOrCreateRepository(TwoLevelPhoto).relations.loadEagerRelations(
      [p],
      { trx: trxMock.executor },
    );

    expect(dbMock.queries).toHaveLength(0);
    expect(trxMock.queries).toHaveLength(3);
    expect(p.tags?.[0]?.owner?.login).toBe('a');
  });

  it('ambient-контекст использует активную транзакцию для всех уровней', async () => {
    const p = photo('p1');
    const linkRows = [{ photo_uuid: 'p1', tag_uuid: 't1' }];
    const tagRows = [{ uuid: 't1', name: 'x', owner_uuid: 'u1' }];
    const userRows = [{ uuid: 'u1', login: 'a' }];

    const dbMock = createMockExecutor([[]]);
    const trxMock = createMockExecutor([[linkRows], [tagRows], [userRows]], {
      sequential: true,
    });
    TwoLevelPhoto.setExecutor(dbMock.executor);
    TwoLevelTag.setExecutor(dbMock.executor);
    TwoLevelUser.setExecutor(dbMock.executor);

    configureTransactionContext({ ambient: true });
    try {
      await runWithTransactionContext(
        {
          trx: trxMock.executor,
          db: dbMock.executor,
          ambient: true,
        },
        async () => {
          await getOrCreateRepository(
            TwoLevelPhoto,
          ).relations.loadEagerRelations([p]);
        },
      );
    } finally {
      configureTransactionContext();
    }

    expect(dbMock.queries).toHaveLength(0);
    expect(trxMock.queries).toHaveLength(3);
    expect(p.tags?.[0]?.owner?.login).toBe('a');
  });

  it('недопустимый путь падает до выполнения SQL', async () => {
    const root = new InvalidPathPhoto();
    root.uuid = 'p1';

    const mock = createMockExecutor([[]]);
    InvalidPathPhoto.setExecutor(mock.executor);

    await expect(
      getOrCreateRepository(InvalidPathPhoto).relations.loadEagerRelations([
        root,
      ]),
    ).rejects.toThrow(/Unknown relation in eager path "nope.owner"/);

    expect(mock.queries).toHaveLength(0);
  });
});
