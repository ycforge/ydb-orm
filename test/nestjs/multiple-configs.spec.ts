import 'reflect-metadata';
import { describe, it, expect, afterEach } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { createAuth } from '@ycforge/auth';
import {
  YdbCoreModule,
  YdbOrmModule,
  YDB_QUERY,
  YdbBaseEntity,
  YdbEntity,
  YdbPrimaryColumn,
  YdbColumn,
  getRepositoryToken,
  getScopedToken,
  getTransactionManagerToken,
  YdbTransactionManager,
  getEntityOrmScope,
  releaseOrmScope,
} from '../../src/nest/index.js';
import { createMockExecutor } from '../helpers/mock-executor.js';

@YdbEntity('mc_users')
class McUser extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

@YdbEntity('mc_reports')
class McReport extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  title!: string;
}

@YdbEntity('mc_conflict')
class McConflict extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

/** Минимальный драйвер-заглушка: запросы всё равно идут через override YDB_QUERY. */
function fakeDriver() {
  return { close: () => undefined } as any;
}

function coreOptions() {
  return {
    endpoint: 'grpc://localhost:2136/local',
    auth: createAuth({ type: 'anonymous' }),
    driverFactory: () => fakeDriver(),
  };
}

describe('NestJS: несколько независимых конфигураций (#199)', () => {
  let openModules: TestingModule[];

  beforeEach(() => {
    openModules = [];
  });

  afterEach(async () => {
    for (const module of openModules) {
      await module.close().catch(() => undefined);
    }
    openModules = [];
  });

  function track(module: TestingModule): TestingModule {
    openModules.push(module);
    return module;
  }

  it('default + именованная конфигурация сосуществуют и изолированы', async () => {
    const execDefault = createMockExecutor();
    const execReporting = createMockExecutor();

    const module = track(
      await Test.createTestingModule({
        imports: [
          YdbCoreModule.forRootAsync({ useFactory: () => coreOptions() }),
          YdbCoreModule.forRootAsync({
            name: 'reporting',
            useFactory: () => coreOptions(),
          }),
          YdbOrmModule.forFeature([McUser]),
          YdbOrmModule.forFeature([McReport], 'reporting'),
        ],
      })
        .overrideProvider(YDB_QUERY)
        .useValue(execDefault.executor)
        .overrideProvider(getScopedToken(YDB_QUERY, 'reporting'))
        .useValue(execReporting.executor)
        .compile(),
    );
    await module.init();

    // Каждая сущность ходит в executor СВОЕЙ конфигурации.
    await McUser.find({ uuid: '00000000-0000-0000-0000-000000000001' });
    await McReport.findAll();
    expect(execDefault.queries.map((q) => q.sql)).toEqual([
      expect.stringContaining('mc_users'),
    ]);
    expect(execReporting.queries.map((q) => q.sql)).toEqual([
      expect.stringContaining('mc_reports'),
    ]);

    // DI-репозитории разнесены по токенам конфигураций.
    expect(module.get(getRepositoryToken(McUser))).toBeDefined();
    expect(module.get(getRepositoryToken(McReport, 'reporting'))).toBeDefined();

    // Менеджеры транзакций — отдельные инстансы на конфигурацию.
    const tmDefault = module.get(YdbTransactionManager);
    const tmReporting = module.get(getTransactionManagerToken('reporting'));
    expect(tmReporting).toBeDefined();
    expect(tmReporting).not.toBe(tmDefault);
  });

  it('одна сущность в двух конфигурациях — детерминированная ошибка', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          YdbCoreModule.forRootAsync({
            name: 'cfg-a',
            useFactory: () => coreOptions(),
          }),
          YdbCoreModule.forRootAsync({
            name: 'cfg-b',
            useFactory: () => coreOptions(),
          }),
          YdbOrmModule.forFeature([McConflict], 'cfg-a'),
          YdbOrmModule.forFeature([McConflict], 'cfg-b'),
        ],
      })
        .overrideProvider(getScopedToken(YDB_QUERY, 'cfg-a'))
        .useValue(createMockExecutor().executor)
        .overrideProvider(getScopedToken(YDB_QUERY, 'cfg-b'))
        .useValue(createMockExecutor().executor)
        .compile(),
    ).rejects.toThrow(/already registered in another YDB configuration/);

    // Неудачный бутстрап не освобождает claim автоматически — чистим
    // вручную, чтобы не влиять на следующие тесты файла.
    const scope = getEntityOrmScope(McConflict);
    if (scope) releaseOrmScope(scope);
  });

  it('дубликат имени конфигурации — прежняя ошибка двойной инициализации', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          YdbCoreModule.forRootAsync({
            name: 'reporting-dup',
            useFactory: () => coreOptions(),
          }),
          YdbCoreModule.forRootAsync({
            name: 'reporting-dup',
            useFactory: () => coreOptions(),
          }),
        ],
      })
        .overrideProvider(getScopedToken(YDB_QUERY, 'reporting-dup'))
        .useValue(createMockExecutor().executor)
        .compile(),
    ).rejects.toThrow(/Duplicate YDB module initialization/);
  });

  it('после shutdown сущность можно привязать к другой конфигурации', async () => {
    const first = track(
      await Test.createTestingModule({
        imports: [
          YdbCoreModule.forRootAsync({ useFactory: () => coreOptions() }),
          YdbCoreModule.forRootAsync({
            name: 'reporting',
            useFactory: () => coreOptions(),
          }),
          YdbOrmModule.forFeature([McReport], 'reporting'),
        ],
      })
        .overrideProvider(YDB_QUERY)
        .useValue(createMockExecutor().executor)
        .overrideProvider(getScopedToken(YDB_QUERY, 'reporting'))
        .useValue(createMockExecutor().executor)
        .compile(),
    );
    await first.init();
    expect(getEntityOrmScope(McReport)?.name).toBe('reporting');

    await first.close();
    expect(getEntityOrmScope(McReport)).toBeUndefined();

    // Та же сущность — теперь в дефолтной конфигурации нового приложения.
    const second = track(
      await Test.createTestingModule({
        imports: [
          YdbCoreModule.forRootAsync({ useFactory: () => coreOptions() }),
          YdbOrmModule.forFeature([McReport]),
        ],
      })
        .overrideProvider(YDB_QUERY)
        .useValue(createMockExecutor().executor)
        .compile(),
    );
    await second.init();
    expect(getEntityOrmScope(McReport)?.name).toBe('default');
  });
});
