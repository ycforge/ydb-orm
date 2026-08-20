import 'reflect-metadata';
import { UserEntity } from './fixtures/user/user.entity.js';
import { UserRoleEntity } from './fixtures/user_role/user_role.entity.js';
import { TimestampEntity } from './fixtures/timestamp/timestamp.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { Base64TestEncryptionProvider } from '../src/encryption/base64-test-encryption.provider.js';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbEncrypted,
  YdbSecurityAAD,
  YdbBaseEntity,
} from '../src/index.js';

/** Сущность с AAD-полем для проверки запрета updateBy по шифрованным полям. */
@YdbEntity('aad_test')
class AadEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbEncrypted()
  @YdbColumn('Utf8')
  secret?: string;
}

const userRow = {
  uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
  email_encrypted: 'enc',
  full_name: 'Ivan',
};

describe('updateBy() / deleteBy()', () => {
  afterEach(() => {
    UserEntity.setExecutor(undefined as any);
    UserEntity.setEncryptionProvider(undefined as any);
    UserEntity.setBlindIndexProvider(undefined as any);
    UserRoleEntity.setExecutor(undefined as any);
    UserRoleEntity.setEncryptionProvider(undefined as any);
    UserRoleEntity.setBlindIndexProvider(undefined as any);
    TimestampEntity.setExecutor(undefined as any);
    TimestampEntity.setEncryptionProvider(undefined as any);
    TimestampEntity.setBlindIndexProvider(undefined as any);
    AadEntity.setExecutor(undefined as any);
    AadEntity.setEncryptionProvider(undefined as any);
    AadEntity.setBlindIndexProvider(undefined as any);
  });

  describe('updateBy()', () => {
    it('generates correct SQL with WHERE and SET clauses', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      const affected = await UserRoleEntity.updateBy(
        { user_uuid: userRow.uuid },
        { is_global: true },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `user_roles`');
      expect(q.sql).toContain('SET');
      expect(q.sql).toContain('`is_global` = $is_global');
      expect(q.sql).toContain('WHERE `user_uuid` = $user_uuid');
      expect(q.params.is_global).toEqual({
        type: expect.anything(),
        value: true,
      });
      expect(affected).toBe(0);
    });

    it('returns affected row count', async () => {
      const row = {
        user_uuid: userRow.uuid,
        role_uuid: '00000000-0000-0000-0000-000000000002',
        organization_uuid: '00000000-0000-0000-0000-000000000003',
        is_global: true,
      };
      const mock = createMockExecutor([[row]]);
      UserRoleEntity.setExecutor(mock.executor);

      const affected = await UserRoleEntity.updateBy(
        { user_uuid: userRow.uuid },
        { is_global: false },
      );

      expect(affected).toBe(1);
    });

    it('throws with empty where', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.updateBy({}, { is_global: true }),
      ).rejects.toThrow(/requires at least one WHERE condition/);
    });

    it('throws with empty patch', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.updateBy({ user_uuid: userRow.uuid }, {}),
      ).rejects.toThrow(/requires at least one field in patch/);
    });

    it('auto-sets update date column when configured', async () => {
      const mock = createMockExecutor([[]]);
      TimestampEntity.setExecutor(mock.executor);

      await TimestampEntity.updateBy(
        { uuid: userRow.uuid },
        { name: 'Updated' },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `timestamp_test`');
      expect(q.sql).toContain('`updated_at` = $updated_at');
      expect(q.params.updated_at).toBeDefined();
    });

    it('throws for unknown field in patch', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.updateBy(
          { user_uuid: userRow.uuid },
          { no_such_field: 'x' },
        ),
      ).rejects.toThrow(/Unknown field in patch/);
    });

    it('passes multiple SET fields', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await UserRoleEntity.updateBy(
        { user_uuid: userRow.uuid },
        { role_uuid: '00000000-0000-0000-0000-000000000099', is_global: false },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('`role_uuid` = $role_uuid');
      expect(q.sql).toContain('`is_global` = $is_global');
    });

    it('works with encryption provider', async () => {
      const provider = new Base64TestEncryptionProvider();
      UserEntity.setEncryptionProvider(provider);
      UserEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await UserEntity.updateBy(
        { uuid: userRow.uuid },
        { email_encrypted: 'secret@example.com' },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `users`');
      expect(q.sql).toContain('`email_encrypted` = $email_encrypted');
      const emailParam = q.params.email_encrypted;
      expect((emailParam as any).value).toEqual(
        new TextEncoder().encode('secret@example.com'),
      );
    });

    it('adds RETURNING with primary key column', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await UserRoleEntity.updateBy(
        { user_uuid: userRow.uuid },
        { is_global: true },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('RETURNING `user_uuid`');
    });

    it('throws when the same field is in where and patch', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.updateBy(
          { user_uuid: userRow.uuid },
          { user_uuid: userRow.uuid, is_global: true },
        ),
      ).rejects.toThrow(/present in both where and patch/);
      expect(mock.queries).toHaveLength(0);
    });

    it('throws on encrypted field update when entity has AAD fields', async () => {
      const provider = new Base64TestEncryptionProvider();
      AadEntity.setEncryptionProvider(provider);
      const mock = createMockExecutor([[]]);
      AadEntity.setExecutor(mock.executor);

      await expect(
        AadEntity.updateBy({ tenant_id: 't1' }, { secret: 'new-secret' }),
      ).rejects.toThrow(/cannot update encrypted field "secret"/);
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('deleteBy()', () => {
    it('generates correct SQL', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      const affected = await UserRoleEntity.deleteBy({
        user_uuid: userRow.uuid,
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('DELETE FROM `user_roles`');
      expect(q.sql).toContain('WHERE `user_uuid` = $user_uuid');
      expect(q.sql).toContain('RETURNING `user_uuid`');
      expect(q.params.user_uuid).toBeDefined();
      expect(affected).toBe(0);
    });

    it('returns affected row count', async () => {
      const row = {
        user_uuid: userRow.uuid,
        role_uuid: '00000000-0000-0000-0000-000000000002',
        organization_uuid: '00000000-0000-0000-0000-000000000003',
        is_global: true,
      };
      const mock = createMockExecutor([[row]]);
      UserRoleEntity.setExecutor(mock.executor);

      const affected = await UserRoleEntity.deleteBy({
        user_uuid: userRow.uuid,
      });

      expect(affected).toBe(1);
    });

    it('throws with empty where', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(UserRoleEntity.deleteBy({})).rejects.toThrow(
        /requires at least one WHERE condition/,
      );
    });

    it('passes multiple WHERE conditions', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await UserRoleEntity.deleteBy({
        user_uuid: userRow.uuid,
        role_uuid: '00000000-0000-0000-0000-000000000002',
      });

      const [q] = mock.queries;
      expect(q.sql).toContain('DELETE FROM `user_roles`');
      expect(q.sql).toContain('`user_uuid` = $user_uuid');
      expect(q.sql).toContain('`role_uuid` = $role_uuid');
      expect(q.sql).toContain('AND');
    });
  });
});
