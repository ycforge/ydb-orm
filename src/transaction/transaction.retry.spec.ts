import 'reflect-metadata';
import { describe, it, expect } from '@jest/globals';
import { CommitError, YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import { YdbTransactionManager } from './transaction.manager.js';
import type { YdbExecutor, YdbTransactionHandle } from '../core/interfaces.js';
import type { YdbRetrySleepFn } from '../core/retry.js';

/**
 * Интеграционные тесты retry-политики в runInTransaction() (#27):
 * политика реально применяется к исполнению транзакции, попытки НЕ
 * перемножаются с внутренним ретраем SDK, детерминированный приоритет
 * слоёв (политика задана — владеет повторами ORM; не задана — SDK).
 */

function ydbErr(code: number): YDBError {
  return new YDBError(code, []);
}

/** Статусы, которые внутренний предикат SDK считает всегда-повторяемыми. */
const SDK_ALWAYS_RETRYABLE = new Set([
  Code.ABORTED,
  Code.UNAVAILABLE,
  Code.OVERLOADED,
  Code.BAD_SESSION,
  Code.SESSION_BUSY,
]);

interface RecordedTx {
  options: Record<string, unknown>;
}

interface FakeDbResult {
  executor: YdbExecutor;
  transactions: RecordedTx[];
}

type BodyFn = (trx: YdbExecutor, signal?: AbortSignal) => Promise<unknown>;

/** Сценарий попытки: успех (ok) либо ошибка (Error-совместимая). */
interface ScriptedOutcome {
  ok?: unknown;
  error?: Error;
}

/**
 * Простейшая фейковая БД: одна попытка тела на execute(), без внутреннего
 * ретрая (как если бы SDK его не имел). Колбэк пользователя не вызывается:
 * исход ошибки полностью определяется сценарием.
 */
function makeSimpleDb(
  bodyScript: (invocation: number) => ScriptedOutcome,
): FakeDbResult & { bodyInvocations: () => number } {
  const transactions: RecordedTx[] = [];
  let bodyCalls = 0;
  const executor = (() => ({})) as unknown as YdbExecutor;
  (executor as unknown as Record<string, unknown>).transaction = (
    options?: Record<string, unknown>,
  ): YdbTransactionHandle => {
    transactions.push({ options: options ?? {} });
    const execute = (_fn: BodyFn): Promise<unknown> => {
      bodyCalls += 1;
      const outcome = bodyScript(bodyCalls);
      if (outcome.error !== undefined) throw outcome.error;
      return Promise.resolve(outcome.ok);
    };
    return { execute } as unknown as YdbTransactionHandle;
  };
  return { executor, transactions, bodyInvocations: () => bodyCalls };
}

/**
 * Фейковая БД с ВНУТРЕННИМ retry-циклом SDK (@ydbjs/query):
 * тело вызывается повторно для всегда-повторяемых статусов,
 * бюджет неограничен; неповторяемые ошибки заворачиваются
 * в Error('Transaction failed.', { cause }) — как в реальном SDK.
 */
function makeSdkLikeDb(): FakeDbResult & {
  bodyInvocations: () => number;
  executes: () => number;
} {
  const transactions: RecordedTx[] = [];
  let bodyCalls = 0;
  let executeCalls = 0;
  const trx: any = {};
  const executor = (() => ({})) as unknown as YdbExecutor;
  (executor as unknown as Record<string, unknown>).transaction = (
    options?: Record<string, unknown>,
  ): YdbTransactionHandle => {
    transactions.push({ options: options ?? {} });
    executeCalls += 1;
    const execute = (fn: BodyFn): Promise<unknown> => {
      bodyCalls += 1;
      return fn(trx as YdbExecutor, undefined).catch(
        (error: unknown): unknown => {
          const retryable =
            error instanceof YDBError && SDK_ALWAYS_RETRYABLE.has(error.code);
          if (!retryable) {
            throw new Error('Transaction failed.', { cause: error });
          }
          // SDK повторяет: новая «сессия», тот же колбэк.
          return execute(fn);
        },
      );
    };
    return { execute } as unknown as YdbTransactionHandle;
  };
  return {
    executor,
    transactions,
    bodyInvocations: () => bodyCalls,
    executes: () => executeCalls,
  };
}

function recordingSleep(): { sleep: YdbRetrySleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: YdbRetrySleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

describe('runInTransaction({ retry }): политика применяется к транзакции (#27)', () => {
  it('транзитные ошибки ретраятся: три открытия транзакции, задержки политики', async () => {
    const { sleep, delays } = recordingSleep();
    const db = makeSimpleDb((n) =>
      n < 3 ? { error: ydbErr(Code.ABORTED) } : { ok: 'done' },
    );
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { jitterRatio: 0, rng: () => 0, sleep },
      }),
    ).resolves.toBe('done');

    expect(db.transactions).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  it('опции транзакции (isolation/idempotent/signal) пробрасываются как раньше', async () => {
    const { sleep } = recordingSleep();
    const db = makeSimpleDb(() => ({ ok: 1 }));
    const manager = new YdbTransactionManager(db.executor);
    const controller = new AbortController();

    await manager.runInTransaction(() => Promise.resolve('x'), {
      isolation: 'snapshotReadWrite',
      idempotent: true,
      signal: controller.signal,
      retry: { sleep },
    });

    expect(db.transactions[0].options).toEqual({
      isolation: 'snapshotReadWrite',
      idempotent: true,
      signal: controller.signal,
    });
  });

  it('детерминированная ошибка — одна попытка, исходная ошибка как есть', async () => {
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.BAD_REQUEST);
    const db = makeSimpleDb(() => ({ error: boom }));
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { sleep },
      }),
    ).rejects.toBe(boom);
    expect(db.bodyInvocations()).toBe(1);
  });

  it('CommitError с транзитной причиной классифицируется и ретраится', async () => {
    const { sleep } = recordingSleep();
    let executes = 0;
    const executor = (() => ({})) as unknown as YdbExecutor;
    (executor as unknown as Record<string, unknown>).transaction =
      (): YdbTransactionHandle => {
        const execute = (): Promise<unknown> => {
          executes += 1;
          if (executes === 1) {
            // Ошибка коммита: статус ABORTED в причине (как отдаёт SDK).
            return Promise.reject(
              new CommitError(
                'Transaction commit failed.',
                ydbErr(Code.ABORTED),
              ),
            );
          }
          return Promise.resolve('committed');
        };
        return { execute } as unknown as YdbTransactionHandle;
      };

    const manager = new YdbTransactionManager(executor);
    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { jitterRatio: 0, rng: () => 0, sleep },
      }),
    ).resolves.toBe('committed');
    expect(executes).toBe(2);
  });

  it('свежее окно timeout на каждую попытку политики', async () => {
    const { sleep } = recordingSleep();
    const seenSignals: Array<AbortSignal | undefined> = [];
    // SDK-подобная БД вызывает колбэк пользователя (гасится политикой).
    const db = makeSdkLikeDb();
    const manager = new YdbTransactionManager(db.executor);

    let attempts = 0;
    await manager.runInTransaction(
      (_trx, signal) => {
        attempts += 1;
        seenSignals.push(signal);
        if (attempts === 1) throw ydbErr(Code.UNAVAILABLE);
        return Promise.resolve('ok');
      },
      { timeout: 60_000, retry: { jitterRatio: 0, rng: () => 0, sleep } },
    );

    expect(seenSignals).toHaveLength(2);
    // Каждая попытка получила СВЕЖЕЕ окно таймаута (новый инстанс сигнала):
    expect(seenSignals[0]).not.toBe(seenSignals[1]);
    expect(seenSignals[0]?.aborted).toBe(false);
    expect(seenSignals[1]?.aborted).toBe(false);
  });

  it('валидация: retry несовместим с reuse, невалидная форма отклоняется', async () => {
    const db = makeSimpleDb(() => ({ ok: 1 }));
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: true,
        reuse: true,
      }),
    ).rejects.toThrow(/reuse/);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: 'nope' as never,
      }),
    ).rejects.toThrow(/retry/);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { maxAttempts: 0 },
      }),
    ).rejects.toThrow(/maxAttempts/);
  });

  it('отмена: отменённый сигнал политики запрещает обращения к БД', async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const db = makeSimpleDb(() => ({ ok: 1 }));
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: { sleep, signal: controller.signal },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(db.transactions).toHaveLength(0);
  });

  it('отмена во время backoff останавливает повтор транзакции', async () => {
    const controller = new AbortController();
    const sleep: YdbRetrySleepFn = () => Promise.resolve();
    const db = makeSimpleDb((n) =>
      n === 1 ? { error: ydbErr(Code.OVERLOADED) } : { ok: 'late' },
    );
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x'), {
        retry: {
          maxAttempts: 5,
          jitterRatio: 0,
          rng: () => 0,
          sleep,
          signal: controller.signal,
          onRetry: () =>
            controller.abort(new Error('stop-after-first-tx-attempt')),
        },
      }),
    ).rejects.toMatchObject({ message: 'stop-after-first-tx-attempt' });
    expect(db.transactions).toHaveLength(1);
  });
});

describe('runInTransaction({ retry }): умножение попыток исключено', () => {
  it('внутренний цикл SDK гасится: ровно maxAttempts исполнений тела', async () => {
    const { sleep } = recordingSleep();
    // Тело ПАДАЕТ всегда — без гашения внутреннего неограниченного цикла SDK
    // операция никогда бы не завершилась; тест завершается = цикл погашен.
    const alwaysAbort = ydbErr(Code.ABORTED);
    const db = makeSdkLikeDb();
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.reject(alwaysAbort), {
        idempotent: true,
        retry: { maxAttempts: 3, jitterRatio: 0, rng: () => 0, sleep },
      }),
    ).rejects.toBe(alwaysAbort);

    // Ровно по одной РЕАЛЬНОЙ попытке тела на попытку политики (+ вытесненные
    // защитные вызовы, не доходящие до колбэка пользователя):
    expect(db.executes()).toBe(3);
    // Реальных исполнений колбэка — ровно maxAttempts:
    expect(db.bodyInvocations()).toBe(6);
  });

  it('успех после транзитной неудачи: одна попытка тела на попытку политики', async () => {
    const { sleep } = recordingSleep();
    // Тело падает транзитно при первом вызове — внутренний предикат SDK
    // захочет повторить, но защитный лимит политики передаёт управление ORM.
    const db = makeSdkLikeDb();
    const manager = new YdbTransactionManager(db.executor);

    let userCalls = 0;
    await expect(
      manager.runInTransaction(
        () => {
          userCalls += 1;
          return userCalls === 1
            ? Promise.reject(ydbErr(Code.ABORTED))
            : Promise.resolve('fine');
        },
        {
          idempotent: true,
          retry: { maxAttempts: 4, jitterRatio: 0, rng: () => 0, sleep },
        },
      ),
    ).resolves.toBe('fine');

    // Ровно две реальные попытки пользователя (неудача + успех после повтора
    // политики), каждая — в СВОЕЙ транзакции: попытки не перемножились.
    expect(userCalls).toBe(2);
    expect(db.executes()).toBe(2);
  });
});
