import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Injectable, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  YdbModule,
  YdbRepository,
  InjectRepository,
  getRepositoryToken,
  YDB_DRIVER,
  YDB_QUERY,
  YDB_SCHEMA_SYNC,
} from '../../src/index.js';
// Одноимённые классы из разных файлов: оба называются DupEntity
import { DupEntity as DupEntityA } from '../fixtures/token_collision_a/dup.entity.js';
import { DupEntity as DupEntityB } from '../fixtures/token_collision_b/dup.entity.js';
import { createMockExecutor } from '../helpers/mock-executor.js';

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';

@Injectable()
class DupService {
  constructor(
    @InjectRepository(DupEntityA)
    public readonly repoA: YdbRepository<DupEntityA>,
    @InjectRepository(DupEntityB)
    public readonly repoB: YdbRepository<DupEntityB>,
  ) {}
}

const dupFeature = YdbModule.forFeature([DupEntityA, DupEntityB]);

@Module({
  imports: [dupFeature],
  exports: [dupFeature],
})
class DupFeatureModule {}

describe('NestJS integration: коллизия DI-токенов одноимённых сущностей (#94)', () => {
  let module: TestingModule | undefined;
  let service: DupService;
  let queries: { sql: string }[];

  beforeEach(async () => {
    const mock = createMockExecutor(
      [
        [[{ uuid: UUID_A, title: 'from A' }]],
        [[{ uuid: UUID_B, title: 'from B' }]],
        [[{ uuid: UUID_A, title: 'from A' }]],
        [[{ uuid: UUID_B, title: 'from B' }]],
      ],
      { sequential: true },
    );
    queries = mock.queries;

    module = await Test.createTestingModule({
      imports: [
        YdbModule.forRoot({
          useFactory: () => ({
            endpoint: 'grpc://localhost:2136/local',
            database: '/local',
            auth_type: 'anonymous' as const,
            authOptions: {},
            sync: false,
          }),
        }),
        DupFeatureModule,
      ],
      providers: [DupService],
    })
      .overrideProvider(YDB_DRIVER)
      .useValue({})
      .overrideProvider(YDB_SCHEMA_SYNC)
      .useValue({ verify: jest.fn(), sync: jest.fn() })
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();

    service = module.get(DupService);
  });

  afterEach(async () => {
    if (module) await module.close();
    module = undefined;
    DupEntityA.setExecutor(undefined as any);
    DupEntityB.setExecutor(undefined as any);
  });

  it('одноимённые классы получают разные DI-токены', () => {
    expect(DupEntityA.name).toBe(DupEntityB.name);
    expect(getRepositoryToken(DupEntityA)).not.toBe(
      getRepositoryToken(DupEntityB),
    );
  });

  it('инжектятся два разных репозитория, привязанных к своим классам', () => {
    expect(service.repoA).toBeInstanceOf(YdbRepository);
    expect(service.repoB).toBeInstanceOf(YdbRepository);
    expect(service.repoA).not.toBe(service.repoB);
    expect(service.repoA.entityClass).toBe(DupEntityA);
    expect(service.repoB.entityClass).toBe(DupEntityB);
  });

  it('каждый репозиторий и Active Record ходят в свою таблицу', async () => {
    const viaRepoA = await service.repoA.findAll();
    const viaRepoB = await service.repoB.findAll();
    expect(viaRepoA[0]).toBeInstanceOf(DupEntityA);
    expect(viaRepoB[0]).toBeInstanceOf(DupEntityB);

    // AR-путь тоже инициализирован для обоих классов
    const viaArA = await DupEntityA.find({ uuid: UUID_A });
    const viaArB = await DupEntityB.find({ uuid: UUID_B });
    expect(viaArA?.uuid).toBe(UUID_A);
    expect(viaArB?.uuid).toBe(UUID_B);

    // Запросы уходят строго в свои таблицы: A — только token_dup_a и т.д.
    const sqls = queries.map((q) => q.sql);
    expect(sqls.filter((s) => s.includes('token_dup_a')).length).toBe(2);
    expect(sqls.filter((s) => s.includes('token_dup_b')).length).toBe(2);
    expect(sqls.every((s) => /token_dup_[ab]/.test(s))).toBe(true);
  });

  it('повторная регистрация того же класса идемпотентна', async () => {
    const tokenBefore = getRepositoryToken(DupEntityA);

    // #93: два живых YdbCoreModule одновременно запрещены —
    // закрываем модуль из beforeEach перед повторным бутстрапом
    await module?.close();
    module = undefined;

    // Тот же класс дважды в forFeature — провайдеры не конфликтуют
    const mock = createMockExecutor([[{ uuid: UUID_A, title: 'again' }]]);
    const extra = await Test.createTestingModule({
      imports: [
        YdbModule.forRoot({
          useFactory: () => ({
            endpoint: 'grpc://localhost:2136/local',
            database: '/local',
            auth_type: 'anonymous' as const,
            authOptions: {},
            sync: false,
          }),
        }),
        YdbModule.forFeature([DupEntityA, DupEntityA]),
      ],
    })
      .overrideProvider(YDB_DRIVER)
      .useValue({})
      .overrideProvider(YDB_SCHEMA_SYNC)
      .useValue({ verify: jest.fn(), sync: jest.fn() })
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();

    // Тот же класс — тот же токен; репозиторий резолвится из общего runtime
    expect(getRepositoryToken(DupEntityA)).toBe(tokenBefore);
    const resolved = extra.get<YdbRepository<DupEntityA>>(
      getRepositoryToken(DupEntityA),
    );
    expect(resolved.entityClass).toBe(DupEntityA);

    await extra.close();
  });
});
