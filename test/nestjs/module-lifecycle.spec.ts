import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { Driver } from '@ydbjs/core';
import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import {
  CreateSessionResultSchema,
  DescribeTableResultSchema,
} from '@ydbjs/api/table';
import { IssueMessageSchema, StatusIds_StatusCode } from '@ydbjs/api/operation';
import { TypeSchema, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import {
  YdbCoreModule,
  YdbModule,
  YDB_DRIVER,
  YDB_QUERY,
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  getRegisteredYdbEntities,
  registerYdbEntity,
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
 * Фейковый драйвер для schema sync. По умолчанию все таблицы «не существуют»
 * (SCHEME_ERROR not-found, #91) — sync должен выдать CREATE TABLE через executor.
 * `describePathError` позволяет переопределить ответ для конкретной таблицы.
 */
function createFakeDriver(
  describeOverride?: (
    path: string,
  ) =>
    | { status: number; issues?: unknown[] }
    | { status: number; result: unknown }
    | undefined,
) {
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
    describeTable: jest.fn((args: { path: string }) => {
      const custom = describeOverride?.(args.path);
      if (custom) {
        return Promise.resolve({ operation: custom });
      }
      return Promise.resolve({
        operation: {
          status: StatusIds_StatusCode.SCHEME_ERROR,
          issues: [
            create(IssueMessageSchema, {
              message: `path '${args.path}' does not exist`,
              severity: 1,
            }),
          ],
        },
      });
    }),
    deleteSession: jest.fn(() => Promise.resolve({})),
  };

  const driver = {
    database: '/local',
    createClient: jest.fn(() => tableClient),
  };

  return { driver, tableClient };
}

/** Подменный драйвер для проверки владения: у объекта есть только close(). */
function makeClosableDriver() {
  return { closeCalls: 0, close: () => undefined };
}

function coreImports(
  sync = false,
  overrides: {
    driverFactory?: () => Driver | Promise<Driver>;
  } = {},
) {
  return [
    YdbCoreModule.forRootAsync({
      useFactory: () => ({
        endpoint: 'grpc://localhost:2136/local',
        auth_type: 'anonymous' as const,
        authOptions: {},
        encryptionProvider: new TestOnlyEncryptionProvider(),
        blindIndexProvider: new TestOnlyEncryptionProvider(),
        sync,
        ...overrides,
      }),
    }),
    TestFeatureModule,
  ];
}

describe('NestJS integration: жизненный цикл YdbCoreModule (#93)', () => {
  let openModules: TestingModule[];

  beforeEach(() => {
    openModules = [];
  });

  afterEach(async () => {
    for (const m of openModules.splice(0)) {
      await m.close().catch(() => undefined);
    }
  });

  it('двойной forRootAsync в одном процессе падает с понятной ошибкой', async () => {
    const mock = createMockExecutor();

    const first = await Test.createTestingModule({
      imports: coreImports(),
    })
      .overrideProvider(YDB_DRIVER)
      .useValue({})
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();
    openModules.push(first);

    await expect(
      Test.createTestingModule({
        imports: coreImports(),
      })
        .overrideProvider(YDB_DRIVER)
        .useValue({})
        .overrideProvider(YDB_QUERY)
        .useValue(mock.executor)
        .compile(),
    ).rejects.toThrow(/Duplicate YDB module initialization/);

    // Защита lifecycle-aware: после закрытия первого приложения
    // новый бутстрап разрешён (а не «навсегда заблокирован» флагом)
    await first.close();
    openModules.pop();

    const second = await Test.createTestingModule({
      imports: coreImports(),
    })
      .overrideProvider(YDB_DRIVER)
      .useValue({})
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();
    openModules.push(second);

    await second.init();
    const count = await UserEntity.count({});
    expect(count).toBe(0);
  });

  it('schema sync выполняется на бутстрапе, после регистрации сущностей', async () => {
    const mock = createMockExecutor();
    const { driver, tableClient } = createFakeDriver();

    // Скоуп предыдущих тестов уже закрыт: регистрируем нужные сущности
    // явно (регистрация идемпотентна, #142)
    registerYdbEntity(UserEntity);
    registerYdbEntity(PhotoEntity);

    const module = await Test.createTestingModule({
      imports: coreImports(true),
    })
      .overrideProvider(YDB_DRIVER)
      .useValue(driver)
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();
    openModules.push(module);

    // До бутстрапа DI-фабрика не выполняет ни одного запроса к БД
    expect(mock.queries).toEqual([]);
    expect(tableClient.createSession).not.toHaveBeenCalled();

    await module.init();

    const ddl = mock.queries.map((q) => q.sql);
    expect(ddl.some((sql) => sql.startsWith('CREATE TABLE `users`'))).toBe(
      true,
    );
    expect(ddl.some((sql) => sql.startsWith('CREATE TABLE `photos`'))).toBe(
      true,
    );

    // Сущности получили executor и работают после синхронизации схемы
    const count = await UserEntity.count({});
    expect(count).toBe(0);
    expect(mock.queries.some((q) => q.sql.includes('SELECT COUNT(*)'))).toBe(
      true,
    );

    expect(tableClient.deleteSession).toHaveBeenCalled();
  });

  it('ошибка schema sync доходит до init() как исходная ошибка схемы', async () => {
    const mock = createMockExecutor();
    // Скоуп предыдущих тестов закрыт — users нужна в скоупе этого приложения
    registerYdbEntity(UserEntity);
    // Таблица users «существует», но колонка uuid имеет тип String вместо Uuid:
    // sync обязан бросить исходную ошибку о расхождении типов.
    // Остальные таблицы не существуют — для них вернётся not-found и CREATE TABLE.
    const { driver } = createFakeDriver((path) => {
      if (path.endsWith('/users')) {
        return {
          status: StatusIds_StatusCode.SUCCESS,
          result: anyPack(
            DescribeTableResultSchema,
            create(DescribeTableResultSchema, {
              columns: [
                {
                  name: 'uuid',
                  type: create(TypeSchema, {
                    type: {
                      case: 'typeId',
                      value: Type_PrimitiveTypeId.STRING,
                    },
                  }),
                },
              ],
              primaryKey: ['uuid'],
              indexes: [],
            }),
          ),
        };
      }
      return undefined;
    });

    const module = await Test.createTestingModule({
      imports: coreImports(true),
    })
      .overrideProvider(YDB_DRIVER)
      .useValue(driver)
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();
    openModules.push(module);

    await expect(module.init()).rejects.toThrow(
      /Schema sync failed for table "users".*column type mismatch/,
    );
  });

  it('graceful shutdown закрывает созданный модулем драйвер ровно один раз', async () => {
    const mock = createMockExecutor();
    const fakeDriver = makeClosableDriver();
    let closeCount = 0;
    fakeDriver.close = () => {
      closeCount++;
    };

    // YDB_DRIVER не подменяется: драйвер создаёт сам модуль (через driverFactory)
    const module = await Test.createTestingModule({
      imports: coreImports(false, {
        driverFactory: () => fakeDriver as unknown as Driver,
      }),
    })
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();
    openModules.push(module);

    await module.init();
    expect(closeCount).toBe(0);

    await module.close();
    expect(closeCount).toBe(1);

    // Повторный shutdown не должен закрывать драйвер второй раз
    await module.close();
    expect(closeCount).toBe(1);

    openModules.pop();
  });

  it('драйвер, переданный снаружи, при shutdown не закрывается', async () => {
    const mock = createMockExecutor();
    const closeSpy = jest.fn(() => Promise.resolve());

    const module = await Test.createTestingModule({
      imports: coreImports(),
    })
      .overrideProvider(YDB_DRIVER)
      .useValue({ close: closeSpy })
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();
    openModules.push(module);

    await module.init();
    await module.close();

    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('неудача создания драйвера освобождает слот инициализации', async () => {
    // Ошибка — исходная причина (сеть), а не обёртка DI
    await expect(
      Test.createTestingModule({
        imports: coreImports(false, {
          driverFactory: () => Promise.reject(new Error('connection refused')),
        }),
      }).compile(),
    ).rejects.toThrow(/connection refused/);

    // Слот освобождён: следующий бутстрап проходит без ошибки дубликата
    const retry = await Test.createTestingModule({
      imports: coreImports(),
    })
      .overrideProvider(YDB_DRIVER)
      .useValue({})
      .overrideProvider(YDB_QUERY)
      .useValue(createMockExecutor().executor)
      .compile();
    openModules.push(retry);
    await retry.init();
  });

  it('YdbModule.forRoot наследует защиту от дублей', async () => {
    const mock = createMockExecutor();
    const first = await Test.createTestingModule({
      imports: [
        YdbModule.forRoot({
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
      .useValue({})
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();
    openModules.push(first);

    await expect(
      Test.createTestingModule({ imports: coreImports() })
        .overrideProvider(YDB_DRIVER)
        .useValue({})
        .overrideProvider(YDB_QUERY)
        .useValue(mock.executor)
        .compile(),
    ).rejects.toThrow(/Duplicate YDB module initialization/);
  });

  describe('изоляция реестра сущностей между приложениями (#142)', () => {
    /** Приложение с sync:true на фейковом драйвере; возвращает DDL-запросы. */
    async function bootstrappSyncedApp(): Promise<string[]> {
      const mock = createMockExecutor();
      const { driver } = createFakeDriver();
      const module = await Test.createTestingModule({
        imports: coreImports(true),
      })
        .overrideProvider(YDB_DRIVER)
        .useValue(driver)
        .overrideProvider(YDB_QUERY)
        .useValue(mock.executor)
        .compile();
      openModules.push(module);
      await module.init();
      return mock.queries.map((q) => q.sql);
    }

    it('закрытое приложение не протекает сущностями в следующее', async () => {
      // Сущность приложения A декларируется внутри теста: она регистрируется
      // декоратором только сейчас и принадлежит только этому приложению
      @YdbEntity('scoped_a_only')
      class ScopedA extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;
      }
      registerYdbEntity(ScopedA);

      await bootstrappSyncedApp(); // A: sync создаёт scoped_a_only
      for (const m of openModules.splice(0)) {
        await m.close();
      }

      @YdbEntity('scoped_b_only')
      class ScopedB extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;
      }
      registerYdbEntity(ScopedB);

      // Приложение B: в его sync есть B и нет ни A, ни общих фикстур файла,
      // принятых (и отпущенных) скоупом приложения A
      const ddl = await bootstrappSyncedApp();
      expect(
        ddl.some((sql) => sql.startsWith('CREATE TABLE `scoped_b_only`')),
      ).toBe(true);
      expect(ddl.some((sql) => sql.includes('scoped_a_only'))).toBe(false);
      expect(ddl.some((sql) => sql.startsWith('CREATE TABLE `users`'))).toBe(
        false,
      );
    });

    it('после неудачного бутстрапа следующий стартует с чистым набором сущностей', async () => {
      @YdbEntity('scoped_fail')
      class ScopedFail extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;
      }
      registerYdbEntity(ScopedFail);

      // Sync падает на таблице scoped_fail (mismatch типов uuid) — init() отклоняется
      const { driver: failingDriver } = createFakeDriver((path) => {
        if (path.endsWith('/scoped_fail')) {
          return {
            status: StatusIds_StatusCode.SUCCESS,
            result: anyPack(
              DescribeTableResultSchema,
              create(DescribeTableResultSchema, {
                columns: [
                  {
                    name: 'uuid',
                    type: create(TypeSchema, {
                      type: {
                        case: 'typeId',
                        value: Type_PrimitiveTypeId.INT32,
                      },
                    }),
                  },
                ],
                primaryKey: ['uuid'],
                indexes: [],
              }),
            ),
          };
        }
        return undefined;
      });

      const mockFailing = createMockExecutor();
      const failedModule = await Test.createTestingModule({
        imports: coreImports(true),
      })
        .overrideProvider(YDB_DRIVER)
        .useValue(failingDriver)
        .overrideProvider(YDB_QUERY)
        .useValue(mockFailing.executor)
        .compile();
      openModules.push(failedModule);

      let initError: unknown;
      try {
        await failedModule.init();
      } catch (error) {
        initError = error;
      }
      expect(initError).toBeInstanceOf(Error);
      expect((initError as Error).message).toMatch(
        /Schema sync failed for table "scoped_fail"/,
      );

      @YdbEntity('scoped_after_fail')
      class ScopedAfterFail extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;
      }
      registerYdbEntity(ScopedAfterFail);

      const ddl = await bootstrappSyncedApp();
      expect(
        ddl.some((sql) => sql.startsWith('CREATE TABLE `scoped_after_fail`')),
      ).toBe(true);
      expect(ddl.some((sql) => sql.includes('scoped_fail'))).toBe(false);

      // close() неудачного модуля повторно выбрасывает ошибку init()
      // (Nest хранит initializationPromise) — глотаем её здесь
      for (const m of openModules.splice(0)) {
        await m.close().catch(() => {});
      }
    });

    it('сущности нескольких forFeature-модулей одного приложения видны sync', async () => {
      @YdbEntity('scoped_feat_one')
      class FeatOne extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;
      }
      registerYdbEntity(FeatOne);

      @YdbEntity('scoped_feat_two')
      class FeatTwo extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;
      }
      registerYdbEntity(FeatTwo);

      @Module({
        imports: [YdbModule.forFeature([FeatOne])],
      })
      class FeatureOneModule {}

      @Module({
        imports: [YdbModule.forFeature([FeatTwo])],
      })
      class FeatureTwoModule {}

      const mock = createMockExecutor();
      const { driver } = createFakeDriver();
      const module = await Test.createTestingModule({
        imports: [...coreImports(true), FeatureOneModule, FeatureTwoModule],
      })
        .overrideProvider(YDB_DRIVER)
        .useValue(driver)
        .overrideProvider(YDB_QUERY)
        .useValue(mock.executor)
        .compile();
      openModules.push(module);
      await module.init();

      const ddl = mock.queries.map((q) => q.sql);
      expect(
        ddl.some((sql) => sql.startsWith('CREATE TABLE `scoped_feat_one`')),
      ).toBe(true);
      expect(
        ddl.some((sql) => sql.startsWith('CREATE TABLE `scoped_feat_two`')),
      ).toBe(true);

      await module.close();
      openModules.pop();
    });

    it('повторная регистрация той же сущности идемпотентна', () => {
      // Последний тест файла: класс попадает в detached-набор и никого
      // не загрязняет после себя
      @YdbEntity('scoped_dup_reg')
      class DupReg extends YdbBaseEntity {
        @YdbPrimaryColumn('Uuid')
        uuid!: string;
      }
      registerYdbEntity(DupReg);
      registerYdbEntity(DupReg);
      registerYdbEntity(DupReg);

      expect(
        getRegisteredYdbEntities().filter((c) => c === DupReg),
      ).toHaveLength(1);
    });
  });
});
