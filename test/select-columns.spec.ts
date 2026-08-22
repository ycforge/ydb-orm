import 'reflect-metadata';
import { createMockExecutor } from './helpers/mock-executor.js';
import { UserEntity } from './fixtures/user/user.entity.js';

describe('select columns (issue #10)', () => {
  afterEach(() => {
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined);
    UserEntity.setBlindIndexProvider(undefined);
  });

  const uuid1 = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';

  describe('find() с select', () => {
    it('генерирует SELECT с указанными колонками вместо SELECT *', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.find({ uuid: uuid1 }, { select: ['uuid', 'full_name'] });

      expect(mock.queries[0].sql).toContain('SELECT `uuid`, `full_name`');
      expect(mock.queries[0].sql).not.toContain('SELECT *');
    });

    it('без select — SELECT * (обратная совместимость)', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.find({ uuid: uuid1 });

      expect(mock.queries[0].sql).toContain('SELECT *');
    });

    it('с пустым select — SELECT *', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.find({ uuid: uuid1 }, { select: [] });

      expect(mock.queries[0].sql).toContain('SELECT *');
    });

    it('возвращает только запрошенные колонки (остальные undefined)', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      const result = await UserEntity.find(
        { uuid: uuid1 },
        { select: ['uuid', 'full_name'] },
      );

      expect(result).not.toBeNull();
      expect(result!.uuid).toBe(uuid1);
      expect(result!.full_name).toBe('Alice');
      expect((result as any).email_encrypted).toBeUndefined();
    });
  });

  describe('findAll() с select', () => {
    it('генерирует SELECT с указанными колонками', async () => {
      const mock = createMockExecutor([
        [
          { uuid: uuid1, full_name: 'Alice' },
          { uuid: '00000000-0000-0000-0000-000000000002', full_name: 'Bob' },
        ],
      ]);
      UserEntity.setExecutor(mock.executor);

      const result = await UserEntity.findAll(
        {},
        { select: ['uuid', 'full_name'] },
      );

      expect(mock.queries[0].sql).toContain('SELECT `uuid`, `full_name`');
      expect(mock.queries[0].sql).not.toContain('SELECT *');
      expect(result).toHaveLength(2);
    });

    it('без select — SELECT * (обратная совместимость)', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.findAll({});

      expect(mock.queries[0].sql).toContain('SELECT *');
    });
  });

  describe('query builder .select()', () => {
    it('генерирует SELECT с указанными колонками', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      const result = await UserEntity.query()
        .select(['uuid', 'full_name'])
        .where({ uuid: uuid1 })
        .getMany();

      expect(mock.queries[0].sql).toContain('SELECT `uuid`, `full_name`');
      expect(mock.queries[0].sql).not.toContain('SELECT *');
      expect(result).toHaveLength(1);
    });

    it('без select — SELECT * (обратная совместимость)', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.query().where({ uuid: uuid1 }).getMany();

      expect(mock.queries[0].sql).toContain('SELECT *');
    });

    it('цепочка select + orderBy + limit', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1, full_name: 'Alice' }]]);
      UserEntity.setExecutor(mock.executor);

      const built = await UserEntity.query()
        .select(['uuid', 'full_name'])
        .where({ uuid: uuid1 })
        .orderBy('full_name', 'ASC')
        .limit(10)
        .toYql();

      expect(built.sql).toContain('SELECT `uuid`, `full_name`');
      expect(built.sql).toContain('ORDER BY `full_name` ASC');
      expect(built.sql).toContain('LIMIT 10');
    });

    it('select с.single колонкой', async () => {
      const mock = createMockExecutor([[{ uuid: uuid1 }]]);
      UserEntity.setExecutor(mock.executor);

      const built = await UserEntity.query()
        .select(['uuid'])
        .where({ uuid: uuid1 })
        .toYql();

      expect(built.sql).toContain('SELECT `uuid`');
      expect(built.sql).not.toContain('SELECT *');
    });
  });
});
