import 'reflect-metadata';
import { YdbEntity } from '../decorators/entity.decorator.js';
import { YdbColumn, YdbPrimaryColumn } from '../decorators/column.decorator.js';
import { YdbBaseEntity } from '../entity/base-entity.js';
import { getEntityRuntime } from '../entity/entity-runtime.js';
import { createMockExecutor } from '../../test/helpers/mock-executor.js';

@YdbEntity('qb_photos')
class QbPhotoEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  title: string;

  @YdbColumn('Bool')
  is_public: boolean;

  @YdbColumn('Double')
  rating: number;
}

function mockRuntime(rows: any[][] = [[]]) {
  const mock = createMockExecutor(rows);
  getEntityRuntime(QbPhotoEntity).executor = mock.executor;
  return mock;
}

describe('YdbQueryBuilder', () => {
  it('builds SELECT with WHERE, ORDER BY, LIMIT/OFFSET', async () => {
    mockRuntime();
    const { sql, values } = await QbPhotoEntity.query()
      .where({ is_public: true })
      .andWhere({ title: 'Sunset' })
      .orderBy('rating', 'DESC')
      .addOrderBy('title')
      .limit(20)
      .offset(10)
      .toYql();

    expect(sql).toBe(
      'SELECT `uuid`, `title`, `is_public`, `rating` FROM `qb_photos` ' +
        'WHERE `is_public` = $is_public AND `title` = $title ' +
        'ORDER BY `rating` DESC, `title` ASC LIMIT 20 OFFSET 10',
    );
    expect(values).toEqual({ is_public: true, title: 'Sunset' });
  });

  it('builds SELECT without WHERE', async () => {
    mockRuntime();
    const { sql } = await QbPhotoEntity.query().toYql();
    expect(sql).toBe(
      'SELECT `uuid`, `title`, `is_public`, `rating` FROM `qb_photos` LIMIT 100 OFFSET 0',
    );
  });

  it('throws on unknown ORDER BY field', async () => {
    mockRuntime();
    await expect(QbPhotoEntity.query().orderBy('nope').toYql()).rejects.toThrow(
      /Unknown field in ORDER BY: "nope" on entity QbPhotoEntity\. Known fields:/,
    );
  });

  it('normalizes direction case and whitespace in orderBy', async () => {
    mockRuntime();
    const { sql } = await QbPhotoEntity.query()
      .orderBy('rating', ' desc ' as any)
      .toYql();
    expect(sql).toContain('ORDER BY `rating` DESC');

    const { sql: ascSql } = await QbPhotoEntity.query()
      .orderBy('rating', 'Asc' as any)
      .toYql();
    expect(ascSql).toContain('ORDER BY `rating` ASC');
  });

  it('normalizes and validates direction in addOrderBy', async () => {
    mockRuntime();
    const { sql } = await QbPhotoEntity.query()
      .orderBy('rating', 'desc' as any)
      .addOrderBy('title', ' Asc' as any)
      .toYql();
    expect(sql).toContain('ORDER BY `rating` DESC, `title` ASC');
  });

  it('rejects invalid direction before it reaches SQL (any bypass)', () => {
    mockRuntime();
    const injection = 'DESC, (SELECT group_concat(name) FROM users)' as any;
    expect(() => QbPhotoEntity.query().orderBy('rating', injection)).toThrow(
      /Invalid ORDER BY direction/,
    );
    expect(() => QbPhotoEntity.query().addOrderBy('rating', injection)).toThrow(
      /Invalid ORDER BY direction/,
    );
  });

  it('rejects invalid direction passed to addOrderBy via any', () => {
    mockRuntime();
    const injection = 'ASC; DROP TABLE qb_photos' as any;
    const builder = QbPhotoEntity.query().orderBy('rating');
    expect(() => builder.addOrderBy('title', injection)).toThrow(
      /Invalid ORDER BY direction/,
    );
  });

  it('rejects non-string directions from JavaScript callers', () => {
    mockRuntime();
    for (const bad of [null as any, 1 as any, {} as any]) {
      expect(() => QbPhotoEntity.query().orderBy('rating', bad)).toThrow(
        /Invalid ORDER BY direction/,
      );
      expect(() => QbPhotoEntity.query().addOrderBy('rating', bad)).toThrow(
        /Invalid ORDER BY direction/,
      );
    }
  });

  it('throws on unknown WHERE field', async () => {
    mockRuntime();
    await expect(
      QbPhotoEntity.query().where({ nope: 1 }).toYql(),
    ).rejects.toThrow(
      /Unknown field in WHERE: "nope" on entity QbPhotoEntity\. Known fields:/,
    );
  });

  it('getMany executes through executor and returns entities', async () => {
    const row = {
      uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
      title: 'Sunset',
      is_public: true,
      rating: 4.5,
    };
    const mock = mockRuntime([[row]]);

    const result = await QbPhotoEntity.query()
      .where({ is_public: true })
      .getMany();

    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(QbPhotoEntity);
    expect(result[0].title).toBe('Sunset');
    expect(mock.queries[0].sql).toContain('WHERE `is_public` = $is_public');
  });

  it('getOne limits to 1 and returns first entity or null', async () => {
    const mock = mockRuntime([
      [
        {
          uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
          title: 'Sunset',
          is_public: true,
          rating: 4.5,
        },
      ],
    ]);

    const one = await QbPhotoEntity.query().getOne();
    expect(one?.title).toBe('Sunset');
    expect(mock.queries[0].sql).toContain('LIMIT 1 OFFSET 0');

    mockRuntime([[]]);
    const none = await QbPhotoEntity.query().getOne();
    expect(none).toBeNull();
  });

  it('getOne does not mutate the builder: getMany after it keeps the original limit', async () => {
    const sunset = {
      uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
      title: 'Sunset',
      is_public: true,
      rating: 4.5,
    };
    const dawn = {
      uuid: 'a1e1d4b2-0000-4000-8000-0f0c0e0d0c0b',
      title: 'Dawn',
      is_public: true,
      rating: 3.0,
    };
    const mock = mockRuntime([[sunset, dawn]]);

    const builder = QbPhotoEntity.query()
      .where({ is_public: true })
      .orderBy('rating', 'DESC')
      .limit(10);

    const one = await builder.getOne();
    expect(one).toBeInstanceOf(QbPhotoEntity);
    expect(one?.title).toBe('Sunset');
    expect(mock.queries[0].sql).toContain('LIMIT 1 OFFSET 0');

    const many = await builder.getMany();
    expect(mock.queries[1].sql).toContain('LIMIT 10 OFFSET 0');
    expect(mock.queries[1].sql).toContain('ORDER BY `rating` DESC');
    expect(many).toHaveLength(2);

    const { sql } = await builder.toYql();
    expect(sql).toContain('LIMIT 10 OFFSET 0');
  });

  it('limit(0) yields an empty result (LIMIT 0), not clamped to 1', async () => {
    const mock = mockRuntime([[]]);

    const result = await QbPhotoEntity.query()
      .where({ is_public: true })
      .limit(0)
      .getMany();
    expect(result).toEqual([]);
    expect(mock.queries[0].sql).toContain('LIMIT 0 OFFSET 0');
  });

  it('getOne with limit(0) returns null and leaves the builder at limit(0)', async () => {
    const mock = mockRuntime([[]]);
    const builder = QbPhotoEntity.query().limit(0);

    const one = await builder.getOne();
    expect(one).toBeNull();
    expect(mock.queries[0].sql).toContain('LIMIT 1 OFFSET 0');

    const { sql } = await builder.toYql();
    expect(sql).toContain('LIMIT 0 OFFSET 0');
  });

  it('omitted limit keeps the default safety limit of 100', async () => {
    mockRuntime();
    const { sql } = await QbPhotoEntity.query().toYql();
    expect(sql).toContain('LIMIT 100 OFFSET 0');
  });

  it('normal positive limit passes through unchanged', async () => {
    mockRuntime();
    const { sql } = await QbPhotoEntity.query().limit(5).toYql();
    expect(sql).toContain('LIMIT 5 OFFSET 0');
  });

  it('rejects negative limit explicitly instead of clamping it', async () => {
    mockRuntime();
    await expect(QbPhotoEntity.query().limit(-1).toYql()).rejects.toThrow(
      /Invalid LIMIT: -1\. LIMIT must be a finite non-negative integer\./,
    );
    await expect(QbPhotoEntity.query().limit(-100).getMany()).rejects.toThrow(
      /Invalid LIMIT/,
    );
  });

  it('rejects fractional positive limit instead of flooring it', async () => {
    mockRuntime();
    await expect(QbPhotoEntity.query().limit(1.9).toYql()).rejects.toThrow(
      /Invalid LIMIT: 1\.9\. LIMIT must be a finite non-negative integer\./,
    );
    await expect(QbPhotoEntity.query().limit(0.5).getMany()).rejects.toThrow(
      /Invalid LIMIT/,
    );
  });

  it('rejects fractional negative limit', async () => {
    mockRuntime();
    await expect(QbPhotoEntity.query().limit(-1.9).toYql()).rejects.toThrow(
      /Invalid LIMIT: -1\.9\. LIMIT must be a finite non-negative integer\./,
    );
    await expect(QbPhotoEntity.query().limit(-0.5).getMany()).rejects.toThrow(
      /Invalid LIMIT/,
    );
  });

  it('rejects non-finite limits', async () => {
    mockRuntime();
    for (const bad of [Infinity, -Infinity, NaN]) {
      await expect(QbPhotoEntity.query().limit(bad).toYql()).rejects.toThrow(
        /Invalid LIMIT: (Infinity|-Infinity|NaN)\. LIMIT must be a finite non-negative integer\./,
      );
    }
  });

  it('getCount builds COUNT query without LIMIT', async () => {
    const mock = mockRuntime([[{ cnt: 7 }]]);

    const count = await QbPhotoEntity.query()
      .where({ is_public: true })
      .getCount();

    expect(count).toBe(7);
    expect(mock.queries[0].sql).toBe(
      'SELECT COUNT(*) AS cnt FROM `qb_photos` WHERE `is_public` = $is_public',
    );
  });

  it('clamps limit to 1000 and floor-offsets', async () => {
    mockRuntime();
    const { sql } = await QbPhotoEntity.query().limit(5000).offset(-5).toYql();
    expect(sql).toContain('LIMIT 1000 OFFSET 0');
  });
});
