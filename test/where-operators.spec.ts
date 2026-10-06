import 'reflect-metadata';
import { WhereOperatorEntity } from './fixtures/where_operator/where-operator.entity.js';
import {
  ParamCollisionEntity,
  ParamCollisionEnumUtf8Entity,
  ParamCollisionEnumInt32Entity,
  ParamCollisionJsonWhereEntity,
  ParamCollisionJsonSetEntity,
  ParamCollisionEnumSetEntity,
} from './fixtures/param_collision/param-collision.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import { Utf8, Int32, Uuid } from '@ydbjs/value/primitive';

const COLLISION_UUID = '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5';

describe('WHERE operators', () => {
  afterEach(() => {
    WhereOperatorEntity.setExecutor(undefined as any);
    WhereOperatorEntity.setEncryptionProvider(undefined);
    WhereOperatorEntity.setBlindIndexProvider(undefined);
    ParamCollisionEntity.setExecutor(undefined as any);
    ParamCollisionEnumUtf8Entity.setExecutor(undefined as any);
    ParamCollisionEnumInt32Entity.setExecutor(undefined as any);
    ParamCollisionJsonWhereEntity.setExecutor(undefined as any);
    ParamCollisionJsonSetEntity.setExecutor(undefined as any);
    ParamCollisionEnumSetEntity.setExecutor(undefined as any);
  });

  describe('comparison operators', () => {
    it('generates $gte, $gt, $lte, $lt, $ne', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({
        balance: { $gte: 100n },
        rating: { $gt: 1, $lt: 10 },
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('`balance` >= $w0');
      expect(q.sql).toContain('`rating` > $w1');
      expect(q.sql).toContain('`rating` < $w2');
      expect((q.params.w0 as any).value).toBe(100n);
      expect((q.params.w1 as any).value).toBe(1);
    });

    it('generates $ne', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ status: { $ne: 'banned' } });

      const [q] = mock.queries;
      expect(q.sql).toContain('`status` != $w0');
      expect((q.params.w0 as any).value).toBe('banned');
    });
  });

  describe('special operators', () => {
    it('generates $in with multiple values', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({
        status: { $in: ['active', 'pending'] },
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('`status` IN ($w0, $w1)');
      expect((q.params.w0 as any).value).toBe('active');
      expect((q.params.w1 as any).value).toBe('pending');
    });

    it('generates $between', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({
        rating: { $between: [3, 7] },
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('`rating` BETWEEN $w0 AND $w1');
      expect((q.params.w0 as any).value).toBe(3);
      expect((q.params.w1 as any).value).toBe(7);
    });

    it('generates $like', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ name: { $like: 'Ivan%' } });

      const [q] = mock.queries;
      expect(q.sql).toContain('`name` LIKE $w0');
      expect((q.params.w0 as any).value).toBe('Ivan%');
    });
  });

  describe('logical combinators', () => {
    it('generates (balance >= $ OR is_admin = $) AND is_banned = $', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({
        is_banned: false,
        $or: [{ balance: { $gte: 100n } }, { is_admin: true }],
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE `is_banned` = $w0 AND');
      expect(q.sql).toContain('(`balance` >= $w1 OR `is_admin` = $w2)');
    });

    it('supports nested $and / $or groups', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({
        $and: [
          { $or: [{ rating: { $gte: 5 } }, { is_admin: true }] },
          { $or: [{ is_banned: false }, { status: 'vip' }] },
        ],
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE (');
      expect(q.sql).toContain('(`rating` >= $w0 OR `is_admin` = $w1)');
      expect(q.sql).toContain('(`is_banned` = $w2 OR `status` = $w3)');
    });
  });

  describe('backward compatibility', () => {
    it('plain equality uses opaque collision-free param names', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ is_banned: false, status: 'active' });

      const [q] = mock.queries;
      expect(q.sql).toContain('`is_banned` = $w0');
      expect(q.sql).toContain('`status` = $w1');
      expect((q.params.w0 as any).value).toBe(false);
      expect((q.params.w1 as any).value).toBe('active');
    });

    it('null equality generates IS NULL', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ name: null });

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE `name` IS NULL');
      expect(Object.keys(q.params)).toHaveLength(0);
    });

    it('$ne null generates IS NOT NULL', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ name: { $ne: null } });

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE `name` IS NOT NULL');
      expect(Object.keys(q.params)).toHaveLength(0);
    });
  });

  describe('encrypted fields', () => {
    it('still searches encrypted field by blind index for equality', async () => {
      const provider = new TestOnlyEncryptionProvider();
      WhereOperatorEntity.setEncryptionProvider(provider);
      WhereOperatorEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ secret: 'abc' });

      const [q] = mock.queries;
      expect(q.sql).toContain('`secret_bi` = $w0');
      expect((q.params.w0 as any).value).toBe(
        Buffer.from('bi:abc', 'utf8').toString('base64'),
      );
    });

    it('throws on non-equality operator for encrypted field', async () => {
      const provider = new TestOnlyEncryptionProvider();
      WhereOperatorEntity.setEncryptionProvider(provider);
      WhereOperatorEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.find({ secret: { $like: 'abc%' } }),
      ).rejects.toThrow(/only equality is supported via blind index/);
      expect(mock.queries).toHaveLength(0);
    });

    it('throws when searching encrypted field without blind index', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.find({ unsearchable: 'x' }),
      ).rejects.toThrow(/blind index is disabled/);
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('throws on $like for non-string column', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.find({ balance: { $like: '100%' } }),
      ).rejects.toThrow(/requires a string column/);
      expect(mock.queries).toHaveLength(0);
    });

    it('throws on $jsonExists for non-JSON column', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.find({ name: { $jsonExists: '$.foo' } }),
      ).rejects.toThrow(/requires a JSON column/);
      expect(mock.queries).toHaveLength(0);
    });

    it('throws on empty $or / $and', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(WhereOperatorEntity.find({ $or: [] })).rejects.toThrow(
        /requires a non-empty array/,
      );
      await expect(WhereOperatorEntity.find({ $and: [] })).rejects.toThrow(
        /requires a non-empty array/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('throws on non-object items in $or', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.find({ $or: [null as any, 5 as any] }),
      ).rejects.toThrow(/expects objects/);
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('QueryBuilder', () => {
    it('orWhere combines with the accumulated predicate: A OR B OR C (#173)', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.query()
        .where({ is_banned: false })
        .orWhere({ is_admin: true })
        .orWhere({ balance: { $gte: 100n } })
        .getMany();

      const [q] = mock.queries;
      // Полный предикат: условия объединены через OR, на корне НЕ AND.
      expect(q.sql).toContain(
        'WHERE (`is_banned` = $w0 OR `is_admin` = $w1 ' +
          'OR `balance` >= $w2)',
      );
    });

    it('where(A).orWhere(B) evaluates as A OR B (#173)', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.query()
        .where({ is_banned: false })
        .orWhere({ is_admin: true })
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE (`is_banned` = $w0 OR `is_admin` = $w1)');
    });

    it('andWhere after orWhere links through AND: (A OR B) AND C (#173)', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.query()
        .where({ is_banned: false })
        .orWhere({ is_admin: true })
        .andWhere({ balance: { $gte: 100n } })
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE (`is_banned` = $w0 OR `is_admin` = $w1) ' +
          'AND `balance` >= $w2',
      );
    });

    it('where(A).orWhere(B).orWhere(C).andWhere(D) = (A OR B OR C) AND D (#173)', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.query()
        .where({ is_banned: false })
        .orWhere({ is_admin: true })
        .orWhere({ balance: { $gte: 100n } })
        .andWhere({ name: 'admin' })
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'WHERE (`is_banned` = $w0 OR `is_admin` = $w1 ' +
          'OR `balance` >= $w2) AND `name` = $w3',
      );
    });

    it('orWhere preserves existing $or object', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.query()
        .where({ $or: { status: 'vip' } as any })
        .orWhere({ is_admin: true })
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE (`status` = $w0 OR `is_admin` = $w1)');
    });
  });

  describe('collision-free parameter names (#238)', () => {
    it('a column named like a generated param cannot alias another predicate', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionEntity.setExecutor(mock.executor);

      await ParamCollisionEntity.find({
        name_0_eq: 'x',
        $or: [{ name: 'y' }],
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('`name_0_eq` = $w0');
      expect(q.sql).toContain('(`name` = $w1)');
      expect(Object.keys(q.params)).toHaveLength(2);
      expect((q.params.w0 as any).value).toBe('x');
      expect((q.params.w1 as any).value).toBe('y');
    });

    it('columns matching the param namespace bind their own values', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionEntity.setExecutor(mock.executor);

      await ParamCollisionEntity.find({ w0: 'a', w1: 'b' });

      const [q] = mock.queries;
      expect(q.sql).toContain('`w0` = $w0');
      expect(q.sql).toContain('`w1` = $w1');
      expect((q.params.w0 as any).value).toBe('a');
      expect((q.params.w1 as any).value).toBe('b');
    });

    it('a Utf8 enum column named w0 does not hijack the WHERE param', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionEnumUtf8Entity.setExecutor(mock.executor);

      await ParamCollisionEnumUtf8Entity.find({ title: 'zzz' });

      const [q] = mock.queries;
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect((q.params.w0 as any).value).toBe('zzz');
    });

    it('an Int32 enum column named w0 does not silently rebind the WHERE param', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionEnumInt32Entity.setExecutor(mock.executor);

      // 'active' входит в enum-значения: без фикса параметр стал бы Int32(0).
      await ParamCollisionEnumInt32Entity.find({ title: 'active' });

      const [q] = mock.queries;
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect((q.params.w0 as any).value).toBe('active');
    });

    it('a @YdbJson column named w0 does not JSON-mangle the WHERE param', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionJsonWhereEntity.setExecutor(mock.executor);

      await ParamCollisionJsonWhereEntity.find({ rating: 5 });

      const [q] = mock.queries;
      expect(q.params.w0).toBeInstanceOf(Int32);
      expect((q.params.w0 as any).value).toBe(5);
    });

    it('a @YdbJson column named s0 does not JSON-mangle the SET param', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionJsonSetEntity.setExecutor(mock.executor);

      await ParamCollisionJsonSetEntity.updateBy(
        { uuid: COLLISION_UUID },
        { rating: 7 },
      );

      const [q] = mock.queries;
      expect(q.params.w0).toBeInstanceOf(Uuid);
      expect(String(q.params.w0)).toBe(COLLISION_UUID);
      expect(q.params.s0).toBeInstanceOf(Int32);
      expect((q.params.s0 as any).value).toBe(7);
    });

    it('a Utf8 enum column named s0 does not hijack the SET param', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionEnumSetEntity.setExecutor(mock.executor);

      await ParamCollisionEnumSetEntity.updateBy(
        { uuid: COLLISION_UUID },
        { title: 'x' },
      );

      const [q] = mock.queries;
      expect(q.params.w0).toBeInstanceOf(Uuid);
      expect(q.params.s0).toBeInstanceOf(Utf8);
      expect((q.params.s0 as any).value).toBe('x');
    });

    it('$like on a Utf8-backed enum column binds the raw pattern', async () => {
      const mock = createMockExecutor([[]]);
      ParamCollisionEnumUtf8Entity.setExecutor(mock.executor);

      // w0 = @YdbEnum({ storage: 'Utf8' }): шаблон LIKE не должен проходить
      // enum-конверсию (иначе "act%" не входит в значения и бросается ошибка).
      await ParamCollisionEnumUtf8Entity.find({ w0: { $like: 'act%' } });

      const [q] = mock.queries;
      expect(q.params.w0).toBeInstanceOf(Utf8);
      expect((q.params.w0 as any).value).toBe('act%');
    });
  });
});
