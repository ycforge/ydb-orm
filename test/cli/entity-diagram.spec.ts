import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  OneToMany,
  ManyToOne,
  ManyToMany,
  JoinTable,
  buildEntityDiagram,
  writeDiagramFile,
} from '../../src/index.js';
import type { YdbExecutor } from '../../src/index.js';
import { UserEntity } from '../fixtures/user/user.entity.js';
import { UserRoleEntity } from '../fixtures/user_role/user_role.entity.js';
import { MembershipEntity } from '../fixtures/membership/membership.entity.js';
import { DeviceEntity } from '../fixtures/one_to_one/device.entity.js';
import { DeviceLicenseEntity } from '../fixtures/one_to_one/device-license.entity.js';
import { PhotoWithTagsEntity } from '../fixtures/photo_with_tags/photo_with_tags.entity.js';
import { TagEntity } from '../fixtures/tag/tag.entity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Регресс-тесты entity:diagram (#36): read-only рендер канонических метаданных
// в Mermaid ER без обращения к БД. Источник — тот же дамп, что у metadata:dump
// (#37), поэтому невалидные метаданные роняют команду до любого вывода.
// ─────────────────────────────────────────────────────────────────────────────

/** Минимальная сущность: одна PK-колонка и одна обычная. */
@YdbEntity('ed_minimal')
class MinimalDiagramEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

/** Составной PK: порядок объявления значим (#89). */
@YdbEntity('ed_composite')
class CompositePkDiagramEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id!: string;

  @YdbPrimaryColumn('Uuid')
  user_uuid!: string;

  @YdbColumn('Int32')
  score!: number;
}

// ── Связи ────────────────────────────────────────────────────────────────────

@YdbEntity('ed_posts')
class PostEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @OneToMany(() => CommentEntity, (comment) => comment.post_uuid)
  comments?: CommentEntity[];

  @ManyToMany(() => LabelEntity, (label) => label.posts)
  @JoinTable('ed_post_label')
  labels?: LabelEntity[];
}

@YdbEntity('ed_comments')
class CommentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Uuid')
  post_uuid!: string;

  @ManyToOne(() => PostEntity, (comment) => comment.post_uuid)
  post?: PostEntity;
}

@YdbEntity('ed_labels')
class LabelEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @ManyToMany(() => PostEntity, (post) => post.labels)
  posts?: PostEntity[];
}

/** Парные one-to-many ↔ many-to-one без прочих связей. */
@YdbEntity('ed_paired_parents')
class PairedParentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @OneToMany(() => PairedChildEntity, (child) => child.parent_uuid)
  children?: PairedChildEntity[];
}

@YdbEntity('ed_paired_children')
class PairedChildEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Uuid')
  parent_uuid!: string;

  @ManyToOne(() => PairedParentEntity, (child) => child.parent_uuid)
  parent?: PairedParentEntity;
}

/** Однонаправленный one-to-many: обратной many-to-one на цели нет. */
@YdbEntity('ed_parent_only')
class ParentOnlyEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @OneToMany(() => OrphanChildEntity, (child) => child.parent_uuid)
  children?: OrphanChildEntity[];
}

@YdbEntity('ed_orphan_children')
class OrphanChildEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Uuid')
  parent_uuid!: string;
}

// ── Имена, требующие экранирования/санитизации ───────────────────────────────

/**
 * Имена таблиц валидируются самим ORM (@YdbEntity), но имена свойств — это
 * произвольные идентификаторы TS ($, юникод), а имена/колонки join-таблиц
 * из @JoinTable никак не ограничены.
 */
@YdbEntity('ed_weird')
class WeirdPropsEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Int32')
  $amount!: number;

  @YdbColumn('Utf8')
  имя!: string;
}

@YdbEntity('ed_wj_left')
class WeirdJoinLeftEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  code!: string;

  @ManyToMany(() => WeirdJoinRightEntity)
  @JoinTable('jt "quoted" name', {
    joinColumn: 'left col',
    inverseJoinColumn: 'right"col',
  })
  rights?: WeirdJoinRightEntity[];
}

@YdbEntity('ed_wj_right')
class WeirdJoinRightEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

// ── Невалидные метаданные ────────────────────────────────────────────────────

class NotDecoratedDiagramEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

@YdbEntity('ed_no_pk')
class NoPkDiagramEntity extends YdbBaseEntity {
  @YdbColumn('Uuid')
  uuid!: string;
}

// ── Хелперы ──────────────────────────────────────────────────────────────────

const blockOf = (diagram: string, table: string): string[] => {
  const open = `  "${table.replace(/"/g, "'")}" {`;
  const start = diagram.indexOf(open);
  if (start < 0) throw new Error(`block for "${table}" not found`);
  const end = diagram.indexOf('\n  }', start);
  return diagram.slice(start, end + 4).split('\n');
};

const edgesOf = (diagram: string): string[] =>
  diagram
    .split('\n')
    // Линии связей — единственные строки с « : » (атрибуты и блоки их
    // не содержат).
    .filter((line) => line.includes(' : '));

describe('entity:diagram (#36)', () => {
  it('минимальная сущность: PK-маркер, колонки с типами YDB', () => {
    const diagram = buildEntityDiagram([MinimalDiagramEntity]);

    expect(diagram).toBe(
      [
        'erDiagram',
        '  "ed_minimal" {',
        '    Uuid uuid PK',
        '    Utf8 name',
        '  }',
      ].join('\n'),
    );
  });

  it('составной PK: колонки PK идут первыми в порядке объявления (#89)', () => {
    const diagram = buildEntityDiagram([CompositePkDiagramEntity]);

    expect(blockOf(diagram, 'ed_composite')).toEqual([
      '  "ed_composite" {',
      '    Utf8 tenant_id PK',
      '    Uuid user_uuid PK',
      '    Int32 score',
      '  }',
    ]);
  });

  describe('one-to-many / many-to-one', () => {
    it('парная связь по одной join-колонке даёт ровно одну линию', () => {
      const diagram = buildEntityDiagram([
        PairedParentEntity,
        PairedChildEntity,
      ]);

      // many-to-one (владелец FK) уже нарисовал линию — парный one-to-many
      // не дублирует её.
      expect(edgesOf(diagram)).toEqual([
        '  "ed_paired_parents" ||--o{ "ed_paired_children" : "parent"',
      ]);
      // FK-колонка помечена на дочерней таблице
      expect(blockOf(diagram, 'ed_paired_children')).toContain(
        '    Uuid parent_uuid FK',
      );
    });

    it('однонаправленный one-to-many рисуется от родителя', () => {
      const diagram = buildEntityDiagram([ParentOnlyEntity, OrphanChildEntity]);

      expect(edgesOf(diagram)).toEqual([
        '  "ed_parent_only" ||--o{ "ed_orphan_children" : "children"',
      ]);
      // FK физически живёт в целевой таблице — маркер ставится там
      expect(blockOf(diagram, 'ed_orphan_children')).toContain(
        '    Uuid parent_uuid FK',
      );
    });
  });

  it('one-to-one: кратность ||--o| от цели к владельцу FK', () => {
    const diagram = buildEntityDiagram([DeviceEntity, DeviceLicenseEntity]);

    expect(edgesOf(diagram)).toEqual([
      '  "fixture_device_licenses" ||--o| "fixture_devices" : "license"',
    ]);
    expect(blockOf(diagram, 'fixture_devices')).toContain(
      '    Uuid license_uuid FK',
    );
  });

  describe('many-to-many через явную join-таблицу', () => {
    let diagram: string;

    beforeEach(() => {
      diagram = buildEntityDiagram([PostEntity, CommentEntity, LabelEntity]);
    });

    it('join-таблица — отдельный блок с физическими колонками PK+FK', () => {
      expect(blockOf(diagram, 'ed_post_label')).toEqual([
        '  "ed_post_label" {',
        '    Uuid ed_posts_uuid PK, FK',
        '    Uuid ed_labels_uuid PK, FK',
        '  }',
      ]);
    });

    it('две линии владелец → join → обратная сторона; без дублей', () => {
      expect(edgesOf(diagram)).toEqual([
        '  "ed_post_label" ||--o{ "ed_labels" : "ed_labels_uuid"',
        '  "ed_posts" ||--o{ "ed_comments" : "post"',
        '  "ed_posts" ||--o{ "ed_post_label" : "ed_posts_uuid"',
      ]);
    });

    it('inverse-side many-to-many ссылается на ту же join-таблицу', () => {
      // Только «обратная» сущность без владельца: join-таблица не резолвится
      // (владелец вне списка) — лишних блоков и линий нет.
      const inverseOnly = buildEntityDiagram([LabelEntity]);
      expect(blockOf(inverseOnly, 'ed_labels')).toEqual([
        '  "ed_labels" {',
        '    Uuid uuid PK',
        '  }',
      ]);
      expect(inverseOnly).not.toContain('ed_post_label');
      expect(edgesOf(inverseOnly)).toEqual([]);
    });

    it('фикстуры #90: явные имена join-колонок попадают в блок и линии', () => {
      const fixtureDiagram = buildEntityDiagram([
        PhotoWithTagsEntity,
        TagEntity,
      ]);

      expect(blockOf(fixtureDiagram, 'photo_tag')).toEqual([
        '  "photo_tag" {',
        '    Uuid photos_with_tags_uuid PK, FK',
        '    Uuid tags_uuid PK, FK',
        '  }',
      ]);
      expect(edgesOf(fixtureDiagram)).toEqual([
        '  "photo_tag" ||--o{ "tags" : "tags_uuid"',
        '  "photos_with_tags" ||--o{ "photo_tag" : "photos_with_tags_uuid"',
      ]);
    });
  });

  it('несколько сущностей со перекрёстными связями: все блоки и линии', () => {
    const diagram = buildEntityDiagram([
      UserEntity,
      UserRoleEntity,
      MembershipEntity,
      DeviceEntity,
      DeviceLicenseEntity,
      PhotoWithTagsEntity,
      TagEntity,
    ]);

    // Все таблицы присутствуют блоками
    for (const table of [
      'users',
      'user_roles',
      'memberships',
      'fixture_devices',
      'fixture_device_licenses',
      'photos_with_tags',
      'tags',
      'photo_tag',
    ]) {
      expect(blockOf(diagram, table).length).toBeGreaterThan(1);
    }

    expect(edgesOf(diagram)).toEqual([
      // Сортировка по левой таблице, затем по правой и метке
      '  "fixture_device_licenses" ||--o| "fixture_devices" : "license"',
      '  "photo_tag" ||--o{ "tags" : "tags_uuid"',
      '  "photos_with_tags" ||--o{ "photo_tag" : "photos_with_tags_uuid"',
      '  "users" ||--o{ "memberships" : "user"', // many-to-one
      '  "users" ||--o{ "user_roles" : "userRoles"', // однонаправленный one-to-many
    ]);

    // FK-маркеры расставлены по физическим владельцам колонок; здесь оба FK
    // входят в составной PK (порядок PK сохранён)
    expect(blockOf(diagram, 'memberships')).toContain(
      '    Uuid user_uuid PK, FK',
    );
    expect(blockOf(diagram, 'user_roles')).toContain(
      '    Uuid user_uuid PK, FK',
    );
  });

  it('имена с кавычками/юникодом/спецсимволами не ломают Mermaid', () => {
    const diagram = buildEntityDiagram([
      WeirdPropsEntity,
      WeirdJoinLeftEntity,
      WeirdJoinRightEntity,
    ]);
    const lines = diagram.split('\n');

    // Свойства-идентификаторы TS ($, юникод) санитизируются, оригинал —
    // комментарием; PK-колонка идёт первой.
    expect(blockOf(diagram, 'ed_weird')).toEqual([
      '  "ed_weird" {',
      '    Uuid uuid PK',
      '    Int32 c__amount "$amount"',
      '    Utf8 c____ "имя"',
      '  }',
    ]);

    // Имя и колонки join-таблицы из @JoinTable ничем не ограничены:
    // двойные кавычки экранируются, недопустимые для атрибутов символы —
    // санитизация с сохранением оригинала в комментарии.
    expect(blockOf(diagram, "jt 'quoted' name")).toEqual([
      `  "jt 'quoted' name" {`,
      '    Utf8 left_col PK, FK "left col"',
      `    Uuid right_col PK, FK "right'col"`,
      '  }',
    ]);
    expect(edgesOf(diagram)).toEqual([
      `  "ed_wj_left" ||--o{ "jt 'quoted' name" : "left col"`,
      `  "jt 'quoted' name" ||--o{ "ed_wj_right" : "right'col"`,
    ]);

    // Ни одна строка не содержит незакрытой кавычки: чётное число кавычек
    for (const line of lines.slice(1)) {
      const quotes = (line.match(/"/g) ?? []).length;
      expect(quotes % 2).toBe(0);
    }
  });

  it('детерминизм: порядок входного списка не влияет на вывод', () => {
    const entities = [
      UserEntity,
      UserRoleEntity,
      MembershipEntity,
      DeviceEntity,
      DeviceLicenseEntity,
      PhotoWithTagsEntity,
      TagEntity,
      MinimalDiagramEntity,
      CompositePkDiagramEntity,
      PostEntity,
      CommentEntity,
      LabelEntity,
    ];

    const first = buildEntityDiagram(entities);
    const second = buildEntityDiagram([...entities].reverse());
    const shuffled = buildEntityDiagram([
      TagEntity,
      PostEntity,
      UserEntity,
      CompositePkDiagramEntity,
      DeviceLicenseEntity,
      LabelEntity,
      PhotoWithTagsEntity,
      MembershipEntity,
      MinimalDiagramEntity,
      CommentEntity,
      UserRoleEntity,
      DeviceEntity,
    ]);

    expect(first).toBe(second);
    expect(first).toBe(shuffled);
  });

  describe('невалидные метаданные падают до любого вывода/записи', () => {
    const tmpDir = (): string =>
      fs.mkdtempSync(path.join(os.tmpdir(), 'ydb-orm-diagram-'));

    it('класс без @YdbEntity', () => {
      expect(() => buildEntityDiagram([NotDecoratedDiagramEntity])).toThrow(
        'Class NotDecoratedDiagramEntity is not decorated with @YdbEntity',
      );
    });

    it('сущность без первичного ключа', () => {
      expect(() => buildEntityDiagram([NoPkDiagramEntity])).toThrow(
        'no primary key is declared',
      );
    });

    it('файл не создаётся при ошибке построения диаграммы', () => {
      const dir = tmpDir();
      try {
        const target = path.join(dir, 'out.mmd');
        expect(() => {
          const diagram = buildEntityDiagram([NoPkDiagramEntity]);
          writeDiagramFile(target, diagram);
        }).toThrow('no primary key is declared');
        expect(fs.existsSync(target)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writeDiagramFile никогда не перезаписывает существующий файл', () => {
      const dir = tmpDir();
      try {
        const target = path.join(dir, 'exists.mmd');
        fs.writeFileSync(target, 'keep me');
        expect(() =>
          writeDiagramFile(target, buildEntityDiagram([MinimalDiagramEntity])),
        ).toThrow(/File already exists/);
        expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writeDiagramFile создаёт новый файл с завершающим переводом строки', () => {
      const dir = tmpDir();
      try {
        const target = path.join(dir, 'fresh.mmd');
        writeDiagramFile(target, buildEntityDiagram([MinimalDiagramEntity]));
        const content = fs.readFileSync(target, 'utf8');
        expect(content.startsWith('erDiagram\n')).toBe(true);
        expect(content.endsWith('\n')).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('БД не трогается: executor/driver не нужны и не вызываются', () => {
    // Executor, падающий при любом обращении: если бы диаграмма пошла в БД,
    // тест упал бы вместе с ним.
    const throwingExecutor = (() => {
      throw new Error('DB access attempted during entity diagram');
    }) as unknown as YdbExecutor;

    MinimalDiagramEntity.setExecutor(throwingExecutor);
    try {
      const diagram = buildEntityDiagram([
        MinimalDiagramEntity,
        PhotoWithTagsEntity,
        TagEntity,
      ]);
      expect(diagram).toContain('"photos_with_tags"');
      expect(edgesOf(diagram)).toHaveLength(2);
    } finally {
      MinimalDiagramEntity.setExecutor(undefined);
    }

    // Функция синхронная и не возвращает промисов — никакого I/O по контракту.
    const result = buildEntityDiagram([MinimalDiagramEntity]);
    expect(result).not.toBeInstanceOf(Promise);
  });
});
