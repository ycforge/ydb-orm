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
      'SELECT * FROM `qb_photos` ' +
        'WHERE `is_public` = $is_public AND `title` = $title ' +
        'ORDER BY `rating` DESC, `title` ASC LIMIT 20 OFFSET 10',
    );
    expect(values).toEqual({ is_public: true, title: 'Sunset' });
  });

  it('builds SELECT without WHERE', async () => {
    mockRuntime();
    const { sql } = await QbPhotoEntity.query().toYql();
    expect(sql).toBe('SELECT * FROM `qb_photos` LIMIT 100 OFFSET 0');
  });

  it('throws on unknown ORDER BY field', async () => {
    mockRuntime();
    await expect(QbPhotoEntity.query().orderBy('nope').toYql()).rejects.toThrow(
      /Unknown field in ORDER BY: "nope" on entity QbPhotoEntity\. Known fields:/,
    );
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
