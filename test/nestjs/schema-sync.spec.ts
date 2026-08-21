import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import {
  CreateSessionResultSchema,
  TableServiceDefinition,
} from '@ydbjs/api/table';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import {
  YdbCoreModule,
  YdbModule,
  YDB_DRIVER,
  YDB_QUERY,
} from '../../src/index.js';
import { UserEntity } from '../fixtures/user/user.entity.js';
import { UserRoleEntity } from '../fixtures/user_role/user_role.entity.js';
import { PhotoEntity } from '../fixtures/photo/photo.entity.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import { createMockExecutor } from '../helpers/mock-executor.js';

@Module({
  imports: [YdbModule.forFeature([UserEntity, UserRoleEntity, PhotoEntity])],
})
class TestFeatureModule {}

/**
 * Фейковый драйвер: DescribeTable всегда отвечает SCHEME_ERROR
 * (таблицы не существует) → sync должен создать все таблицы.
 */
function createFakeDriver() {
  const sessionResult = anyPack(
    CreateSessionResultSchema,
    create(CreateSessionResultSchema, { sessionId: 'session-1' }),
  );

  const tableClient = {
    createSession: jest.fn(() =>
      Promise.resolve({
        operation: { result: sessionResult },
      }),
    ),
    describeTable: jest.fn(() =>
      Promise.resolve({
        operation: { status: StatusIds_StatusCode.SCHEME_ERROR },
      }),
    ),
    deleteSession: jest.fn(() => Promise.resolve({})),
  };

  const driver = {
    database: '/local',
    createClient: jest.fn(() => tableClient),
  };

  return { driver, tableClient };
}

describe('NestJS integration: schema sync on bootstrap', () => {
  it('creates tables for all registered entities when sync: true', async () => {
    const mock = createMockExecutor();
    const { driver, tableClient } = createFakeDriver();

    const module = await Test.createTestingModule({
      imports: [
        YdbCoreModule.forRootAsync({
          useFactory: () => ({
            endpoint: 'grpc://localhost:2136/local',
            auth_type: 'anonymous' as const,
            authOptions: {},
            encryptionProvider: new TestOnlyEncryptionProvider(),
            blindIndexProvider: new TestOnlyEncryptionProvider(),
            sync: true,
          }),
        }),
        TestFeatureModule,
      ],
    })
      .overrideProvider(YDB_DRIVER)
      .useValue(driver)
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();

    const ddl = mock.queries.map((q) => q.sql);

    // Все три таблицы созданы во время инициализации модуля
    expect(ddl.some((sql) => sql.startsWith('CREATE TABLE `users`'))).toBe(
      true,
    );
    expect(ddl.some((sql) => sql.startsWith('CREATE TABLE `user_roles`'))).toBe(
      true,
    );
    expect(ddl.some((sql) => sql.startsWith('CREATE TABLE `photos`'))).toBe(
      true,
    );

    // PK и synthetic blind index колонка на месте; шифротекст хранится как Bytes
    const usersDdl = ddl.find((sql) => sql.startsWith('CREATE TABLE `users`'))!;
    expect(usersDdl).toContain('PRIMARY KEY (`uuid`)');
    expect(usersDdl).toContain('`email_encrypted` Bytes');
    expect(usersDdl).toContain('`email_encrypted_bi` Utf8');

    const rolesDdl = ddl.find((sql) =>
      sql.startsWith('CREATE TABLE `user_roles`'),
    )!;
    expect(rolesDdl).toContain(
      'PRIMARY KEY (`user_uuid`, `role_uuid`, `organization_uuid`)',
    );

    const photosDdl = ddl.find((sql) =>
      sql.startsWith('CREATE TABLE `photos`'),
    )!;
    expect(photosDdl).toContain('`author_email` Bytes');
    expect(photosDdl).toContain('`author_email_bi` Utf8');
    expect(photosDdl).toContain('`file_size` Int64');
    expect(photosDdl).toContain('`rating` Double');

    // DescribeTable шёл через Table service, сессии закрыты
    expect(driver.createClient).toHaveBeenCalledWith(TableServiceDefinition);
    expect(tableClient.deleteSession).toHaveBeenCalledTimes(3);

    await module.close();
  });

  it('does not run DDL when sync is not set', async () => {
    const mock = createMockExecutor();
    const { driver } = createFakeDriver();

    const module = await Test.createTestingModule({
      imports: [
        YdbCoreModule.forRootAsync({
          useFactory: () => ({
            endpoint: 'grpc://localhost:2136/local',
            auth_type: 'anonymous' as const,
            authOptions: {},
            encryptionProvider: new TestOnlyEncryptionProvider(),
            blindIndexProvider: new TestOnlyEncryptionProvider(),
          }),
        }),
        TestFeatureModule,
      ],
    })
      .overrideProvider(YDB_DRIVER)
      .useValue(driver)
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();

    expect(mock.queries).toEqual([]);
    expect(driver.createClient).not.toHaveBeenCalled();

    await module.close();
  });
});
