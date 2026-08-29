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
import { YdbEncrypted } from '../src/decorators/encryption.decorator.js';
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

/** Сущность без PK — невалидна для конфигурации. */
@YdbEntity('scope_no_pk')
class ScopeNoPk extends YdbBaseEntity {
  @YdbColumn('Utf8')
  name!: string;
}

/** Сущность с @YdbEncrypted без провайдера шифрования — невалидна. */
@YdbEntity('scope_encrypted')
class ScopeEncrypted extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid!: string;

  @YdbEncrypted({ blindIndex: true })
  secret?: string;
}

describe('ORM scopes: независимые конфигурации в одном процессе (#199)', () => {
  afterEach(() => {
    configureTransactionContext(undefined);
    // Освобождаем сущности этого файла от любых скоупов (включая дефолтный
    // синглон): каждый тест начинает с чистого владения.
    for (const entity of [
      ScopeUserA,
      ScopeUserB,
      ScopeShared,
      ScopeNoPk,
      ScopeEncrypted,
    ]) {
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

  // ---- Атомарность жизненного цикла владения сущностями (#199) ----

  it('не claim-ит сущности при ошибке валидации: невалидная в середине списка', () => {
    const scope = createOrmScope('atomic-validate-fail');
    const { executor } = createMockExecutor();

    // ScopeUserA — валидна, ScopeNoPk — невалидна (нет PK), ScopeShared — валидна
    expect(() =>
      configureEntities([ScopeUserA, ScopeNoPk, ScopeShared], {
        executor,
        scope,
      }),
    ).toThrow(/must declare at least one primary key/);

    // Ни одна сущность не должна остаться привязанной к скоупу
    expect(getEntityOrmScope(ScopeUserA)).toBeUndefined();
    expect(getEntityOrmScope(ScopeNoPk)).toBeUndefined();
    expect(getEntityOrmScope(ScopeShared)).toBeUndefined();
    expect(scope.entities.size).toBe(0);
  });

  it('не claim-ит сущности при ошибке валидации: невалидная в начале списка', () => {
    const scope = createOrmScope('atomic-validate-fail-start');
    const { executor } = createMockExecutor();

    expect(() =>
      configureEntities([ScopeNoPk, ScopeShared], {
        executor,
        scope,
      }),
    ).toThrow(/must declare at least one primary key/);

    expect(getEntityOrmScope(ScopeNoPk)).toBeUndefined();
    expect(getEntityOrmScope(ScopeShared)).toBeUndefined();
    expect(scope.entities.size).toBe(0);
  });

  it('не claim-ит сущности при ошибке валидации шифрования (без провайдера)', () => {
    const scope = createOrmScope('atomic-encrypted-fail');
    const { executor } = createMockExecutor();

    expect(() =>
      configureEntities([ScopeEncrypted], { executor, scope }),
    ).toThrow(/no encryptionProvider is configured/);

    expect(getEntityOrmScope(ScopeEncrypted)).toBeUndefined();
    expect(scope.entities.size).toBe(0);
  });

  it('после неудачной конфигурации сущность доступна для другой конфигурации', () => {
    const first = createOrmScope('atomic-retry-first');
    const second = createOrmScope('atomic-retry-second');
    const { executor } = createMockExecutor();

    // Первичная конфигурация с невалидной сущностью падает
    expect(() =>
      configureEntities([ScopeNoPk], { executor, scope: first }),
    ).toThrow(/must declare at least one primary key/);

    // Сущность не привязана ни к одному скоупу
    expect(getEntityOrmScope(ScopeNoPk)).toBeUndefined();

    // Теперь ScopeShared можно успешно сконфигурировать во втором скоупе
    expect(() =>
      configureEntities([ScopeShared], { executor, scope: second }),
    ).not.toThrow();
    expect(getEntityOrmScope(ScopeShared)).toBe(second);
  });

  it('успешная конфигурация claim-ит все сущности', () => {
    const scope = createOrmScope('atomic-success');
    const { executor } = createMockExecutor();

    configureEntities([ScopeUserA, ScopeUserB, ScopeShared], {
      executor,
      scope,
    });

    expect(getEntityOrmScope(ScopeUserA)).toBe(scope);
    expect(getEntityOrmScope(ScopeUserB)).toBe(scope);
    expect(getEntityOrmScope(ScopeShared)).toBe(scope);
    expect(scope.entities.size).toBe(3);
  });

  it('повторная конфигурация в том же скоупе идемпотентна (re-bootstrap)', () => {
    const scope = createOrmScope('atomic-idempotent');
    const first = createMockExecutor().executor;
    const second = createMockExecutor().executor;

    configureEntities([ScopeUserA], { executor: first, scope });
    expect(getEntityOrmScope(ScopeUserA)).toBe(scope);

    // Повторный бутстрап тем же скоупом — без ошибок
    expect(() =>
      configureEntities([ScopeUserA], { executor: second, scope }),
    ).not.toThrow();

    // Владение не изменилось
    expect(getEntityOrmScope(ScopeUserA)).toBe(scope);
    expect(scope.entities.size).toBe(1);
  });

  it('частичная конфигурация: валидная сущность в том же вызове с невалидной не claim-ится', () => {
    const scope = createOrmScope('atomic-mixed');
    const { executor } = createMockExecutor();

    expect(() =>
      configureEntities([ScopeUserA, ScopeNoPk], { executor, scope }),
    ).toThrow(/must declare at least one primary key/);

    // ScopeUserA не должна остаться claim-нутой
    expect(getEntityOrmScope(ScopeUserA)).toBeUndefined();
    expect(getEntityOrmScope(ScopeNoPk)).toBeUndefined();
    expect(scope.entities.size).toBe(0);
  });
});
