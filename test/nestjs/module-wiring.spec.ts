import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { Uuid } from '@ydbjs/value/primitive';
import {
  YdbCoreModule,
  YdbModule,
  YdbTransactionManager,
  YDB_DRIVER,
  YDB_QUERY,
  YDB_SCHEMA_SYNC,
  YdbSchemaSyncer,
} from '../../src/index.js';
import { UserEntity } from '../fixtures/user/user.entity.js';
import { UserRoleEntity } from '../fixtures/user_role/user_role.entity.js';
import { PhotoEntity } from '../fixtures/photo/photo.entity.js';
import { Base64TestEncryptionProvider } from '../../src/encryption/base64-test-encryption.provider.js';
import { createMockExecutor } from '../helpers/mock-executor.js';

@Module({
  imports: [YdbModule.forFeature([UserEntity, UserRoleEntity, PhotoEntity])],
})
class TestFeatureModule {}

const userRow = {
  uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
  email_encrypted: 'enc',
  full_name: 'Ivan',
};

async function createTestingModule(rows: any[][]) {
  const mock = createMockExecutor(rows);

  const module = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth_type: 'anonymous' as const,
          authOptions: {},
          encryptionProvider: new Base64TestEncryptionProvider(),
          blindIndexProvider: new Base64TestEncryptionProvider(),
          sync: false,
        }),
      }),
      TestFeatureModule,
    ],
  })
    // Драйвер не нужен: executor подменён, sync выключен
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(mock.executor)
    .compile();

  return { module, mock };
}

describe('NestJS integration: module wiring', () => {
  it('provides executor, transaction manager and schema syncer', async () => {
    const { module } = await createTestingModule([[]]);

    expect(module.get(YDB_QUERY)).toBeDefined();
    expect(module.get(YdbTransactionManager)).toBeInstanceOf(
      YdbTransactionManager,
    );
    expect(module.get(YDB_SCHEMA_SYNC)).toBeInstanceOf(YdbSchemaSyncer);

    await module.close();
  });

  it('injects executor into Active Record entities via forFeature', async () => {
    const { module, mock } = await createTestingModule([[userRow]]);

    const user = await UserEntity.findByUuid(userRow.uuid);

    expect(user).toBeInstanceOf(UserEntity);
    expect(user?.uuid).toBe(userRow.uuid);

    const [findQuery] = mock.queries;
    expect(findQuery.sql).toContain('SELECT * FROM `users`');
    expect(findQuery.sql).toContain('WHERE `uuid` = $uuid');
    expect(findQuery.params.uuid).toBeInstanceOf(Uuid);
    expect(String(findQuery.params.uuid)).toBe(userRow.uuid);

    // @EagerLoad(['userRoles']) — второй запрос: batch-загрузка ролей
    expect(mock.queries[1]?.sql).toContain('FROM `user_roles`');

    await module.close();
  });

  it('runs count() through the injected executor', async () => {
    const { module, mock } = await createTestingModule([[{ cnt: 42 }]]);

    const count = await UserEntity.count({ uuid: userRow.uuid });

    expect(count).toBe(42);
    expect(mock.queries[0].sql).toContain(
      'SELECT COUNT(*) AS cnt FROM `users`',
    );

    await module.close();
  });

  it('runs insertMany with batching through the injected executor', async () => {
    const { module, mock } = await createTestingModule([[]]);

    const makeRole = (n: number) => {
      const r = new UserRoleEntity();
      r.user_uuid = `00000000-0000-0000-0000-00000000000${n}`;
      r.role_uuid = `00000000-0000-0000-0000-00000000001${n}`;
      r.organization_uuid = `00000000-0000-0000-0000-00000000002${n}`;
      r.is_global = true;
      return r;
    };
    const roles = [makeRole(0), makeRole(1)];
    await UserRoleEntity.insertMany(roles);

    expect(mock.queries[0].sql).toContain('UPSERT INTO `user_roles`');
    expect(mock.queries[0].sql).toContain('`user_uuid`');
    expect(mock.queries[0].sql).toContain('`is_global`');

    await module.close();
  });

  it('runs queries in a transaction via YdbTransactionManager from DI', async () => {
    const { module, mock } = await createTestingModule([[{ cnt: 1 }]]);
    const txManager = module.get(YdbTransactionManager);

    const result = await txManager.runInTransaction(async (trx) => {
      expect(trx).toBeDefined();
      return UserEntity.count({}, { trx });
    });

    expect(result).toBe(1);
    expect(mock.queries[0].sql).toContain('SELECT COUNT(*)');

    await module.close();
  });

  it('rejects invalid auth type with a clear error', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          YdbCoreModule.forRootAsync({
            useFactory: () => ({
              endpoint: 'grpc://localhost:2136/local',
              auth_type: 'oauth' as any,
              authOptions: {},
            }),
          }),
        ],
      })
        .overrideProvider(YDB_DRIVER)
        .useValue({})
        .compile(),
    ).rejects.toThrow(/Invalid YDB auth type/);
  });
});
