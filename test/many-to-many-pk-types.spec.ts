import 'reflect-metadata';
import { Int64, Uuid } from '@ydbjs/value/primitive';
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
import { buildExpectedJoinTableSchema } from '../src/schema/schema-sync.js';
import { createMockExecutor } from './helpers/mock-executor.js';

/**
 * Регрессионные тесты #90: имена и типы колонок join-таблицы many-to-many
 * выводятся из фактических PK обеих сущностей, и сгенерированная схема
 * совпадает с тем, что relations-код читает из join-таблицы.
 */

// Int64 PK (owner) <-> Utf8 PK (inverse), явные имена колонок
@YdbEntity('m2m_orders')
@EagerLoad(['skus'])
class OrderEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  order_id: bigint;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => SkuEntity, (sku) => sku.orders)
  @JoinTable('order_skus', {
    joinColumn: 'order_ref',
    inverseJoinColumn: 'sku_code',
  })
  skus?: SkuEntity[];
}

@YdbEntity('m2m_skus')
class SkuEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  sku: string;

  @YdbColumn('Utf8')
  label: string;

  @ManyToMany(() => OrderEntity, (order) => order.skus)
  orders?: OrderEntity[];
}

// Uuid PK с кастомными именами свойств: дефолтные имена колонок выводятся
// из PK ({table}_{pk}), а не из жёсткого {table}_uuid
@YdbEntity('m2m_articles')
class ArticleEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  article_id: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => AuthorEntity, (author) => author.articles)
  authors?: AuthorEntity[];
}

@YdbEntity('m2m_authors')
class AuthorEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  author_id: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => ArticleEntity, (article) => article.authors)
  @JoinTable('article_author')
  articles?: ArticleEntity[];
}

// JoinTable объявлена на inverse-стороне: owner читает через её метаданные
@YdbEntity('m2m_students')
class StudentEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Int64')
  student_id: bigint;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => CourseEntity, (course) => course.students)
  courses?: CourseEntity[];
}

@YdbEntity('m2m_courses')
class CourseEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  code: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => StudentEntity, (student) => student.courses)
  @JoinTable('course_enrollment', {
    joinColumn: 'course_code',
    inverseJoinColumn: 'student_ref',
  })
  students?: StudentEntity[];
}

// Составной PK на стороне owner — рантайм обязан отказать явно (#90)
@YdbEntity('m2m_comp_photos')
@EagerLoad(['tags'])
class CompositePhotoEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Utf8')
  tenant_id: string;

  @YdbPrimaryColumn('Uuid')
  photo_uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @ManyToMany(() => CompositeTagEntity, (tag) => tag.photos)
  @JoinTable('composite_photo_tag')
  tags?: CompositeTagEntity[];
}

@YdbEntity('m2m_comp_tags')
class CompositeTagEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  tag_uuid: string;

  @YdbColumn('Utf8')
  name: string;

  @ManyToMany(() => CompositePhotoEntity, (photo) => photo.tags)
  photos?: CompositePhotoEntity[];
}

const orderRow = { order_id: 10n, title: 'o1' };
const skuRows = [
  { sku: 'a1', label: 'A' },
  { sku: 'b2', label: 'B' },
];
const linkRows = [
  { order_ref: 10n, sku_code: 'a1' },
  { order_ref: 10n, sku_code: 'b2' },
];

describe('many-to-many join tables derived from actual PKs (#90)', () => {
  let executors: Array<ReturnType<typeof createMockExecutor>> = [];

  function setup(rows: any[][]) {
    const mock = createMockExecutor(rows, { sequential: true });
    executors.push(mock);
    return mock;
  }

  afterEach(() => {
    for (const Entity of [
      OrderEntity,
      SkuEntity,
      ArticleEntity,
      AuthorEntity,
      StudentEntity,
      CourseEntity,
      CompositePhotoEntity,
      CompositeTagEntity,
    ]) {
      Entity.setExecutor(undefined as any);
    }
    executors = [];
  });

  it('generated schema columns match what eager load reads (Int64/Utf8 PKs)', async () => {
    const [jt] = getManyToManyJoinTables([OrderEntity, SkuEntity]);
    const schema = buildExpectedJoinTableSchema(jt);

    // Строки «вставлены» в сгенерированную схему: ключи — её колонки
    expect(Object.keys(schema.columns).sort()).toEqual([
      'order_ref',
      'sku_code',
    ]);
    expect(Object.keys(linkRows[0]).sort()).toEqual(
      Object.keys(schema.columns).sort(),
    );

    const mock = setup([[[orderRow]], [linkRows], [skuRows]]);
    OrderEntity.setExecutor(mock.executor);

    const order = await OrderEntity.find({ order_id: 10n });

    // SELECT из join-таблицы использует ровно колонки сгенерированной схемы
    expect(mock.queries[1].sql).toContain('FROM `order_skus`');
    expect(mock.queries[1].sql).toContain(
      'SELECT `order_ref`, `sku_code` FROM `order_skus`',
    );
    expect(mock.queries[1].sql).toContain('WHERE `order_ref` IN ($p0)');
    // Параметр промаплен по типу PK владельца (Int64), а не Uuid
    expect(mock.queries[1].params.p0).toBeInstanceOf(Int64);

    expect(order?.skus?.map((s) => s.sku)).toEqual(['a1', 'b2']);
  });

  it('eager load groups related entities by non-uuid owner PK', async () => {
    const mock = setup([
      [[orderRow, { order_id: 20n, title: 'o2' }]],
      [[...linkRows, { order_ref: 20n, sku_code: 'a1' }]],
      [skuRows],
    ]);
    OrderEntity.setExecutor(mock.executor);

    const orders = await OrderEntity.findAll();

    const byOwner = new Map(orders.map((o) => [o.order_id, o]));
    expect(byOwner.get(10n)?.skus?.map((s) => s.sku)).toEqual(['a1', 'b2']);
    expect(byOwner.get(20n)?.skus?.map((s) => s.sku)).toEqual(['a1']);
  });

  it('loadRelations uses default column names derived from custom uuid PK names', async () => {
    const articleRow = {
      article_id: '11111111-2222-4333-8444-555555555555',
      title: 'a1',
    };
    const authorRow = {
      author_id: '99999999-8888-4777-8666-777777777777',
      name: 'Ivan',
    };
    const link = [
      {
        m2m_articles_article_id: articleRow.article_id,
        m2m_authors_author_id: authorRow.author_id,
      },
    ];

    // loadRelations делает ровно два запроса: join-select, затем выборка target
    const mock = setup([[link], [[authorRow]]]);
    ArticleEntity.setExecutor(mock.executor);

    const article = new ArticleEntity();
    article.article_id = articleRow.article_id;
    await article.loadRelations(['authors']);

    expect(mock.queries[0].sql).toContain('FROM `article_author`');
    expect(mock.queries[0].sql).toContain(
      'SELECT `m2m_articles_article_id`, `m2m_authors_author_id` FROM `article_author`',
    );
    expect(mock.queries[0].params.p0).toBeInstanceOf(Uuid);
    expect(article.authors?.[0]?.author_id).toBe(authorRow.author_id);
  });

  it('resolves join table declared on the inverse side with explicit names', async () => {
    const courseRow = { code: 'cs101', title: 'CS' };
    const link = [{ course_code: 'cs101', student_ref: 7n }];

    const mock = setup([[link], [[courseRow]]]);
    StudentEntity.setExecutor(mock.executor);

    const student = new StudentEntity();
    student.student_id = 7n;
    await student.loadRelations(['courses']);

    expect(mock.queries[0].sql).toContain('FROM `course_enrollment`');
    expect(mock.queries[0].sql).toContain(
      'SELECT `student_ref`, `course_code` FROM `course_enrollment`',
    );
    expect(mock.queries[0].sql).toContain('WHERE `student_ref` IN ($p0)');
    expect(mock.queries[0].params.p0).toBeInstanceOf(Int64);
    expect(student.courses?.[0]?.code).toBe('cs101');
  });

  it('rejects composite primary keys at runtime instead of reading a broken schema', async () => {
    // Строка владельца нужна, чтобы eager-загрузка дошла до резолва join-таблицы
    const mock = setup([
      [
        [
          {
            tenant_id: 't1',
            photo_uuid: '11111111-2222-4333-8444-555555555555',
            title: 'p1',
          },
        ],
      ],
    ]);
    CompositePhotoEntity.setExecutor(mock.executor);

    const photo = new CompositePhotoEntity();
    photo.tenant_id = 't1';
    photo.photo_uuid = '11111111-2222-4333-8444-555555555555';

    await expect(photo.loadRelations(['tags'])).rejects.toThrow(
      /composite primary keys.*not supported in.*many-to-many/s,
    );

    await expect(CompositePhotoEntity.findAll()).rejects.toThrow(
      /composite primary keys.*not supported in.*many-to-many/s,
    );
  });
});
