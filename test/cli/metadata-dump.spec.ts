import 'reflect-metadata';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  YdbIndex,
  YdbTtl,
  YdbEncrypted,
  YdbSecurityAAD,
  YdbEnum,
  YdbJson,
  EagerLoad,
  OneToMany,
  ManyToOne,
  ManyToMany,
  JoinTable,
  buildMetadataDump,
  METADATA_DUMP_FORMAT,
  METADATA_DUMP_VERSION,
} from '../../src/index.js';
import type {
  DumpedEntity,
  MetadataDump,
  YdbExecutor,
} from '../../src/index.js';
import { UserEntity } from '../fixtures/user/user.entity.js';
import { UserRoleEntity } from '../fixtures/user_role/user_role.entity.js';
import { MembershipEntity } from '../fixtures/membership/membership.entity.js';
import { DeviceEntity } from '../fixtures/one_to_one/device.entity.js';
import { DeviceLicenseEntity } from '../fixtures/one_to_one/device-license.entity.js';
import { PhotoWithTagsEntity } from '../fixtures/photo_with_tags/photo_with_tags.entity.js';
import { TagEntity } from '../fixtures/tag/tag.entity.js';
import { IndexedArticleEntity } from '../fixtures/indexed_article/indexed-article.entity.js';
import { TtlDocumentEntity } from '../fixtures/ttl_document/ttl-document.entity.js';
import { OrderStatusEntity } from '../fixtures/enum_order/order-status.entity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Регресс-тесты metadata:dump (#37): read-only экспорт метаданных сущностей
// в детерминированный версионированный JSON без обращения к БД.
// ─────────────────────────────────────────────────────────────────────────────

/** Минимальная сущность: одна PK-колонка и одна обычная. */
@YdbEntity('md_minimal')
class MinimalEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

/** Составной PK: порядок объявления значим (#89). */
@YdbEntity('md_composite')
class CompositePkEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id!: string;

  @YdbPrimaryColumn('Uuid')
  user_uuid!: string;

  @YdbColumn('Int32')
  score!: number;
}

/** Уникальный и составной индексы, JSON-колонка. */
@YdbEntity('md_indexes')
@YdbIndex({ columns: ['slug'], unique: true })
@YdbIndex({ columns: ['author', 'created_at'] })
class UniqueIndexEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  slug!: string;

  @YdbColumn('Utf8')
  author!: string;

  @YdbColumn('Datetime')
  created_at!: Date;

  @YdbJson()
  payload!: Record<string, unknown>;
}

/** Числовая TTL-колонка с unit. */
@YdbEntity('md_ttl_numeric')
@YdbTtl({ interval: 'PT2H', column: 'expires_at', unit: 'seconds' })
class NumericTtlEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Uint32' as any)
  declare expires_at: number;
}

/** Enum со storage Utf8 по умолчанию. */
enum MdColor {
  RED = 'red',
  GREEN = 'green',
}

@YdbEntity('md_enum_utf8')
class Utf8EnumEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  @YdbEnum({ values: Object.values(MdColor) })
  color!: MdColor;
}

/**
 * Шифрование: blind index on/off, lazy, aadOverride, AAD на PK.
 * Имена полей подобраны так, чтобы случайная утечка «секретной» лексики
 * в дампе была видна в тестах.
 */
@YdbEntity('md_encrypted')
@YdbIndex({ columns: ['card_number_bi'] })
class EncryptedEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  @YdbSecurityAAD()
  uuid!: string;

  @YdbEncrypted({ blindIndex: true })
  card_number!: string;

  @YdbEncrypted({ blindIndex: false, lazy: true })
  @YdbColumn('Utf8')
  note!: string;

  @YdbEncrypted({
    blindIndex: true,
    lazy: true,
    aadOverride: 'billing:card_v2',
  })
  pan!: string;
}

// ── Связи всех поддерживаемых типов ─────────────────────────────────────────

@YdbEntity('md_rel_posts')
class RelPostEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @OneToMany(() => RelCommentEntity, (comment) => comment.post_uuid)
  comments?: RelCommentEntity[];

  @ManyToMany(() => RelLabelEntity, (label) => label.posts)
  @JoinTable('md_post_label')
  labels?: RelLabelEntity[];
}

@YdbEntity('md_rel_comments')
class RelCommentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Uuid')
  post_uuid!: string;

  // Селектор читает имя FK-колонки ВЛАДЕЛЬЦА связи (post_uuid на комментарии)
  @ManyToOne(() => RelPostEntity, (comment) => comment.post_uuid)
  post?: RelPostEntity;
}

@YdbEntity('md_rel_labels')
class RelLabelEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @ManyToMany(() => RelPostEntity, (post) => post.labels)
  posts?: RelPostEntity[];
}

/** m2m с явными именами join-колонок (#90). */
@YdbEntity('md_rel_actors')
class RelActorEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  code!: string;

  @ManyToMany(() => RelMovieEntity, (movie) => movie.actors)
  @JoinTable('md_actor_movie', {
    joinColumn: 'actor_code',
    inverseJoinColumn: 'movie_uuid',
  })
  movies?: RelMovieEntity[];
}

@YdbEntity('md_rel_movies')
class RelMovieEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @ManyToMany(() => RelActorEntity, (actor) => actor.movies)
  actors?: RelActorEntity[];
}

// ── Наследование #92/#107 ───────────────────────────────────────────────────

@YdbEntity('md_inh_parent')
@YdbIndex({ columns: ['email'] })
@YdbTtl({ interval: 'PT2H', column: 'expires_at' })
@EagerLoad(['inheritedRel'])
class InheritParentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  email!: string;

  @YdbEncrypted({ blindIndex: true })
  secret!: string;

  @YdbColumn('Datetime')
  expires_at!: Date;

  @OneToMany(() => UserRoleEntity, (userRole) => userRole.user_uuid)
  inheritedRel?: UserRoleEntity[];
}

@YdbEntity('md_inh_child')
@EagerLoad(['ownRel'])
class InheritChildEntity extends InheritParentEntity {
  @YdbColumn('Utf8')
  nickname!: string;

  @ManyToOne(() => UserEntity, (membership) => membership.user_uuid)
  ownRel?: UserEntity;
}

/** Подкласс без собственного @YdbEntity — не сущность (#92). */
class UndecoratedSubEntity extends MinimalEntity {}

// ── Невалидные метаданные ───────────────────────────────────────────────────

class NotDecoratedEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('md_conflict_table')
class ConflictAEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('md_conflict_table')
class ConflictBEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('md_no_pk')
class NoPkEntity extends YdbBaseEntity {
  @YdbColumn('Uuid')
  uuid!: string;
}

@YdbEntity('md_bad_ttl')
@YdbTtl({ interval: 'PT2H', column: 'count' })
class BadTtlEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Int32')
  count!: number;
}

@YdbEntity('md_bad_selector_owner')
class BadSelectorOwnerEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @ManyToOne(() => MinimalEntity, () => 'uuid' as never)
  broken?: MinimalEntity;
}

/** Два расходящихся объявления одной join-таблицы (#139). */
@YdbEntity('md_jt_left')
class JoinConflictLeftEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @ManyToMany(() => JoinRightAEntity)
  @JoinTable('md_join_conflict')
  rightsA?: JoinRightAEntity[];
}

@YdbEntity('md_right_a')
class JoinRightAEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('md_jt_other')
class JoinConflictOtherEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @ManyToMany(() => JoinRightBEntity)
  @JoinTable('md_join_conflict', { joinColumn: 'other_uuid' })
  rightsB?: JoinRightBEntity[];
}

@YdbEntity('md_right_b')
class JoinRightBEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

const findEntity = (dump: MetadataDump, table: string): DumpedEntity => {
  const entity = dump.entities.find((e) => e.table === table);
  if (!entity) throw new Error(`entity for table "${table}" not found in dump`);
  return entity;
};

describe('metadata:dump (#37)', () => {
  it('минимальная сущность: таблица, колонки, типы, PK', () => {
    const dump = buildMetadataDump([MinimalEntity]);

    expect(dump.format).toBe(METADATA_DUMP_FORMAT);
    expect(dump.version).toBe(METADATA_DUMP_VERSION);
    expect(dump.joinTables).toEqual([]);
    expect(findEntity(dump, 'md_minimal')).toEqual({
      className: 'MinimalEntity',
      table: 'md_minimal',
      primaryKey: ['uuid'],
      columns: [
        { name: 'name', type: 'Utf8', primary: false },
        { name: 'uuid', type: 'Uuid', primary: true },
      ],
      indexes: [],
      ttl: null,
      enums: [],
      encryptedFields: [],
      aadFields: [],
      jsonColumns: [],
      eagerLoad: [],
      relations: [],
    });
  });

  it('составной PK сохраняет порядок объявления (#89)', () => {
    const dumped = findEntity(
      buildMetadataDump([CompositePkEntity]),
      'md_composite',
    );

    expect(dumped.primaryKey).toEqual(['tenant_id', 'user_uuid']);
    expect(dumped.columns.filter((c) => c.primary).map((c) => c.name)).toEqual([
      'tenant_id',
      'user_uuid',
    ]);
  });

  it('индексы: автоимя, уникальность, составные; jsonColumns отдельно', () => {
    const dumped = findEntity(
      buildMetadataDump([UniqueIndexEntity]),
      'md_indexes',
    );

    expect(dumped.indexes).toEqual([
      {
        name: 'md_indexes__author_created_at',
        columns: ['author', 'created_at'],
        unique: false,
      },
      { name: 'md_indexes__slug', columns: ['slug'], unique: true },
    ]);
    // Порядок колонок индекса сохранён
    expect(dumped.indexes[0].columns).toEqual(['author', 'created_at']);
    expect(dumped.jsonColumns).toEqual(['payload']);
  });

  describe('TTL', () => {
    it('date-like TTL без unit', () => {
      const dumped = findEntity(
        buildMetadataDump([TtlDocumentEntity]),
        'fixture_ttl_docs',
      );
      expect(dumped.ttl).toEqual({ column: 'expires_at', interval: 'P7D' });
    });

    it('числовая TTL-колонка с unit', () => {
      const dumped = findEntity(
        buildMetadataDump([NumericTtlEntity]),
        'md_ttl_numeric',
      );
      expect(dumped.ttl).toEqual({
        column: 'expires_at',
        interval: 'PT2H',
        unit: 'seconds',
      });
    });
  });

  it('enum-метаданные: values (порядок сохранён) и storage', () => {
    const intDump = findEntity(
      buildMetadataDump([OrderStatusEntity]),
      'fixture_orders',
    );
    expect(intDump.enums).toEqual([
      {
        property: 'status',
        values: ['new', 'paid', 'shipped', 'cancelled'],
        storage: 'Int32',
      },
    ]);

    const utf8Dump = findEntity(
      buildMetadataDump([Utf8EnumEntity]),
      'md_enum_utf8',
    );
    expect(utf8Dump.enums).toEqual([
      { property: 'color', values: ['red', 'green'], storage: 'Utf8' },
    ]);
  });

  describe('шифрование/blind index — без секретов и провайдеров', () => {
    let dumped: DumpedEntity;

    beforeEach(() => {
      dumped = findEntity(buildMetadataDump([EncryptedEntity]), 'md_encrypted');
    });

    it('декларативные флаги полей', () => {
      expect(dumped.encryptedFields).toEqual([
        {
          property: 'card_number',
          blindIndex: true,
          blindIndexColumn: 'card_number_bi',
          lazy: false,
          aadOverride: null,
        },
        {
          property: 'note',
          blindIndex: false,
          blindIndexColumn: null,
          lazy: true,
          aadOverride: null,
        },
        {
          property: 'pan',
          blindIndex: true,
          blindIndexColumn: 'pan_bi',
          lazy: true,
          aadOverride: 'billing:card_v2',
        },
      ]);
      expect(dumped.aadFields).toEqual(['uuid']);
      // Synthetic-колонки blind index попадают в физические колонки
      expect(dumped.columns.find((c) => c.name === 'card_number_bi')).toEqual({
        name: 'card_number_bi',
        type: 'Utf8',
        primary: false,
      });
      expect(dumped.columns.find((c) => c.name === 'card_number')?.type).toBe(
        'Bytes',
      );
    });

    it('в JSON нет функций, провайдеров, ключей и runtime-материала', () => {
      const json = JSON.stringify(dumped);
      expect(json).not.toMatch(/=>|function/);
      expect(json.toLowerCase()).not.toMatch(
        /provider|secret|cipher|credential|privatekey|salt|hmac/,
      );
      // Каждое поле шифрования описано ровно пятью декларативными ключами
      for (const field of dumped.encryptedFields) {
        expect(Object.keys(field).sort()).toEqual([
          'aadOverride',
          'blindIndex',
          'blindIndexColumn',
          'lazy',
          'property',
        ]);
      }
    });
  });

  describe('связи всех типов', () => {
    let dump: MetadataDump;

    beforeEach(() => {
      dump = buildMetadataDump([
        RelPostEntity,
        RelCommentEntity,
        RelLabelEntity,
      ]);
    });

    it('one-to-many c обратным many-to-one по той же join-колонке', () => {
      const post = findEntity(dump, 'md_rel_posts');
      expect(post.relations).toEqual([
        {
          property: 'comments',
          type: 'one-to-many',
          target: { entity: 'RelCommentEntity', table: 'md_rel_comments' },
          joinColumn: 'post_uuid',
          inverseProperty: 'post',
          joinTable: null,
        },
        {
          property: 'labels',
          type: 'many-to-many',
          target: { entity: 'RelLabelEntity', table: 'md_rel_labels' },
          inverseProperty: 'posts',
          joinTable: { table: 'md_post_label', side: 'owner' },
        },
      ]);
    });

    it('many-to-one c обратным one-to-many', () => {
      const comment = findEntity(dump, 'md_rel_comments');
      expect(comment.relations).toEqual([
        {
          property: 'post',
          type: 'many-to-one',
          target: { entity: 'RelPostEntity', table: 'md_rel_posts' },
          joinColumn: 'post_uuid',
          inverseProperty: 'comments',
          joinTable: null,
        },
      ]);
    });

    it('many-to-many: обратная сторона ссылается на join-таблицу владельца', () => {
      const label = findEntity(dump, 'md_rel_labels');
      expect(label.relations).toEqual([
        {
          property: 'posts',
          type: 'many-to-many',
          target: { entity: 'RelPostEntity', table: 'md_rel_posts' },
          inverseProperty: 'labels',
          joinTable: {
            table: 'md_post_label',
            side: 'inverse',
            owner: { entity: 'RelPostEntity', property: 'labels' },
          },
        },
      ]);
      // Детали join-таблицы — в верхнеуровневом списке
      expect(dump.joinTables).toEqual([
        {
          table: 'md_post_label',
          joinColumn: 'md_rel_posts_uuid',
          joinColumnType: 'Uuid',
          inverseJoinColumn: 'md_rel_labels_uuid',
          inverseJoinColumnType: 'Uuid',
          owner: {
            entity: 'RelPostEntity',
            table: 'md_rel_posts',
            property: 'labels',
          },
          inverse: { entity: 'RelLabelEntity', table: 'md_rel_labels' },
        },
      ]);
    });

    it('m2m из фикстур: явные имена join-колонок выводятся как объявлено (#90)', () => {
      const dump = buildMetadataDump([PhotoWithTagsEntity, TagEntity]);
      expect(findEntity(dump, 'photos_with_tags').relations).toEqual([
        {
          property: 'tags',
          type: 'many-to-many',
          target: { entity: 'TagEntity', table: 'tags' },
          inverseProperty: 'photos',
          joinTable: { table: 'photo_tag', side: 'owner' },
        },
      ]);
      expect(findEntity(dump, 'tags').relations[0].joinTable).toEqual({
        table: 'photo_tag',
        side: 'inverse',
        owner: { entity: 'PhotoWithTagsEntity', property: 'tags' },
      });
      expect(dump.joinTables).toEqual([
        {
          table: 'photo_tag',
          joinColumn: 'photos_with_tags_uuid',
          joinColumnType: 'Uuid',
          inverseJoinColumn: 'tags_uuid',
          inverseJoinColumnType: 'Uuid',
          owner: {
            entity: 'PhotoWithTagsEntity',
            table: 'photos_with_tags',
            property: 'tags',
          },
          inverse: { entity: 'TagEntity', table: 'tags' },
        },
      ]);
    });

    it('m2m с явными именами и типами join-колонок из фактических PK', () => {
      const dump = buildMetadataDump([RelActorEntity, RelMovieEntity]);
      expect(dump.joinTables).toEqual([
        {
          table: 'md_actor_movie',
          joinColumn: 'actor_code',
          joinColumnType: 'Utf8',
          inverseJoinColumn: 'movie_uuid',
          inverseJoinColumnType: 'Uuid',
          owner: {
            entity: 'RelActorEntity',
            table: 'md_rel_actors',
            property: 'movies',
          },
          inverse: { entity: 'RelMovieEntity', table: 'md_rel_movies' },
        },
      ]);
    });

    it('one-to-one и one-to-many/many-to-one из фикстур (составной PK)', () => {
      const dump = buildMetadataDump([
        DeviceEntity,
        DeviceLicenseEntity,
        MembershipEntity,
        UserEntity,
        UserRoleEntity,
      ]);

      const device = findEntity(dump, 'fixture_devices');
      expect(device.relations).toEqual([
        {
          property: 'license',
          type: 'one-to-one',
          target: {
            entity: 'DeviceLicenseEntity',
            table: 'fixture_device_licenses',
          },
          joinColumn: 'license_uuid',
          inverseProperty: null,
          joinTable: null,
        },
      ]);

      // many-to-one, где FK — компонент составного PK
      const membership = findEntity(dump, 'memberships');
      expect(membership.relations).toEqual([
        {
          property: 'user',
          type: 'many-to-one',
          target: { entity: 'UserEntity', table: 'users' },
          joinColumn: 'user_uuid',
          inverseProperty: null,
          joinTable: null,
        },
      ]);

      // one-to-many от users к user_roles (составной PK цели)
      const user = findEntity(dump, 'users');
      expect(user.relations).toEqual([
        {
          property: 'userRoles',
          type: 'one-to-many',
          target: { entity: 'UserRoleEntity', table: 'user_roles' },
          joinColumn: 'user_uuid',
          inverseProperty: null,
          joinTable: null,
        },
      ]);
    });
  });

  describe('наследование #92/#107', () => {
    let dump: MetadataDump;

    beforeEach(() => {
      dump = buildMetadataDump([InheritParentEntity, InheritChildEntity]);
    });

    it('колонки/PK/шифрование наследуются, таблица — собственная', () => {
      const child = findEntity(dump, 'md_inh_child');
      expect(child.className).toBe('InheritChildEntity');
      expect(child.primaryKey).toEqual(['uuid']);
      expect(child.columns.map((c) => c.name)).toEqual([
        'email',
        'expires_at',
        'nickname',
        'secret',
        'secret_bi',
        'uuid',
      ]);
      expect(child.columns.find((c) => c.name === 'secret')?.type).toBe(
        'Bytes',
      );
      expect(child.encryptedFields.map((f) => f.property)).toEqual(['secret']);
    });

    it('@YdbIndex и @YdbTtl не наследуются (#92)', () => {
      const parent = findEntity(dump, 'md_inh_parent');
      const child = findEntity(dump, 'md_inh_child');

      expect(parent.indexes).toHaveLength(1);
      expect(parent.ttl).toEqual({ column: 'expires_at', interval: 'PT2H' });
      expect(child.indexes).toEqual([]);
      expect(child.ttl).toBeNull();
    });

    it('@EagerLoad объединяется: сначала родительские связи (#107)', () => {
      const parent = findEntity(dump, 'md_inh_parent');
      const child = findEntity(dump, 'md_inh_child');

      expect(parent.eagerLoad).toEqual(['inheritedRel']);
      expect(child.eagerLoad).toEqual(['inheritedRel', 'ownRel']);
      // Связи родителя наследуются вместе с eager-именами
      expect(child.relations.map((r) => r.property)).toEqual([
        'inheritedRel',
        'ownRel',
      ]);
    });

    it('метаданные родителя не затронуты (copy-on-write)', () => {
      const again = buildMetadataDump([InheritParentEntity]);
      const parent = findEntity(again, 'md_inh_parent');
      expect(parent.columns.map((c) => c.name)).not.toContain('nickname');
      expect(parent.ttl).toEqual({ column: 'expires_at', interval: 'PT2H' });
    });

    it('явно переданный класс без @YdbEntity роняет дамп с понятной ошибкой (#92)', () => {
      // Подкласс без собственного @YdbEntity — не сущность: как и в
      // migration:generate/schema:verify, явная передача такого класса — ошибка,
      // а не молчаливый пропуск.
      expect(() =>
        buildMetadataDump([MinimalEntity, UndecoratedSubEntity]),
      ).toThrow('Class UndecoratedSubEntity is not decorated with @YdbEntity');
    });

    it('повтор одного класса в списке дедуплицируется', () => {
      const dump = buildMetadataDump([MinimalEntity, MinimalEntity]);
      expect(dump.entities).toHaveLength(1);
    });
  });

  it('несколько сущностей: все в дампе, порядок стабильный (по имени таблицы)', () => {
    const dump1 = buildMetadataDump([
      OrderStatusEntity,
      IndexedArticleEntity,
      MinimalEntity,
    ]);
    expect(dump1.entities.map((e) => e.table)).toEqual([
      'fixture_articles',
      'fixture_orders',
      'md_minimal',
    ]);

    // Порядок входного списка не влияет на вывод
    const dump2 = buildMetadataDump([
      MinimalEntity,
      IndexedArticleEntity,
      OrderStatusEntity,
    ]);
    expect(JSON.stringify(dump2)).toBe(JSON.stringify(dump1));
  });

  it('детерминизм: повторный вызов даёт побайтово одинаковый JSON', () => {
    const entities = [
      UserEntity,
      UserRoleEntity,
      MembershipEntity,
      DeviceEntity,
      DeviceLicenseEntity,
      PhotoWithTagsEntity,
      TagEntity,
      IndexedArticleEntity,
      TtlDocumentEntity,
      OrderStatusEntity,
      MinimalEntity,
      CompositePkEntity,
      UniqueIndexEntity,
      NumericTtlEntity,
      Utf8EnumEntity,
      EncryptedEntity,
      RelPostEntity,
      RelCommentEntity,
      RelLabelEntity,
      RelActorEntity,
      RelMovieEntity,
      InheritParentEntity,
      InheritChildEntity,
    ];

    const first = JSON.stringify(buildMetadataDump(entities));
    const second = JSON.stringify(buildMetadataDump(entities));

    expect(first).toBe(second);
    // Стабильный формат: ключи верхнего уровня всегда в одном порядке
    expect(Object.keys(buildMetadataDump(entities))).toEqual([
      'format',
      'version',
      'entities',
      'joinTables',
    ]);
  });

  describe('невалидные метаданные роняют дамп до вывода', () => {
    it('класс без @YdbEntity', () => {
      expect(() => buildMetadataDump([NotDecoratedEntity])).toThrow(
        'Class NotDecoratedEntity is not decorated with @YdbEntity',
      );
    });

    it('две сущности с одним именем таблицы (#92)', () => {
      expect(() =>
        buildMetadataDump([ConflictAEntity, ConflictBEntity]),
      ).toThrow('Duplicate table name "md_conflict_table"');
    });

    it('сущность без первичного ключа', () => {
      expect(() => buildMetadataDump([NoPkEntity])).toThrow(
        'no primary key is declared',
      );
    });

    it('TTL на несовместимой колонке', () => {
      expect(() => buildMetadataDump([BadTtlEntity])).toThrow(
        '@YdbTtl column "count" has unsupported type Int32',
      );
    });

    it('невалидный селектор join-колонки (#87)', () => {
      expect(() => buildMetadataDump([BadSelectorOwnerEntity])).toThrow(
        'relation "broken" on BadSelectorOwnerEntity',
      );
    });

    it('расходящиеся объявления одной join-таблицы (#139)', () => {
      expect(() =>
        buildMetadataDump([JoinConflictLeftEntity, JoinConflictOtherEntity]),
      ).toThrow('Conflicting definitions for many-to-many join table');
    });

    it('m2m на класс без @YdbEntity', () => {
      @YdbEntity('md_m2m_ghost_owner')
      class GhostOwnerEntity extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;

        @ManyToMany(() => NotDecoratedEntity)
        @JoinTable('md_ghost_join')
        ghosts?: NotDecoratedEntity[];
      }

      expect(() => buildMetadataDump([GhostOwnerEntity])).toThrow(
        'is not decorated with @YdbEntity',
      );
    });
  });

  it('БД не трогается: ни executor, ни драйвер не нужны и не вызываются', () => {
    // Executor, падающий при любом обращении: если бы дамп пошёл в БД,
    // тест упал бы вместе с ним.
    const throwingExecutor = (() => {
      throw new Error('DB access attempted during metadata dump');
    }) as unknown as YdbExecutor;

    MinimalEntity.setExecutor(throwingExecutor);
    try {
      const dump = buildMetadataDump([
        MinimalEntity,
        PhotoWithTagsEntity,
        TagEntity,
      ]);
      expect(dump.entities).toHaveLength(3);
      expect(dump.joinTables).toHaveLength(1);
    } finally {
      MinimalEntity.setExecutor(undefined);
    }

    // Функция синхронная и не возвращает промисов — никакого I/O по контракту.
    const result = buildMetadataDump([MinimalEntity]);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('сериализуемость: в JSON только простые значения', () => {
    const json = JSON.stringify(
      buildMetadataDump([PhotoWithTagsEntity, TagEntity]),
    );
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toMatch(/=>|function|WeakMap|undefined/);
    // Циклов нет — stringify завершился; структура плоская:
    const parsed = JSON.parse(json) as MetadataDump;
    expect(Array.isArray(parsed.entities)).toBe(true);
    expect(Array.isArray(parsed.joinTables)).toBe(true);
  });
});
