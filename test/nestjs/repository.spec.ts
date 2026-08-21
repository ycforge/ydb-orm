import { jest } from '@jest/globals';
import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { YdbModule, YdbRepository } from '../../src/index.js';
import { UserEntity } from '../fixtures/user/user.entity.js';
import { createMockExecutor } from '../helpers/mock-executor.js';
import { InjectRepository } from '../../src/repository/repository-token.js';
import {
  YDB_DRIVER,
  YDB_QUERY,
  YDB_SCHEMA_SYNC,
} from '../../src/core/constants.js';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';

@Injectable()
class UserService {
  constructor(
    @InjectRepository(UserEntity)
    public readonly repo: YdbRepository<UserEntity>,
  ) {}

  async findOne() {
    return this.repo.findOneBy({
      uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
    });
  }
}

describe('YdbRepository DI', () => {
  let module: TestingModule;
  let service: UserService;
  let mock: ReturnType<typeof createMockExecutor>;

  beforeEach(async () => {
    mock = createMockExecutor([
      [
        {
          uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
          email_encrypted: new TextEncoder().encode('enc'),
          full_name: new TextEncoder().encode('Test User'),
        },
      ],
    ]);

    module = await Test.createTestingModule({
      imports: [
        YdbModule.forRoot({
          useFactory: () => ({
            endpoint: 'grpc://localhost:2136/local',
            database: '/local',
            auth_type: 'anonymous',
            encryptionProvider: new TestOnlyEncryptionProvider(),
            blindIndexProvider: new TestOnlyEncryptionProvider(),
          }),
        }),
        YdbModule.forFeature([UserEntity]),
      ],
      providers: [UserService],
    })
      .overrideProvider(YDB_DRIVER)
      .useValue({})
      .overrideProvider(YDB_SCHEMA_SYNC)
      .useValue({ verify: jest.fn(), sync: jest.fn() })
      .overrideProvider(YDB_QUERY)
      .useValue(mock.executor)
      .compile();

    service = module.get(UserService);
  });

  afterEach(async () => {
    if (module) await module.close();
    UserEntity.setExecutor(undefined as any);
  });

  it('injects repository with @InjectRepository', () => {
    expect(service.repo).toBeInstanceOf(YdbRepository);
    expect(service.repo.entityClass).toBe(UserEntity);
  });

  it('repository methods delegate to entity statics', async () => {
    const result = await service.repo.findOneBy({
      uuid: '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5',
    });
    expect(result).toBeInstanceOf(UserEntity);
    expect((result as any)?.uuid).toBe('5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5');
    expect(mock.queries.length).toBeGreaterThanOrEqual(1);
    expect(mock.queries[0].sql).toContain('SELECT');
    expect(mock.queries[0].sql).toContain('FROM `users`');
  });

  it('findAll delegates and keeps AR working', async () => {
    const rows = await service.repo.findAll();
    expect(rows.length).toBe(1);
    expect(rows[0]).toBeInstanceOf(UserEntity);
  });

  it('query() returns YdbQueryBuilder for entity', () => {
    const qb = service.repo.query();
    expect(qb).toBeDefined();
    expect((qb as any).entity).toBe(UserEntity);
  });
});
