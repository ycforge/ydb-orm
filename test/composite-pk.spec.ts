import 'reflect-metadata';
import { UserEntity } from './fixtures/user/user.entity.js';
import { UserRoleEntity } from './fixtures/user_role/user_role.entity.js';
import { PhotoEntity } from './fixtures/photo/photo.entity.js';
import { MembershipEntity } from './fixtures/membership/membership.entity.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';

const userRow = {
  uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
  email_encrypted: 'enc',
  full_name: 'Ivan',
};

const roleRow = {
  user_uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
  role_uuid: '00000000-0000-0000-0000-000000000002',
  organization_uuid: '00000000-0000-0000-0000-000000000003',
  is_global: true,
};

const membershipRow = {
  tenant_id: 'tenant-1',
  user_uuid: userRow.uuid,
  role: 'admin',
};

function makeRole(overrides: Partial<UserRoleEntity> = {}) {
  const r = new UserRoleEntity();
  r.user_uuid = roleRow.user_uuid;
  r.role_uuid = roleRow.role_uuid;
  r.organization_uuid = roleRow.organization_uuid;
  Object.assign(r, overrides);
  return r;
}

function makeMembership(overrides: Partial<MembershipEntity> = {}) {
  const m = new MembershipEntity();
  m.tenant_id = membershipRow.tenant_id;
  m.user_uuid = membershipRow.user_uuid;
  Object.assign(m, overrides);
  return m;
}

describe('Composite PK CRUD', () => {
  afterEach(() => {
    for (const e of [
      UserEntity,
      UserRoleEntity,
      PhotoEntity,
      MembershipEntity,
    ]) {
      e.setExecutor(undefined as any);
      e.setEncryptionProvider(undefined);
      e.setBlindIndexProvider(undefined);
    }
  });

  describe('save() — update по составному PK', () => {
    it('builds UPDATE with all PK components in WHERE and RETURNING *', async () => {
      const mock = createMockExecutor([[roleRow]]);
      UserRoleEntity.setExecutor(mock.executor);

      const saved = await UserRoleEntity.save(makeRole({ is_global: false }));

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `user_roles`');
      expect(q.sql).toContain('`user_uuid` = $user_uuid');
      expect(q.sql).toContain('`role_uuid` = $role_uuid');
      expect(q.sql).toContain('`organization_uuid` = $organization_uuid');
      expect(q.sql).toContain('RETURNING *');
      const setClause = q.sql.split('SET')[1]?.split('WHERE')[0] ?? '';
      expect(setClause).toContain('`is_global` = $is_global');
      expect(setClause).not.toContain('`user_uuid` =');
      expect(saved.is_global).toBe(true);
    });

    it('works with composite PK of mixed types (Utf8 + Uuid)', async () => {
      const mock = createMockExecutor([[membershipRow]]);
      MembershipEntity.setExecutor(mock.executor);

      await MembershipEntity.save(makeMembership({ role: 'viewer' }));

      const [q] = mock.queries;
      expect(q.sql).toContain('UPDATE `memberships`');
      expect(q.sql).toContain('`tenant_id` = $tenant_id');
      expect(q.sql).toContain('`user_uuid` = $user_uuid');
    });

    it('throws a clear error when a PK component is missing', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      const role = new UserRoleEntity();
      role.user_uuid = roleRow.user_uuid;

      await expect(UserRoleEntity.save(role)).rejects.toThrow(
        /primary key field\(s\) "role_uuid", "organization_uuid" must be set/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('reports all PK components when entity is not found', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await expect(
        MembershipEntity.save(makeMembership({ role: 'ghost' })),
      ).rejects.toThrow(/not found — nothing to update/);
    });
  });

  describe('update() без полей для обновления (#58)', () => {
    it('throws for single-PK entity with only uuid set', async () => {
      const mock = createMockExecutor([[]]);
      UserEntity.setExecutor(mock.executor);

      const user = new UserEntity();
      user.uuid = userRow.uuid;

      await expect(UserEntity.save(user)).rejects.toThrow(
        /no fields to update/,
      );
      expect(mock.queries).toHaveLength(0);
    });

    it('throws for composite-PK entity with only PK components set', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      await expect(MembershipEntity.save(makeMembership())).rejects.toThrow(
        /no fields to update/,
      );
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('delete() по составному PK', () => {
    it('builds DELETE with all PK components and RETURNING *', async () => {
      const mock = createMockExecutor([[roleRow]]);
      UserRoleEntity.setExecutor(mock.executor);

      const deleted = await UserRoleEntity.delete({
        user_uuid: roleRow.user_uuid,
        role_uuid: roleRow.role_uuid,
        organization_uuid: roleRow.organization_uuid,
      });

      expect(deleted).toBeInstanceOf(UserRoleEntity);
      const [q] = mock.queries;
      expect(q.sql).toContain('DELETE FROM `user_roles`');
      expect(q.sql).toContain('`user_uuid` = $pk_user_uuid');
      expect(q.sql).toContain('`role_uuid` = $pk_role_uuid');
      expect(q.sql).toContain('`organization_uuid` = $pk_organization_uuid');
      expect(q.sql).toContain('RETURNING *');
    });

    it('throws a clear error when a PK component is missing', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await expect(
        UserRoleEntity.delete({ user_uuid: roleRow.user_uuid }),
      ).rejects.toThrow(
        /primary key field\(s\) "role_uuid", "organization_uuid" must be set/,
      );
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('updateBy() / deleteBy() RETURNING по всем PK-колонкам', () => {
    it('updateBy returns all PK columns', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await UserRoleEntity.updateBy(
        { user_uuid: roleRow.user_uuid },
        { is_global: true },
      );

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'RETURNING `user_uuid`, `role_uuid`, `organization_uuid`',
      );
    });

    it('deleteBy returns all PK columns', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      await UserRoleEntity.deleteBy({ user_uuid: roleRow.user_uuid });

      const [q] = mock.queries;
      expect(q.sql).toContain(
        'RETURNING `user_uuid`, `role_uuid`, `organization_uuid`',
      );
    });
  });

  describe('insertMany() — опущенные поля vs явный NULL (#56)', () => {
    it('groups entities by column set inside a batch', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      const withRole = makeMembership({ role: 'admin' });
      const withoutRole = makeMembership();
      withoutRole.user_uuid = '00000000-0000-0000-0000-0000000000ff';

      await MembershipEntity.insertMany([withRole, withoutRole]);

      // Две группы колонок → два UPSERT в пределах одного батча
      expect(mock.queries).toHaveLength(2);
      expect(mock.queries[0].sql).toContain('`role`');
      expect(mock.queries[0].sql).toContain('$role_0');
      expect(mock.queries[1].sql).not.toContain('`role`');
      expect(mock.queries[1].sql).toContain('`tenant_id`');
      expect(mock.queries[1].sql).toContain('`user_uuid`');
    });

    it('keeps explicit null in the column set (same group, NULL param)', async () => {
      const mock = createMockExecutor([[]]);
      MembershipEntity.setExecutor(mock.executor);

      const withRole = makeMembership({ role: 'admin' });
      const withNull = makeMembership({ role: null as any });
      withNull.user_uuid = '00000000-0000-0000-0000-0000000000ff';

      await MembershipEntity.insertMany([withRole, withNull]);

      // Одинаковый набор колонок (role задан явно) → один UPSERT на две строки
      expect(mock.queries).toHaveLength(1);
      const [q] = mock.queries;
      expect(q.sql).toContain('$role_0');
      expect(q.sql).toContain('$role_1');
      expect((q.params.role_1 as any).item).toBeNull();
    });

    it('groups by columns after encryption (blind index adds _bi column)', async () => {
      const provider = new TestOnlyEncryptionProvider();
      PhotoEntity.setEncryptionProvider(provider);
      PhotoEntity.setBlindIndexProvider(provider);
      const mock = createMockExecutor([[]]);
      PhotoEntity.setExecutor(mock.executor);

      const withEmail = new PhotoEntity();
      withEmail.title = 'a';
      withEmail.author_email = 'a@b.c';
      const withoutEmail = new PhotoEntity();
      withoutEmail.title = 'b';

      await PhotoEntity.insertMany([withEmail, withoutEmail]);

      expect(mock.queries).toHaveLength(2);
      expect(mock.queries[0].sql).toContain('`author_email_bi`');
      expect(mock.queries[1].sql).not.toContain('`author_email_bi`');
      // uuid автогенерируется и входит в обе группы
      expect(mock.queries[0].sql).toContain('`uuid`');
      expect(mock.queries[1].sql).toContain('`uuid`');
    });

    it('throws a clear error when a PK component is missing', async () => {
      const mock = createMockExecutor([[]]);
      UserRoleEntity.setExecutor(mock.executor);

      const role = new UserRoleEntity();
      role.user_uuid = roleRow.user_uuid;

      await expect(UserRoleEntity.insertMany([role])).rejects.toThrow(
        /primary key field\(s\) "role_uuid", "organization_uuid" must be set/,
      );
      expect(mock.queries).toHaveLength(0);
    });
  });

  describe('relations с сущностью с составным PK', () => {
    it('loads many-to-one relation by FK column', async () => {
      const mock = createMockExecutor([[userRow]]);
      MembershipEntity.setExecutor(mock.executor);
      UserEntity.setExecutor(mock.executor);

      const membership = makeMembership({ role: 'admin' });
      await membership.loadRelations(['user']);

      expect(membership.user).toBeInstanceOf(UserEntity);
      expect(membership.user?.uuid).toBe(userRow.uuid);
      // #86: many-to-one грузится одним батч-IN по PK вместо find() на элемент.
      const [q] = mock.queries;
      expect(q.sql).toContain('SELECT * FROM `users`');
      expect(q.sql).toContain('WHERE `uuid` IN ($p0)');
    });
  });
});
