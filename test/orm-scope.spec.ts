import 'reflect-metadata';
import { describe, it, expect, jest, afterEach } from '@jest/globals';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
  configureEntities,
  createOrmScope,
  releaseOrmScope,
  getEntityOrmScope,
  YdbTransactionManager,
  configureTransactionContext,
} from '../src/index.js';
import { getEntityRuntime } from '../src/entity/entity-runtime.js';
import {
  resolveOperationExecutor,
  getActiveTransaction,
} from '../src/transaction/transaction-context.js';
import { createMockExecutor } from './helpers/mock-executor.js';
import { createScriptedExecutor } from './helpers/ydb-mock.js';

@YdbEntity('scope_users_a')
class ScopeUserA extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

@YdbEntity('scope_users_b')
class ScopeUserB extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbColumn('Utf8')
  name!: string;
}

@YdbEntity('scope_shared')
class ScopeShared extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;
}

describe('ORM scopes: независимые конфигурации в одном процессе (#199)', () => {
  afterEach(() => {
    configureTransactionContext(undefined);
    // Освобождаем сущности этого файла от любых скоупов (включая дефолтный
    // синглтон): каждый тест начинает с чистого владения.
    for (const entity of [ScopeUserA, ScopeUserB, ScopeShared]) {
      const scope = getEntityOrmScope(entity);
      if (scope) {
        releaseOrmScope(scope);
      }
    }
  });

  it('claim: одна сущность не может принадлежать двум активным скоупам', () => {
    const first = createOrmScope('first');
    const second = createOrmScope('second');

    configureEntities([ScopeShared], {
      executor: createMockExecutor().executor,
      scope: first,
    });

    expect(() =>
      configureEntities([ScopeShared], {
        executor: createMockExecutor().executor,
        scope: second,
      }),
    ).toThrow(/already registered in another YDB configuration \("first"\)/);

    // Повторный claim тем же скоупом идемпотентен (re-bootstrap).
    expect(() =>
      configureEntities([ScopeShared], {
        executor: createMockExecutor().executor,
        scope: first,
      }),
    ).not.toThrow();
  });

  it('releaseOrmScope освобождает сущности для другой конфигурации', () => {
    const first = createOrmScope('first-release');
    configureEntities([ScopeShared], {
      executor: createMockExecutor().executor,
      scope: first,
    });

    releaseOrmScope(first);
    expect(getEntityOrmScope(ScopeShared)).toBeUndefined();

    const second = createOrmScope('second-release');
    expect(() =>
      configureEntities([ScopeShared], {
        executor: createMockExecutor().executor,
        scope: second,
      }),
    ).not.toThrow();
    expect(getEntityOrmScope(ScopeShared)).toBe(second);
  });

  it('два скоупа изолированы: каждая сущность ходит в свой executor', async () => {
    const a = createMockExecutor();
    const b = createMockExecutor();
    configureEntities([ScopeUserA], { executor: a.executor });
    configureEntities([ScopeUserB], {
      executor: b.executor,
      scope: createOrmScope('analytics'),
    });

    await ScopeUserA.find({ uuid: '00000000-0000-0000-0000-000000000001' });
    await ScopeUserB.find({ uuid: '00000000-0000-0000-0000-000000000002' });

    expect(a.queries).toHaveLength(1);
    expect(b.queries).toHaveLength(1);
    expect(a.queries[0].sql).toContain('scope_users_a');
    expect(b.queries[0].sql).toContain('scope_users_b');
  });

  it('скоуп без transactions наследует процессно-глобальные настройки', () => {
    const scope = createOrmScope('no-tx-settings');
    expect(scope.transactions).toBeUndefined();
    configureEntities([ScopeUserA], {
      executor: createMockExecutor().executor,
      scope,
    });
    expect(getEntityRuntime(ScopeUserA).transactions).toBeUndefined();
  });

  it('warnOutsideTransaction — per-scope, а не глобально', () => {
    const warnScope = createOrmScope('warn-scope', {
      transactions: { warnOutsideTransaction: true },
    });
    const quietScope = createOrmScope('quiet-scope', {
      transactions: { warnOutsideTransaction: false },
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = createMockExecutor().executor;
      resolveOperationExecutor(undefined, db, 'A', warnScope.transactions);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      resolveOperationExecutor(undefined, db, 'B', quietScope.transactions);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('YdbTransactionManager: ambient из настроек конфигурации, не процесса', async () => {
    configureTransactionContext({ ambient: false });

    const db = createScriptedExecutor();
    const manager = new YdbTransactionManager(db.executor, { ambient: true });
    const baseExecutor = createMockExecutor().executor;

    await manager.runInTransaction((trx) => {
      expect(getActiveTransaction()?.ambient).toBe(true);
      // Операция без явного { trx } присоединяется к ambient-транзакции
      // этой конфигурации, хотя глобально ambient выключен.
      expect(resolveOperationExecutor(undefined, baseExecutor, 'E')).toBe(trx);
      return Promise.resolve();
    });

    db.assertComplete();
  });

  it('YdbTransactionManager без настроек — прежнее глобальное поведение', async () => {
    configureTransactionContext({ ambient: true });

    const db = createScriptedExecutor();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(() => {
      expect(getActiveTransaction()?.ambient).toBe(true);
      return Promise.resolve();
    });

    db.assertComplete();
  });

  it('createOrmScope требует непустое имя', () => {
    expect(() => createOrmScope('')).toThrow(/non-empty/);
  });
});
