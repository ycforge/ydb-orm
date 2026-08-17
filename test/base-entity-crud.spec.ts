import 'reflect-metadata';
import { Uuid } from '@ydbjs/value/primitive';
import { UserEntity } from './fixtures/user/user.entity.js';
import { UserRoleEntity } from './fixtures/user_role/user_role.entity.js';
import { PhotoEntity } from './fixtures/photo/photo.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Base64TestEncryptionProvider } from '../src/encryption/base64-test-encryption.provider.js';

const userRow = {
  uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
  email_encrypted: 'enc',
  full_name: 'Ivan',
};

describe('BaseEntity CRUD (mock executor)', () => {
  afterEach(() => {
    // Сброс executor/providers у всех тестовых сущностей
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined as any);
    UserEntity.setBlindIndexProvider(undefined as any);
    UserRoleEntity.setExecutor(undefined as any);
    UserRoleEntity.setEncryptionProvider(undefined as any);
    UserRoleEntity.setBlindIndexProvider(undefined as any);
    PhotoEntity.setExecutor(undefined as any);
    PhotoEntity.setEncryptionProvider(undefined as any);
    PhotoEntity.setBlindIndexProvider(undefined as any);
  });

  describe('find()', () => {
    it('returns an entity instance when row exists', async () => {
      const mock = createMockExecutor([[userRow]]);
      UserEntity.setExecutor(mock.executor);

      const user = await UserEntity.find({ uuid: userRow.uuid });

      expect(user).toBeInstanceOf(UserEntity);
      expect(user?.uuid).toBe(userRow.uuid);
      expect(user?.full_name).toBe('Ivan');

      const [q] = mock.queries;
      expect(q.sql).toContain('SELECT * FROM `users`');
      expect(q.sql).toContain('WHERE `uuid` = $uuid');
      expect(q.sql).toContain('LIMIT 1');
      expect(q.params.uuid).toBeInstanceOf(Uuid);
    });

    it('returns null when no row matches', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const user = await UserEntity.find({ uuid: userRow.uuid });
      expect(user).toBeNull();
    });

    it('throws when called without conditions', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await expect(UserEntity.find({})).rejects.toThrow(
        /requires at least one condition/,
      );
    });

    it('passes multiple WHERE conditions', async () => {
      const roleRow = {
        user_uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
        role_uuid: '00000000-0000-0000-0000-000000000002',
        organization_uuid: '00000000-0000-0000-0000-000000000003',
        is_global: true,
      };
      const mock = createMockExecutor([[roleRow]]);
      UserRoleEntity.setExecutor(mock.executor);

      await UserRoleEntity.find({
        user_uuid: roleRow.user_uuid,
        role_uuid: roleRow.role_uuid,
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('`user_uuid` = $user_uuid');
      expect(q.sql).toContain('`role_uuid` = $role_uuid');
      expect(q.sql).toContain('AND');
    });

    it('throws for unknown field in WHERE', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await expect(
        UserEntity.find({ uuid: userRow.uuid, no_such_field: 'x' }),
      ).rejects.toThrow(/Unknown field in WHERE/);
    });

    it('passes options to executor', async () => {
      const mock = createMockExecutor([[userRow]]);
      UserEntity.setExecutor(mock.executor);

      const signal = AbortSignal.timeout(5000);
      await UserEntity.find({ uuid: userRow.uuid }, { timeout: 100, signal });

      const [q] = mock.queries;
      expect(q.sql).toContain('SELECT *');
    });
  });

  describe('findAll()', () => {
    it('returns multiple entities', async () => {
      const mock = createMockExecutor([
        [
          userRow,
          {
            ...userRow,
            uuid: '00000000-0000-0000-0000-000000000002',
            full_name: 'Petr',
          },
        ],
      ]);
      UserEntity.setExecutor(mock.executor);

      const users = await UserEntity.findAll();
      expect(users).toHaveLength(2);
      expect(users[0]).toBeInstanceOf(UserEntity);
      expect(users[1]).toBeInstanceOf(UserEntity);
    });

    it('returns empty array when no rows', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const users = await UserEntity.findAll();
      expect(users).toEqual([]);
    });

    it('applies LIMIT and OFFSET', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.findAll({}, { limit: 50, offset: 20 });

      const [q] = mock.queries;
      expect(q.sql).toContain('LIMIT 50');
      expect(q.sql).toContain('OFFSET 20');
    });

    it('clamps limit to 1-1000 range', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.findAll({}, { limit: 9999 });
      expect(mock.queries[0].sql).toContain('LIMIT 1000');

      await UserEntity.findAll({}, { limit: -1 });
      expect(mock.queries[1].sql).toContain('LIMIT 1');
    });

    it('uses default limit 100 and offset 0', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.findAll();
      const [q] = mock.queries;
      expect(q.sql).toContain('LIMIT 100');
      expect(q.sql).toContain('OFFSET 0');
    });

    it('applies WHERE conditions', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.findAll({ uuid: userRow.uuid });

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE `uuid` = $uuid');
    });
  });

  describe('count()', () => {
    it('returns count from result', async () => {
      const mock = createMockExecutor([[{ cnt: 42 }]]);
      UserEntity.setExecutor(mock.executor);

      const count = await UserEntity.count();
      expect(count).toBe(42);

      const [q] = mock.queries;
      expect(q.sql).toContain('SELECT COUNT(*) AS cnt');
    });

    it('returns 0 when cnt is missing', async () => {
      const mock = createMockExecutor([[{}]]);
      UserEntity.setExecutor(mock.executor);

      const count = await UserEntity.count();
      expect(count).toBe(0);
    });

    it('passes WHERE conditions', async () => {
      const mock = createMockExecutor([[{ cnt: 5 }]]);
      UserEntity.setExecutor(mock.executor);

      const count = await UserEntity.count({ uuid: userRow.uuid });
      expect(count).toBe(5);

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE `uuid` = $uuid');
    });
  });

  describe('save() — insert', () => {
    it('generates uuid and runs UPSERT when entity has no uuid', async () => {
      const provider = new Base64TestEncryptionProvider();
      UserEntity.setEncryptionProvider(provider);
      UserEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const user = new UserEntity();
      user.email_encrypted = 'test@test.com';
      user.full_name = 'New User';

      const saved = await UserEntity.save(user);

      expect(saved).toBe(user);
      expect(saved.uuid).toBeDefined();
      expect(typeof saved.uuid).toBe('string');
      expect(saved.uuid.length).toBe(36);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `users`');
      expect(q.sql).toContain('`uuid`');
      expect(q.sql).toContain('`email_encrypted`');
      expect(q.sql).toContain('`full_name`');
    });

    it('skips undefined fields in UPSERT', async () => {
      const provider = new Base64TestEncryptionProvider();
      UserEntity.setEncryptionProvider(provider);
      UserEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const user = new UserEntity();
      user.full_name = 'Only Name';

      await UserEntity.save(user);

      const [q] = mock.queries;
      expect(q.sql).not.toContain('`email_encrypted`');
    });
  });

  describe('save() — update', () => {
    it('runs UPDATE RETURNING * when entity has uuid', async () => {
      const provider = new Base64TestEncryptionProvider();
      UserEntity.setEncryptionProvider(provider);
      UserEntity.setBlindIndexProvider(provider);
      const updatedRow = {
        ...userRow,
        email_encrypted: Buffer.from('enc').toString('base64'),
        full_name: Buffer.from('Updated').toString('base64'),
      };
      const mock = createMockExecutor([[updatedRow]]);
      UserEntity.setExecutor(mock.executor);

      const user = new UserEntity();
      user.uuid = userRow.uuid;
      user.full_name = 'Updated';

      const saved = await UserEntity.save(user);

      expect(saved.full_name).toBe('Updated');

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `users`');
      expect(q.sql).toContain('SET');
      expect(q.sql).toContain('WHERE `uuid` = $uuid');
      expect(q.sql).toContain('RETURNING *');
    });

    it('throws when updating non-existent entity', async () => {
      const provider = new Base64TestEncryptionProvider();
      UserEntity.setEncryptionProvider(provider);
      UserEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const user = new UserEntity();
      user.uuid = userRow.uuid;
      user.full_name = 'Ghost';

      await expect(UserEntity.save(user)).rejects.toThrow(
        /not found — nothing to update/,
      );
    });

    it('excludes uuid from SET clause', async () => {
      const provider = new Base64TestEncryptionProvider();
      UserEntity.setEncryptionProvider(provider);
      UserEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[userRow]]);
      UserEntity.setExecutor(mock.executor);

      const user = new UserEntity();
      user.uuid = userRow.uuid;
      user.full_name = 'Test';

      await UserEntity.save(user);

      const [q] = mock.queries;
      const setClause = q.sql.split('SET')[1]?.split('WHERE')[0] ?? '';
      expect(setClause).not.toContain('`uuid` =');
    });
  });

  describe('delete()', () => {
    it('returns deleted entity when it exists', async () => {
      const mock = createMockExecutor([[userRow]]);
      UserEntity.setExecutor(mock.executor);

      const deleted = await UserEntity.delete(userRow.uuid);

      expect(deleted).toBeInstanceOf(UserEntity);
      expect(deleted?.uuid).toBe(userRow.uuid);

      const [q] = mock.queries;
      expect(q.sql).toContain('DELETE FROM `users`');
      expect(q.sql).toContain('WHERE `uuid` = $pk');
      expect(q.sql).toContain('RETURNING *');
    });

    it('returns null when no entity matches', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const deleted = await UserEntity.delete(userRow.uuid);
      expect(deleted).toBeNull();
    });
  });

  describe('insertMany()', () => {
    it('batches entities and runs UPSERT', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      const roles = Array.from({ length: 3 }, () => new UserRoleEntity());
      await UserRoleEntity.insertMany(roles);

      const [q] = mock.queries;
      expect(q.sql).toContain('UPSERT INTO `user_roles`');
      expect(q.sql).toContain('`user_uuid`');
      expect(q.sql).toContain('`role_uuid`');
      expect(q.sql).toContain('`organization_uuid`');
      expect(q.sql).toContain('`is_global`');
    });

    it('returns empty array for empty input', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const result = await UserEntity.insertMany([]);
      expect(result).toEqual([]);
      expect(mock.queries).toHaveLength(0);
    });

    it('splits into batches of 100', async () => {
      const provider = new Base64TestEncryptionProvider();
      PhotoEntity.setEncryptionProvider(provider);
      PhotoEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      PhotoEntity.setExecutor(mock.executor);

      const photos = Array.from({ length: 150 }, () => {
        const p = new PhotoEntity();
        p.title = 'test';
        return p;
      });
      await PhotoEntity.insertMany(photos);

      expect(mock.queries).toHaveLength(2);
      expect(mock.queries[0].sql).toContain('UPSERT INTO `photos`');
      expect(mock.queries[1].sql).toContain('UPSERT INTO `photos`');
    });
  });

  describe('executor not set', () => {
    it('throws when executor is not configured', async () => {
      // PhotoEntity has no executor set
      await expect(PhotoEntity.findAll()).rejects.toThrow(
        /YDB executor not set/,
      );
    });
  });

  describe('encrypt / decrypt pipeline', () => {
    it('encrypts on save and decrypts on find', async () => {
      const provider = new Base64TestEncryptionProvider();
      UserEntity.setEncryptionProvider(provider);
      UserEntity.setBlindIndexProvider(provider);

      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      // Save: should encrypt email_encrypted
      const user = new UserEntity();
      user.email_encrypted = 'plain@example.com';
      user.full_name = 'Enc Test';
      await UserEntity.save(user);

      const saveQ = mock.queries[0];
      const emailParam = saveQ.params.email_encrypted;
      // Should be base64-encoded
      expect(String((emailParam as any).value)).toBe(
        Buffer.from('plain@example.com').toString('base64'),
      );

      // Find: should decrypt
      const encryptedEmail =
        Buffer.from('plain@example.com').toString('base64');
      const mock2 = createMockExecutor([
        [{ ...userRow, email_encrypted: encryptedEmail }],
      ]);
      UserEntity.setExecutor(mock2.executor);

      const found = await UserEntity.find({ uuid: userRow.uuid });
      expect(found?.email_encrypted).toBe('plain@example.com');
    });
  });
});
