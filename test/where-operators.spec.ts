import 'reflect-metadata';
import { WhereOperatorEntity } from './fixtures/where_operator/where-operator.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Base64TestEncryptionProvider } from '../src/encryption/base64-test-encryption.provider.js';

describe('WHERE operators', () => {
  afterEach(() => {
    WhereOperatorEntity.setExecutor(undefined as any);
    WhereOperatorEntity.setEncryptionProvider(undefined as any);
    WhereOperatorEntity.setBlindIndexProvider(undefined as any);
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
      expect(q.sql).toContain('`balance` >= $balance_0_gte');
      expect(q.sql).toContain('`rating` > $rating_1_gt');
      expect(q.sql).toContain('`rating` < $rating_2_lt');
      expect((q.params.balance_0_gte as any).value).toBe(100n);
      expect((q.params.rating_1_gt as any).value).toBe(1);
    });

    it('generates $ne', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ status: { $ne: 'banned' } });

      const [q] = mock.queries;
      expect(q.sql).toContain('`status` != $status_0_ne');
      expect((q.params.status_0_ne as any).value).toBe('banned');
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
      expect(q.sql).toContain('`status` IN ($status_0_in_0, $status_0_in_1)');
      expect((q.params.status_0_in_0 as any).value).toBe('active');
      expect((q.params.status_0_in_1 as any).value).toBe('pending');
    });

    it('generates $between', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({
        rating: { $between: [3, 7] },
      });

      const [q] = mock.queries;
      expect(q.sql).toContain(
        '`rating` BETWEEN $rating_0_between_lo AND $rating_0_between_hi',
      );
      expect((q.params.rating_0_between_lo as any).value).toBe(3);
      expect((q.params.rating_0_between_hi as any).value).toBe(7);
    });

    it('generates $like', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ name: { $like: 'Ivan%' } });

      const [q] = mock.queries;
      expect(q.sql).toContain('`name` LIKE $name_0_like');
      expect((q.params.name_0_like as any).value).toBe('Ivan%');
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
      expect(q.sql).toContain('WHERE `is_banned` = $is_banned AND');
      expect(q.sql).toContain(
        '(`balance` >= $balance_0_gte OR `is_admin` = $is_admin_1_eq)',
      );
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
      expect(q.sql).toContain(
        '(`rating` >= $rating_0_gte OR `is_admin` = $is_admin_1_eq)',
      );
      expect(q.sql).toContain(
        '(`is_banned` = $is_banned_2_eq OR `status` = $status_3_eq)',
      );
    });
  });

  describe('backward compatibility', () => {
    it('plain equality still uses field name as param name', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ is_banned: false, status: 'active' });

      const [q] = mock.queries;
      expect(q.sql).toContain('`is_banned` = $is_banned');
      expect(q.sql).toContain('`status` = $status');
      expect((q.params.is_banned as any).value).toBe(false);
      expect((q.params.status as any).value).toBe('active');
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
      const provider = new Base64TestEncryptionProvider();
      WhereOperatorEntity.setEncryptionProvider(provider);
      WhereOperatorEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.find({ secret: 'abc' });

      const [q] = mock.queries;
      expect(q.sql).toContain('`secret_bi` = $secret_bi');
      expect((q.params.secret_bi as any).value).toBe(
        Buffer.from('bi:abc', 'utf8').toString('base64'),
      );
    });

    it('throws on non-equality operator for encrypted field', async () => {
      const provider = new Base64TestEncryptionProvider();
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

  describe('QueryBuilder', () => {
    it('supports orWhere()', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.query()
        .where({ is_banned: false })
        .orWhere({ is_admin: true })
        .orWhere({ balance: { $gte: 100n } })
        .getMany();

      const [q] = mock.queries;
      expect(q.sql).toContain('`is_banned` = $is_banned');
      expect(q.sql).toContain(
        '(`is_admin` = $is_admin_0_eq OR `balance` >= $balance_1_gte)',
      );
    });
  });
});
