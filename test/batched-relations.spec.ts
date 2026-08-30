import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToMany,
  ManyToOne,
  OneToOne,
  ManyToMany,
  JoinTable,
  YdbRepository,
  getOrCreateRepository,
  MAX_IN_CLAUSE_VALUES,
} from '../src/index.js';
import {
  createTransactionContext,
  runWithTransactionContext,
  configureTransactionContext,
} from '../src/transaction/transaction-context.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { createScriptedExecutor } from './helpers/ydb-mock.js';

/**
 * Регрессионные тесты #86: батчинг явной загрузки связей (loadRelations),
 * чанкинг и guard-ы fetchByColumnIn. Раньше каждый тип связи ходил запросом
 * на КАЖДЫЙ инстанс (100 записей = 100–200 запросов), IN (...) не чанковался
 * и допускал пустой список/дубликаты значений.
 */

// ---- Фикстуры: одна модель на все виды связей ----

@YdbEntity('batch86_users')
class BatchUserEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @OneToMany(() => BatchPhotoEntity, 'user_uuid')
  photos?: any[];
}

@YdbEntity('batch86_photos')
class BatchPhotoEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Utf8')
  user_uuid: string;

  @YdbColumn('Utf8')
  profile_uuid: string;

  @ManyToOne(() => BatchUserEntity, 'user_uuid')
  owner?: any;

  @OneToOne(() => BatchProfileEntity, 'profile_uuid')
  profile?: any;

  @ManyToMany(() => BatchTagEntity, (tag) => tag.photos)
  @JoinTable('batch86_photo_tag', {
    joinColumn: 'photo_uuid',
    inverseJoinColumn: 'tag_uuid',
  })
  tags?: any[];
}

@YdbEntity('batch86_profiles')
class BatchProfileEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  caption: string;
}

@YdbEntity('batch86_tags')
class BatchTagEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  uuid: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => BatchPhotoEntity, (photo) => photo.tags)
  photos?: any[];
}

// Составные PK для дедупликации между чанками fetchByColumnIn (#86).
@YdbEntity('batch86_docs')
class BatchDocEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant: string;

  @YdbPrimaryColumn('Utf8')
  code: string;

  @YdbColumn('Utf8')
  owner: string;
}

@YdbEntity('batch86_assets')
class BatchAssetEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  num: bigint;

  @YdbPrimaryColumn('Bytes')
  blob: Uint8Array;

  @YdbColumn('Utf8')
  owner: string;
}

function makeUsers(count: number): BatchUserEntity[] {
  return Array.from({ length: count }, (_, i) => {
    const user = new BatchUserEntity();
    user.uuid = `u${String(i).padStart(3, '0')}`;
    user.name = `user-${i}`;
    return user;
  });
}

/** Репозиторий пользователя: relations/persistence для батч-вызовов. */
function userRepo(): YdbRepository<BatchUserEntity> {
  return getOrCreateRepository(BatchUserEntity);
}

describe('#86: батчинг loadRelations', () => {
  describe('one-to-many', () => {
    it('100 инстансов → один батч-запрос вместо 100 findAll', async () => {
      const users = makeUsers(100);
      // По два ребёнка на каждого пользователя, вперемешку по порядку.
      const childRows = users
        .flatMap((u) => [
          { uuid: `${u.uuid}-a`, title: `${u.uuid}-A`, user_uuid: u.uuid },
          { uuid: `${u.uuid}-b`, title: `${u.uuid}-B`, user_uuid: u.uuid },
        ])
        .sort((a, b) => a.uuid.localeCompare(b.uuid));

      const mock = createMockExecutor([childRows]);
      BatchUserEntity.setExecutor(mock.executor);
      BatchPhotoEntity.setExecutor(mock.executor);

      await userRepo().relations.loadRelations(users, ['photos']);

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0].sql).toContain('FROM `batch86_photos`');
      expect(mock.queries[0].sql).toContain('WHERE `user_uuid` IN');
      // Все 100 PK в одном запросе.
      expect(Object.keys(mock.queries[0].params)).toHaveLength(100);

      for (const user of users) {
        expect(user.photos?.map((p) => p.uuid).sort()).toEqual([
          `${user.uuid}-a`,
          `${user.uuid}-b`,
        ]);
      }
    });

    it('кардинальность и порядок: пустые группы, дубликаты PK не разделяют массивы', async () => {
      const sharedPkUser = makeUsers(1)[0];
      const users = [
        sharedPkUser,
        // Второй инстанс с тем же PK — как две строки одного владельца.
        Object.assign(new BatchUserEntity(), {
          uuid: sharedPkUser.uuid,
          name: 'duplicate',
        }),
        makeUsers(1)[0], // детей нет
      ];
      users[2].uuid = 'lonely';

      const childRows = [
        { uuid: 'c1', title: 'first', user_uuid: sharedPkUser.uuid },
        { uuid: 'c2', title: 'second', user_uuid: sharedPkUser.uuid },
      ];
      const mock = createMockExecutor([childRows]);
      BatchUserEntity.setExecutor(mock.executor);
      BatchPhotoEntity.setExecutor(mock.executor);

      await userRepo().relations.loadRelations(users, ['photos']);

      expect(mock.queries).toHaveLength(1);
      // Дедупликация PK: u000 (x2 инстанса) + lonely → 2 параметра.
      expect(Object.keys(mock.queries[0].params)).toHaveLength(2);

      const photosOfFirst = users[0].photos!;
      const photosOfSecond = users[1].photos!;
      expect(photosOfFirst.map((p) => p.uuid)).toEqual(['c1', 'c2']);
      expect(photosOfSecond.map((p) => p.uuid)).toEqual(['c1', 'c2']);
      // Массивы НЕ разделяются между инстансами с одинаковым PK.
      expect(photosOfFirst).not.toBe(photosOfSecond);
      // Порядок детей совпадает с порядком строк из БД.
      expect(photosOfFirst.map((p) => p.title)).toEqual(['first', 'second']);
      // Без детей — пустой массив.
      expect(users[2].photos).toEqual([]);
    });

    it('undefined PK у любого инстанса — прежняя ошибка до запросов; null PK — ноль запросов', async () => {
      const withoutPk = new BatchUserEntity();
      withoutPk.name = 'no-pk';
      const users = makeUsers(2);
      users.push(withoutPk);

      const mock = createMockExecutor([[]]);
      BatchUserEntity.setExecutor(mock.executor);
      BatchPhotoEntity.setExecutor(mock.executor);

      await expect(
        userRepo().relations.loadRelations(users, ['photos']),
      ).rejects.toThrow(
        'Cannot load one-to-many relation "photos": primary key "uuid" is undefined on BatchUserEntity',
      );
      expect(mock.queries).toHaveLength(0);

      // Все PK null → собранный список пуст → ноль SQL.
      const nullUsers = makeUsers(2);
      nullUsers.forEach((u) => (u.uuid = null as any));
      await userRepo().relations.loadRelations(nullUsers, ['photos']);
      expect(mock.queries).toHaveLength(0);
      expect(nullUsers.every((u) => Array.isArray(u.photos))).toBe(true);
    });
  });

  describe('many-to-many', () => {
    it('10 инстансов → ровно 2 запроса (join + теги), а не 2 на каждый', async () => {
      const photos = Array.from({ length: 10 }, (_, i) => {
        const photo = new BatchPhotoEntity();
        photo.uuid = `p${i}`;
        photo.title = `t${i}`;
        photo.user_uuid = 'u000';
        photo.profile_uuid = '';
        return photo;
      });

      // Каждый фото привязан к своим двум тегам.
      const linkRows = photos.flatMap((p) =>
        [`t-${p.uuid}-1`, `t-${p.uuid}-2`].map((tag) => ({
          photo_uuid: p.uuid,
          tag_uuid: tag,
        })),
      );
      const tagRows = linkRows.map((l) => ({
        uuid: l.tag_uuid,
        label: l.tag_uuid,
      }));

      // Single-pass: 1 join-table result set + 1 tag result set
      const mock = createMockExecutor([[linkRows], [tagRows]], {
        sequential: true,
      });
      BatchPhotoEntity.setExecutor(mock.executor);
      BatchTagEntity.setExecutor(mock.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['tags'],
      );

      expect(mock.queries).toHaveLength(2);
      expect(mock.queries[0].sql).toContain('FROM `batch86_photo_tag`');
      expect(mock.queries[0].sql).toContain('WHERE `photo_uuid` IN');
      expect(Object.keys(mock.queries[0].params)).toHaveLength(10);
      expect(mock.queries[1].sql).toContain('FROM `batch86_tags`');

      for (const photo of photos) {
        expect(photo.tags?.map((t) => t.uuid).sort()).toEqual([
          `t-${photo.uuid}-1`,
          `t-${photo.uuid}-2`,
        ]);
      }
    });

    it('1200 владельцев → join-select чанкуется, инверсные FK дедуплицируются', async () => {
      const photos = Array.from({ length: 1200 }, (_, i) => {
        const photo = new BatchPhotoEntity();
        photo.uuid = `p${String(i).padStart(4, '0')}`;
        photo.title = '';
        photo.user_uuid = '';
        photo.profile_uuid = '';
        return photo;
      });

      // Все ссылки ведут на ОДНИ те же три тега → после дедупликации
      // инверсных FK выборка тегов укладывается в один запрос.
      // Реалистичные данные: каждый join-чанк возвращает ссылки ТОЛЬКО
      // своих владельцев (как YDB по IN (...)), а не весь набор.
      const linkRowsFor = (owners: BatchPhotoEntity[]) =>
        owners.flatMap((p) =>
          ['tag-a', 'tag-b', 'tag-c'].map((tag) => ({
            photo_uuid: p.uuid,
            tag_uuid: tag,
          })),
        );
      const chunk1Links = linkRowsFor(photos.slice(0, 500));
      const chunk2Links = linkRowsFor(photos.slice(500, 1000));
      const chunk3Links = linkRowsFor(photos.slice(1000));

      // Один проход на чанк (#224): join1 → tags (все 3, первый чанк) →
      // join2 → join3. Все ссылки ведут на одни три тега, поэтому выборка
      // тегов происходит в первом чанке, остальные чанки берут общий кеш.
      const mock = createMockExecutor(
        [
          [chunk1Links], // join chunk 1
          [
            [
              { uuid: 'tag-a', label: 'A' },
              { uuid: 'tag-b', label: 'B' },
              { uuid: 'tag-c', label: 'C' },
            ],
          ], // tags
          [chunk2Links], // join chunk 2 (всё в кеше, без выборки)
          [chunk3Links], // join chunk 3 (всё в кеше, без выборки)
        ],
        { sequential: true },
      );
      BatchPhotoEntity.setExecutor(mock.executor);
      BatchTagEntity.setExecutor(mock.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['tags'],
      );

      // 4 запроса: 3 join-чанка (одно чтение каждый) + 1 tags.
      expect(mock.queries).toHaveLength(4);
      // Индексы join-чанков: 0, 2, 3; tags — индекс 1.
      expect(
        [mock.queries[0], mock.queries[2], mock.queries[3]].map(
          (q) => Object.keys(q.params).length,
        ),
      ).toEqual([500, 500, 200]);
      expect(Object.keys(mock.queries[1].params)).toHaveLength(3);

      for (const photo of photos) {
        expect(photo.tags?.map((t) => t.uuid).sort()).toEqual([
          'tag-a',
          'tag-b',
          'tag-c',
        ]);
      }
    });

    it('large many-to-many: per-chunk single-read limits memory (no full links materialization) #209/#224', async () => {
      // Create a large relation: 1500 owners, each linked to 10 tags.
      // Total join rows = 15,000. With single-pass this would materialize
      // all 15,000 link rows in memory. Two-pass avoids this by streaming.
      const ownerCount = 1500;
      const tagsPerOwner = 10;
      const tagCount = 100; // 100 unique tags total

      const photos = Array.from({ length: ownerCount }, (_, i) => {
        const photo = new BatchPhotoEntity();
        photo.uuid = `p${String(i).padStart(5, '0')}`;
        photo.title = '';
        photo.user_uuid = '';
        photo.profile_uuid = '';
        return photo;
      });

      // Each owner linked to 10 tags (cycling through 100 tags).
      // Реалистично: каждый join-чанк возвращает ссылки только своих
      // владельцев (как YDB по IN (...)).
      const linkRowsFor = (owners: BatchPhotoEntity[]) =>
        owners
          .map((p) => ({
            p,
            globalIdx: Number(p.uuid.replace('p', '')),
          }))
          .flatMap(({ p, globalIdx }) =>
            Array.from({ length: tagsPerOwner }, (_, j) => ({
              photo_uuid: p.uuid,
              tag_uuid: `tag-${(globalIdx * tagsPerOwner + j) % tagCount}`,
            })),
          );
      const chunk1Links = linkRowsFor(photos.slice(0, 500));
      const chunk2Links = linkRowsFor(photos.slice(500, 1000));
      const chunk3Links = linkRowsFor(photos.slice(1000));

      const tagRows = Array.from({ length: tagCount }, (_, i) => ({
        uuid: `tag-${i}`,
        label: `Tag ${i}`,
      }));

      // Один проход на чанк (#224): join1 → tags (все 100) → join2 → join3.
      // Первый join-чанк покрывает всё множество тегов, остальные чанки
      // используют общий кеш (одна выборка, без повторной гидратации).
      const mock = createMockExecutor(
        [
          [chunk1Links], // join chunk 1
          [tagRows], // tags
          [chunk2Links], // join chunk 2 (всё в кеше)
          [chunk3Links], // join chunk 3 (всё в кеше)
        ],
        { sequential: true },
      );
      BatchPhotoEntity.setExecutor(mock.executor);
      BatchTagEntity.setExecutor(mock.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['tags'],
      );

      // Verify per-chunk single-read query pattern: 3 join reads + 1 tags = 4 queries.
      expect(mock.queries).toHaveLength(4);
      // Join chunks at indices 0, 2, 3; tags at index 1.
      expect(
        [mock.queries[0], mock.queries[2], mock.queries[3]].map(
          (q) => Object.keys(q.params).length,
        ),
      ).toEqual([500, 500, 500]);
      expect(Object.keys(mock.queries[1].params)).toHaveLength(tagCount);

      // Verify results are correct
      for (const photo of photos) {
        expect(photo.tags).toHaveLength(tagsPerOwner);
      }

      // Spot-check a few owners
      expect(photos[0].tags?.map((t) => t.uuid).sort()).toEqual(
        Array.from(
          { length: tagsPerOwner },
          (_, j) => `tag-${j % tagCount}`,
        ).sort(),
      );
      expect(photos[999].tags?.map((t) => t.uuid).sort()).toEqual(
        Array.from(
          { length: tagsPerOwner },
          (_, j) => `tag-${(999 * tagsPerOwner + j) % tagCount}`,
        ).sort(),
      );
    });

    it('почанковое чтение join-таблицы ровно один раз и каждый inverse FK резолвится (#224)', async () => {
      // 600 владельцев → 2 чанка (500 + 100).
      const ownerCount = 600;
      const photos = Array.from({ length: ownerCount }, (_, i) => {
        const photo = new BatchPhotoEntity();
        photo.uuid = `p${String(i).padStart(4, '0')}`;
        photo.title = '';
        photo.user_uuid = '';
        photo.profile_uuid = '';
        return photo;
      });

      // Чанк 1: первые 500 владельцев → tag-A/B/C.
      // Чанк 2: остальные 100 владельцев → tag-C/D/E. tag-C общий (проверка
      // общего инстанса между чанками), tag-D/E появляются ТОЛЬКО во втором
      // чтении — если бы сущности выбирались до перечитывания (старый
      // двухпроходной алгоритм), эти FK были бы потеряны/не резолвились.
      const chunk1Rows = photos.slice(0, 500).flatMap((p) =>
        ['tag-A', 'tag-B', 'tag-C'].map((tag) => ({
          photo_uuid: p.uuid,
          tag_uuid: tag,
        })),
      );
      const chunk2Rows = photos.slice(500).flatMap((p) =>
        ['tag-C', 'tag-D', 'tag-E'].map((tag) => ({
          photo_uuid: p.uuid,
          tag_uuid: tag,
        })),
      );

      const fromIds = (ids: string[]) =>
        ids.map((uuid) => ({ uuid, label: uuid }));

      // Строгая сценарная очередь: каждый join-чанк читается РОВНО один раз
      // (нет второго прохода → нет гонки pass1/pass2), а выборка тегов
      // резолвит каждый встреченный inverse FK (в т.ч. C/D/E из чанка 2).
      // Порядок исполнения: join1 → tags(A,B,C) → join2 → tags(D,E).
      const db = createScriptedExecutor({ label: 'm2m' });
      db.expect('FROM `batch86_photo_tag`').returnsRows(...chunk1Rows);
      db.expect('FROM `batch86_tags`').returnsRows(
        ...fromIds(['tag-A', 'tag-B', 'tag-C']),
      );
      db.expect('FROM `batch86_photo_tag`').returnsRows(...chunk2Rows);
      db.expect('FROM `batch86_tags`').returnsRows(
        ...fromIds(['tag-D', 'tag-E']),
      );
      BatchPhotoEntity.setExecutor(db.executor);
      BatchTagEntity.setExecutor(db.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['tags'],
      );
      db.assertComplete();

      // Результат эквивалентен согласованному одиночному чтению: ни один
      // встреченный inverse FK (включая tag-D/E из второго чанка) не потерян.
      expect(photos[0].tags?.map((t) => t.uuid)).toEqual([
        'tag-A',
        'tag-B',
        'tag-C',
      ]);
      expect(photos[599].tags?.map((t) => t.uuid)).toEqual([
        'tag-C',
        'tag-D',
        'tag-E',
      ]);

      // Общий инверсный FK (tag-C) разделяется между владельцами из РАЗНЫХ
      // чанков одним инстансом (общий кеш по PK, без повторной гидратации).
      const chunk1TagC = photos[0].tags!.find((t) => t.uuid === 'tag-C');
      const chunk2TagC = photos[500].tags!.find((t) => t.uuid === 'tag-C');
      expect(chunk1TagC).toBeDefined();
      expect(chunk2TagC).toBe(chunk1TagC);
    });
  });

  describe('many-to-one и one-to-one', () => {
    function makePhotos(count: number): BatchPhotoEntity[] {
      return Array.from({ length: count }, (_, i) => {
        const photo = new BatchPhotoEntity();
        photo.uuid = `ph${i}`;
        photo.title = '';
        photo.profile_uuid = '';
        return photo;
      });
    }

    it('many-to-one: один IN-запрос; отсутствующий FK → null; порядок сохранён', async () => {
      const photos = makePhotos(4);
      photos[0].user_uuid = 'u001';
      photos[1].user_uuid = 'missing'; // родителя нет в результате
      photos[2].user_uuid = 'u001'; // дубликат FK
      photos[3].user_uuid = 'u002';

      const userRows = [
        { uuid: 'u001', name: 'Ivan' },
        { uuid: 'u002', name: 'Maria' },
      ];
      const mock = createMockExecutor([userRows]);
      BatchPhotoEntity.setExecutor(mock.executor);
      BatchUserEntity.setExecutor(mock.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['owner'],
      );

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0].sql).toContain('FROM `batch86_users`');
      // Дедупликация FK: u001 дважды + missing + u002 → 3 параметра.
      expect(Object.keys(mock.queries[0].params)).toHaveLength(3);

      expect(photos[0].owner?.name).toBe('Ivan');
      expect(photos[1].owner).toBeNull();
      // Инстансы с одинаковым FK получают одну связанную сущность.
      expect(photos[2].owner).toBe(photos[0].owner);
      expect(photos[3].owner?.name).toBe('Maria');
    });

    it('one-to-one: один IN-запрос по PK целевой сущности', async () => {
      const photos = makePhotos(3);
      photos[0].profile_uuid = 'pr1';
      photos[1].profile_uuid = 'pr2';
      photos[2].profile_uuid = 'pr-missing';

      const mock = createMockExecutor([
        [
          { uuid: 'pr1', caption: 'first' },
          { uuid: 'pr2', caption: 'second' },
        ],
      ]);
      BatchPhotoEntity.setExecutor(mock.executor);
      BatchProfileEntity.setExecutor(mock.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['profile'],
      );

      expect(mock.queries).toHaveLength(1);
      expect(mock.queries[0].sql).toContain('FROM `batch86_profiles`');
      expect(mock.queries[0].sql).toContain('WHERE `uuid` IN');
      expect(Object.keys(mock.queries[0].params)).toHaveLength(3);

      expect(photos[0].profile?.caption).toBe('first');
      expect(photos[1].profile?.caption).toBe('second');
      expect(photos[2].profile).toBeNull();
    });
  });

  describe('транзакции', () => {
    it('явный { trx }: все батч-запросы m2m уходят в транзакцию, а не в executor БД', async () => {
      const photos = makePhotosSimple(2);
      const linkRows = photos.map((p) => ({
        photo_uuid: p.uuid,
        tag_uuid: 'tag-x',
      }));

      const dbMock = createMockExecutor([[]]);
      // Single-pass: join -> tags
      const trxMock = createMockExecutor(
        [[linkRows], [[{ uuid: 'tag-x', label: 'X' }]]],
        { sequential: true },
      );
      BatchPhotoEntity.setExecutor(dbMock.executor);
      BatchTagEntity.setExecutor(dbMock.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['tags'],
        { trx: trxMock.executor },
      );

      expect(dbMock.queries).toHaveLength(0);
      expect(trxMock.queries).toHaveLength(2);
      expect(trxMock.queries[0].sql).toContain('FROM `batch86_photo_tag`');
      expect(trxMock.queries[1].sql).toContain('FROM `batch86_tags`');
      expect(photos[0].tags?.[0]?.uuid).toBe('tag-x');
    });

    it('явный { trx } многочанкового m2m: и join-чтения, и выборки тегов — в транзакции (#224)', async () => {
      // 600 владельцев → 2 join-чанка; разные теги в каждом чанке → 2 выборки
      // тегов. Все 4 запроса обязаны уйти в { trx }, не в executor БД.
      const ownerCount = 600;
      const photos = Array.from({ length: ownerCount }, (_, i) => {
        const photo = new BatchPhotoEntity();
        photo.uuid = `p${String(i).padStart(4, '0')}`;
        photo.title = '';
        photo.user_uuid = '';
        photo.profile_uuid = '';
        return photo;
      });

      const chunk1Rows = photos.slice(0, 500).map((p) => ({
        photo_uuid: p.uuid,
        tag_uuid: 'tag-A',
      }));
      const chunk2Rows = photos.slice(500).map((p) => ({
        photo_uuid: p.uuid,
        tag_uuid: 'tag-B',
      }));

      const dbMock = createMockExecutor([[]]);
      // Порядок исполнения: join1 → tags(A) → join2 → tags(B) — все в { trx }.
      const trxMock = createMockExecutor(
        [
          [chunk1Rows], // join chunk 1
          [[{ uuid: 'tag-A', label: 'A' }]], // tags chunk1
          [chunk2Rows], // join chunk 2
          [[{ uuid: 'tag-B', label: 'B' }]], // tags chunk2
        ],
        { sequential: true },
      );
      BatchPhotoEntity.setExecutor(dbMock.executor);
      BatchTagEntity.setExecutor(dbMock.executor);

      await getOrCreateRepository(BatchPhotoEntity).relations.loadRelations(
        photos,
        ['tags'],
        { trx: trxMock.executor },
      );

      expect(dbMock.queries).toHaveLength(0);
      expect(trxMock.queries).toHaveLength(4);
      expect(trxMock.queries[0].sql).toContain('FROM `batch86_photo_tag`');
      expect(trxMock.queries[1].sql).toContain('FROM `batch86_tags`');
      expect(trxMock.queries[2].sql).toContain('FROM `batch86_photo_tag`');
      expect(trxMock.queries[3].sql).toContain('FROM `batch86_tags`');
      expect(photos[0].tags?.[0]?.uuid).toBe('tag-A');
      expect(photos[599].tags?.[0]?.uuid).toBe('tag-B');
    });

    it('ambient-контекст: батч-запрос one-to-many идёт в активную транзакцию без { trx }', async () => {
      const users = makeUsers(3);
      const childRows = [
        { uuid: 'c1', title: '', user_uuid: 'u000' },
        { uuid: 'c2', title: '', user_uuid: 'u002' },
      ];

      const dbMock = createMockExecutor([[]]);
      const trxMock = createMockExecutor([childRows]);
      BatchUserEntity.setExecutor(dbMock.executor);
      BatchPhotoEntity.setExecutor(dbMock.executor);

      configureTransactionContext({ ambient: true });
      try {
        await runWithTransactionContext(
          createTransactionContext({
            transactionId: Symbol('batched-relations'),
            trx: trxMock.executor,
            db: dbMock.executor,
            ambient: true,
          }),
          async () => {
            await userRepo().relations.loadRelations(users, ['photos']);
          },
        );
      } finally {
        configureTransactionContext();
      }

      expect(dbMock.queries).toHaveLength(0);
      expect(trxMock.queries).toHaveLength(1);
      expect(users[0].photos?.map((p) => p.uuid)).toEqual(['c1']);
      expect(users[1].photos).toEqual([]);
      expect(users[2].photos?.map((p) => p.uuid)).toEqual(['c2']);
    });
  });
});

describe('#86: guard-ы fetchByColumnIn', () => {
  function photoRepo(): YdbRepository<BatchPhotoEntity> {
    return getOrCreateRepository(BatchPhotoEntity);
  }

  it('пустой массив значений — ноль SQL', async () => {
    const mock = createMockExecutor([[]]);
    BatchPhotoEntity.setExecutor(mock.executor);

    const result = await photoRepo().persistence.fetchByColumnIn(
      'user_uuid',
      [],
    );

    expect(result).toEqual([]);
    expect(mock.queries).toHaveLength(0);
  });

  it('дубликаты FK дедуплицируются до построения IN (...)', async () => {
    const mock = createMockExecutor([
      [[{ uuid: 'c1', title: '', user_uuid: 'u1' }]],
    ]);
    BatchPhotoEntity.setExecutor(mock.executor);

    const result = await photoRepo().persistence.fetchByColumnIn('user_uuid', [
      'u1',
      'u1',
      'u2',
      'u1',
      'u2',
    ]);

    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain('IN ($p0, $p1)');
    expect(mock.queries[0].sql).not.toContain('$p2');
    expect(Object.keys(mock.queries[0].params)).toHaveLength(2);
    expect(result).toHaveLength(1);
  });

  it(`больше ${MAX_IN_CLAUSE_VALUES} значений → несколько чанков`, async () => {
    const mock = createMockExecutor([[]]);
    BatchPhotoEntity.setExecutor(mock.executor);

    const values = Array.from({ length: MAX_IN_CLAUSE_VALUES + 700 }, (_, i) =>
      String(i),
    );

    await photoRepo().persistence.fetchByColumnIn('user_uuid', values);

    expect(mock.queries).toHaveLength(3); // 500 + 500 + 200
    expect(mock.queries.map((q) => Object.keys(q.params).length)).toEqual([
      MAX_IN_CLAUSE_VALUES,
      MAX_IN_CLAUSE_VALUES,
      200,
    ]);
    for (const q of mock.queries) {
      expect(q.sql).toContain('WHERE `user_uuid` IN');
    }
  });

  it('слияние чанков полное и без дубликатов', async () => {
    const mock = createMockExecutor(
      [
        [[{ uuid: 'x1', title: '', user_uuid: 'u1' }]],
        [
          [
            { uuid: 'x2', title: '', user_uuid: 'u2' },
            { uuid: 'x1', title: '', user_uuid: 'u1' }, // дубль между чанками
          ],
        ],
        [[{ uuid: 'x3', title: '', user_uuid: 'u3' }]],
      ],
      { sequential: true },
    );
    BatchPhotoEntity.setExecutor(mock.executor);

    const values = [
      ...Array.from({ length: MAX_IN_CLAUSE_VALUES }, (_, i) => `a${i}`),
      ...Array.from({ length: MAX_IN_CLAUSE_VALUES }, (_, i) => `b${i}`),
      ...Array.from({ length: MAX_IN_CLAUSE_VALUES }, (_, i) => `c${i}`),
      ...Array.from({ length: MAX_IN_CLAUSE_VALUES }, (_, i) => `d${i}`),
    ];

    const result = await photoRepo().persistence.fetchByColumnIn(
      'user_uuid',
      values,
    );

    expect(mock.queries).toHaveLength(4);
    const ids = result.map((e) => e.uuid);
    expect(ids).toEqual(['x1', 'x2', 'x3']); // полный результат, x1 один раз
  });
});

describe('#86: дедупликация составных PK между чанками', () => {
  it('составные PK с символом-разделителем "|" не склеиваются в один ключ', async () => {
    const mock = createMockExecutor(
      [
        [[{ tenant: 'a|b', code: 'c', owner: 'o0' }]],
        [
          [
            { tenant: 'a', code: 'b|c', owner: 'o1' },
            { tenant: 'a|b', code: 'c', owner: 'o0' }, // дубль из чанка 1
          ],
        ],
      ],
      { sequential: true },
    );
    BatchDocEntity.setExecutor(mock.executor);

    // > MAX_IN_CLAUSE_VALUES значений → гарантированные два чанка.
    const values = Array.from(
      { length: MAX_IN_CLAUSE_VALUES + 50 },
      (_, i) => `o${i}`,
    );

    const result = await getOrCreateRepository(
      BatchDocEntity,
    ).persistence.fetchByColumnIn('owner', values);

    expect(mock.queries).toHaveLength(2);

    // Регрессия: ключи ('a|b','c') и ('a','b|c') при конкатенации через '|'
    // совпадали ('a|b|c'), и вторая сущность терялась.
    expect(result.map((d) => [d.tenant, d.code])).toEqual([
      ['a|b', 'c'],
      ['a', 'b|c'],
    ]);
  });

  it('bigint и Bytes компоненты PK кодируются без коллизий; идентичные дедуплицируются', async () => {
    const bytesOf = (...bytes: number[]) => new Uint8Array(bytes);

    const mock = createMockExecutor(
      [
        [[{ num: 1n, blob: bytesOf(1, 2), owner: 'o0' }]],
        [
          [
            { num: 1n, blob: bytesOf(1, 2, 3), owner: 'o1' },
            { num: 2n, blob: bytesOf(1, 2), owner: 'o2' },
            { num: 1n, blob: bytesOf(1, 2), owner: 'o3' }, // полный дубликат
          ],
        ],
      ],
      { sequential: true },
    );
    BatchAssetEntity.setExecutor(mock.executor);

    const values = Array.from(
      { length: MAX_IN_CLAUSE_VALUES + 20 },
      (_, i) => `o${i}`,
    );

    const result = await getOrCreateRepository(
      BatchAssetEntity,
    ).persistence.fetchByColumnIn('owner', values);

    expect(mock.queries).toHaveLength(2);

    // Типы и границы компонентов сохраняются точно: bigint не путается со
    // строкой '1', а Bytes кодируются побайтово — без опоры на
    // String()-представления (у TypedArray это join(','), у bigint — '1'),
    // которые теряют тип значения.
    expect(result.map((a) => [a.num.toString(), [...a.blob]])).toEqual([
      ['1', [1, 2]],
      ['1', [1, 2, 3]],
      ['2', [1, 2]],
    ]);
  });
});

function makePhotosSimple(count: number): BatchPhotoEntity[] {
  return Array.from({ length: count }, (_, i) => {
    const photo = new BatchPhotoEntity();
    photo.uuid = `p${i}`;
    photo.title = '';
    photo.user_uuid = '';
    photo.profile_uuid = '';
    return photo;
  });
}
