import 'reflect-metadata';
import { UserEntity } from './fixtures/user/user.entity.js';
import { UserRoleEntity } from './fixtures/user_role/user_role.entity.js';
import { TimestampEntity } from './fixtures/timestamp/timestamp.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbEncrypted,
  YdbSecurityAAD,
  YdbBaseEntity,
} from '../src/index.js';
import type { YdbEncryptionContext } from '../src/index.js';

/** Сущность с одним AAD-полем (PK). */
@YdbEntity('aad_test')
class AadEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  declare uuid: string;

  @YdbEncrypted()
  @YdbColumn('Utf8')
  secret?: string;
}

/** Сущность с несколькими AAD-полями (оба PK). */
@YdbEntity('aad_multi_test')
class AadMultiEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  declare tenant_id: string;

  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  declare user_id: string;

  @YdbEncrypted()
  @YdbColumn('Utf8')
  secret?: string;
}

/** Сущность со составным PK, где AAD только на части PK-колонок. */
@YdbEntity('aad_composite_test')
class AadCompositeEntity extends YdbBaseEntity {
  @YdbSecurityAAD()
  @YdbPrimaryColumn('Uuid')
  declare user_uuid: string;

  @YdbPrimaryColumn('Uuid')
  declare role_uuid: string;

  @YdbEncrypted()
  @YdbColumn('Utf8')
  secret?: string;
}

/** Провайдер, записывающий контекст encrypt для проверки AAD. */
class RecordingEncryptionProvider extends TestOnlyEncryptionProvider {
  encryptContexts: YdbEncryptionContext[] = [];

  override async encrypt(
    plaintext: string,
    aad: string,
    context: YdbEncryptionContext,
  ): Promise<Uint8Array> {
    this.encryptContexts.push(context);
    return super.encrypt(plaintext, aad, context);
  }
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
    AadMultiEntity.setExecutor(undefined as any);
    AadMultiEntity.setEncryptionProvider(undefined as any);
    AadMultiEntity.setBlindIndexProvider(undefined as any);
    AadCompositeEntity.setExecutor(undefined as any);
    AadCompositeEntity.setEncryptionProvider(undefined as any);
    AadCompositeEntity.setBlindIndexProvider(undefined as any);
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
      const provider = new TestOnlyEncryptionProvider();
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

    it('updates encrypted field when AAD field is fixed in where', async () => {
      const provider = new RecordingEncryptionProvider();
      AadEntity.setEncryptionProvider(provider);
      AadEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadEntity.setExecutor(mock.executor);

      await AadEntity.updateBy(
        { uuid: userRow.uuid },
        { secret: 'new-secret' },
      );

      expect(mock.queries).toHaveLength(1);
      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `aad_test`');
      expect(q.sql).toContain('`secret` = $secret');

      expect(provider.encryptContexts).toHaveLength(1);
      expect(provider.encryptContexts[0].aadFields).toEqual({
        uuid: userRow.uuid,
      });
      expect(provider.encryptContexts[0].primaryKeyValue).toBe(userRow.uuid);
    });

    it('updates encrypted field with multiple AAD fields in where', async () => {
      const provider = new RecordingEncryptionProvider();
      AadMultiEntity.setEncryptionProvider(provider);
      AadMultiEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadMultiEntity.setExecutor(mock.executor);

      await AadMultiEntity.updateBy(
        {
          tenant_id: '00000000-0000-0000-0000-000000000001',
          user_id: '00000000-0000-0000-0000-000000000002',
        },
        { secret: 'new-secret' },
      );

      expect(provider.encryptContexts[0].aadFields).toEqual({
        tenant_id: '00000000-0000-0000-0000-000000000001',
        user_id: '00000000-0000-0000-0000-000000000002',
      });
    });

    it('partial update of only encrypted field with AAD works', async () => {
      const provider = new RecordingEncryptionProvider();
      AadEntity.setEncryptionProvider(provider);
      AadEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadEntity.setExecutor(mock.executor);

      await AadEntity.updateBy(
        { uuid: userRow.uuid },
        { secret: 'only-secret' },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('`secret` = $secret');
      expect(Object.keys(q.params)).toContain('secret');
      expect(Object.keys(q.params)).toContain('uuid');
      expect(provider.encryptContexts[0].aadFields).toEqual({
        uuid: userRow.uuid,
      });
    });

    it('throws on encrypted field update when AAD field is not fixed by where', async () => {
      const provider = new RecordingEncryptionProvider();
      AadEntity.setEncryptionProvider(provider);
      AadEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadEntity.setExecutor(mock.executor);

      await expect(
        AadEntity.updateBy({ unknown_field: 't1' }, { secret: 'new-secret' }),
      ).rejects.toThrow(
        /AAD field\(s\) "uuid" are not fixed by the where predicate/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('throws when AAD field is undefined in where', async () => {
      const provider = new RecordingEncryptionProvider();
      AadMultiEntity.setEncryptionProvider(provider);
      AadMultiEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadMultiEntity.setExecutor(mock.executor);

      await expect(
        AadMultiEntity.updateBy(
          { tenant_id: 't1', user_id: undefined },
          { secret: 'new-secret' },
        ),
      ).rejects.toThrow(
        /AAD field\(s\) "user_id" are not fixed by the where predicate/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('works with composite PK when AAD field is in where', async () => {
      const provider = new RecordingEncryptionProvider();
      AadCompositeEntity.setEncryptionProvider(provider);
      AadCompositeEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadCompositeEntity.setExecutor(mock.executor);

      await AadCompositeEntity.updateBy(
        {
          user_uuid: userRow.uuid,
          role_uuid: '00000000-0000-0000-0000-000000000002',
        },
        { secret: 'new-secret' },
      );

      expect(provider.encryptContexts[0].aadFields).toEqual({
        user_uuid: userRow.uuid,
      });
      expect(provider.encryptContexts[0].primaryKeyValue).toBe(
        `${userRow.uuid}:00000000-0000-0000-0000-000000000002`,
      );
    });

    it('fails with composite PK when AAD field is missing from where', async () => {
      const provider = new RecordingEncryptionProvider();
      AadCompositeEntity.setEncryptionProvider(provider);
      AadCompositeEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      AadCompositeEntity.setExecutor(mock.executor);

      await expect(
        AadCompositeEntity.updateBy(
          { role_uuid: 'r1' },
          { secret: 'new-secret' },
        ),
      ).rejects.toThrow(
        /AAD field\(s\) "user_uuid" are not fixed by the where predicate/,
      );
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
