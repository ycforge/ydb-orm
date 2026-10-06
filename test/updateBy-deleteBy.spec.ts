import 'reflect-metadata';
import { UserEntity } from './fixtures/user/user.entity.js';
import { UserRoleEntity } from './fixtures/user_role/user_role.entity.js';
import { TimestampEntity } from './fixtures/timestamp/timestamp.entity.js';
import { WhereOperatorEntity } from './fixtures/where_operator/where-operator.entity.js';
import { MembershipEntity } from './fixtures/membership/membership.entity.js';
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
    UserEntity.setEncryptionProvider(undefined);
    UserEntity.setBlindIndexProvider(undefined);
    UserRoleEntity.setExecutor(undefined as any);
    UserRoleEntity.setEncryptionProvider(undefined);
    UserRoleEntity.setBlindIndexProvider(undefined);
    TimestampEntity.setExecutor(undefined as any);
    TimestampEntity.setEncryptionProvider(undefined);
    TimestampEntity.setBlindIndexProvider(undefined);
    AadEntity.setExecutor(undefined as any);
    AadEntity.setEncryptionProvider(undefined);
    AadEntity.setBlindIndexProvider(undefined);
    AadMultiEntity.setExecutor(undefined as any);
    AadMultiEntity.setEncryptionProvider(undefined);
    AadMultiEntity.setBlindIndexProvider(undefined);
    AadCompositeEntity.setExecutor(undefined as any);
    AadCompositeEntity.setEncryptionProvider(undefined);
    AadCompositeEntity.setBlindIndexProvider(undefined);
    WhereOperatorEntity.setExecutor(undefined as any);
    WhereOperatorEntity.setEncryptionProvider(undefined);
    WhereOperatorEntity.setBlindIndexProvider(undefined);
    MembershipEntity.setExecutor(undefined as any);
    MembershipEntity.setEncryptionProvider(undefined);
    MembershipEntity.setBlindIndexProvider(undefined);
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
      expect(q.sql).toContain('`is_global` = $s0');
      expect(q.sql).toContain('WHERE `user_uuid` = $w0');
      expect(q.params.s0).toEqual({
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
      expect(q.sql).toContain('`updated_at` = $s1');
      expect(q.params.s1).toBeDefined();
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
      expect(q.sql).toContain('`role_uuid` = $s0');
      expect(q.sql).toContain('`is_global` = $s1');
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
      expect(q.sql).toContain('`email_encrypted` = $s0');
      const emailParam = q.params.s0;
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

    it('allows the same field in where and patch with distinct param names (#238)', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      const affected = await UserRoleEntity.updateBy(
        { is_global: true },
        { is_global: false },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('SET `is_global` = $s0');
      expect(q.sql).toContain('WHERE `is_global` = $w0');
      expect((q.params.w0 as any).value).toBe(true);
      expect((q.params.s0 as any).value).toBe(false);
      expect(affected).toBe(0);
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
      expect(q.sql).toContain('`secret` = $s0');

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
      expect(q.sql).toContain('`secret` = $s0');
      expect(Object.keys(q.params)).toContain('s0');
      expect(Object.keys(q.params)).toContain('w0');
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
      expect(q.sql).toContain('WHERE `user_uuid` = $w0');
      expect(q.sql).toContain('RETURNING `user_uuid`');
      expect(q.params.w0).toBeDefined();
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
      expect(q.sql).toContain('`user_uuid` = $w0');
      expect(q.sql).toContain('`role_uuid` = $w1');
      expect(q.sql).toContain('AND');
    });
  });

  describe('parameterless predicates (#237)', () => {
    it('updateBy() accepts { field: null } and emits IS NULL', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.updateBy({ name: null }, { status: 'active' });

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `where_operator_test`');
      expect(q.sql).toContain('WHERE `name` IS NULL');
      expect(q.sql).toContain('SET `status` = $s0');
      expect((q.params.s0 as any).value).toBe('active');
      expect(q.params.w0).toBeUndefined();
    });

    it('deleteBy() accepts { field: { $ne: null } } and emits IS NOT NULL', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.deleteBy({ name: { $ne: null } });

      const [q] = mock.queries;
      expect(q.sql).toContain('DELETE FROM `where_operator_test`');
      expect(q.sql).toContain('WHERE `name` IS NOT NULL');
      expect(Object.keys(q.params)).toHaveLength(0);
    });

    it('accepts nested parameterless logical predicates', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await WhereOperatorEntity.updateBy(
        { $or: [{ name: null }, { status: null }] },
        { rating: 1 },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain('WHERE (`name` IS NULL OR `status` IS NULL)');
      expect((q.params.s0 as any).value).toBe(1);
    });

    it('deleteBy() rejects a predicate of only undefined before execution', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.deleteBy({ name: undefined }),
      ).rejects.toThrow(/no effective WHERE condition.*full-table delete/);
      expect(mock.queries).toHaveLength(0);
    });

    it('updateBy() rejects an empty object before execution', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.updateBy({}, { rating: 1 }),
      ).rejects.toThrow(/requires at least one WHERE condition/);
      expect(mock.queries).toHaveLength(0);
    });

    it('updateBy() rejects a nested predicate resolving to nothing', async () => {
      const mock = createMockExecutor([[]]);
      WhereOperatorEntity.setExecutor(mock.executor);

      await expect(
        WhereOperatorEntity.updateBy(
          { $or: [{ name: undefined }] },
          { rating: 1 },
        ),
      ).rejects.toThrow(/no effective WHERE condition.*full-table update/);
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('empty relation filters are not effective (#237)', () => {
    it('deleteBy() rejects many-to-one { parent: {} } before execution', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await expect(MembershipEntity.deleteBy({ user: {} })).rejects.toThrow(
        /no effective WHERE condition.*full-table delete/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('updateBy() rejects many-to-one { parent: {} } before execution', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await expect(
        MembershipEntity.updateBy({ user: {} }, { role: 'admin' }),
      ).rejects.toThrow(/no effective WHERE condition.*full-table update/);
      expect(mock.queries).toHaveLength(0);
    });

    it('deleteBy() rejects { parent: { uuid: undefined } } before execution', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await expect(
        MembershipEntity.deleteBy({ user: { uuid: undefined } }),
      ).rejects.toThrow(/no effective WHERE condition.*full-table delete/);
      expect(mock.queries).toHaveLength(0);
    });

    it('deleteBy() rejects { $or: [{ parent: {} }] } before execution', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await expect(
        MembershipEntity.deleteBy({ $or: [{ user: {} }] }),
      ).rejects.toThrow(/no effective WHERE condition.*full-table delete/);
      expect(mock.queries).toHaveLength(0);
    });

    it('deleteBy() rejects one-to-many { children: {} } before execution', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      await expect(UserEntity.deleteBy({ userRoles: {} })).rejects.toThrow(
        /no effective WHERE condition.*full-table delete/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('still accepts a related filter with an effective inner predicate', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await MembershipEntity.deleteBy({ user: { uuid: userRow.uuid } });

      const [q] = mock.queries;
      expect(q.sql).toContain('DELETE FROM `memberships`');
      expect(q.sql).toContain('`user_uuid` IN (SELECT `uuid` FROM `users`');
      expect(q.sql).toContain('WHERE `uuid` = $w0');
    });

    it('keeps the read path findAll({ relation: {} }) working', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await MembershipEntity.findAll({ user: {} });

      const [q] = mock.queries;
      expect(q.sql).toContain('FROM `memberships`');
      expect(q.sql).toContain('`user_uuid` IN (SELECT `uuid` FROM `users`)');
    });
  });
});
