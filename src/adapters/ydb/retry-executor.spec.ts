import { describe, it, expect } from '@jest/globals';
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import { withRetryPolicy } from './retry-executor.js';
import type {
  YdbExecutor,
  YdbQuery,
  YdbTransactionOptions,
  YdbTransactionHandle,
} from '../../core/interfaces.js';
import type { YdbRetrySleepFn } from './retry.js';

/**
 * Интеграционные тесты подключения retry-политики к executor'у (#27):
 * политика реально вызывается для операций executor'а, попытки не
 * перемножаются с внутренним ретраем SDK, классификация/отмена работают.
 */

function ydbErr(code: number): YDBError {
  return new YDBError(code, []);
}

function recordingSleep(): { sleep: YdbRetrySleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: YdbRetrySleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

/** Простой фейковый запрос: без событий SDK, поведение задаётся тестом. */
interface FakeQueryState {
  signals: Array<AbortSignal | undefined>;
  paramsList: Array<Record<string, unknown>>;
}

function makeSimpleFlakyExecutor(
  script: Array<'fail-aborted' | 'ok'>,
  state: FakeQueryState,
): YdbExecutor {
  let call = 0;
  const executor = ((
    strings: TemplateStringsArray,
    ...args: any[]
  ): YdbQuery => {
    const idx = Math.min(call, script.length - 1);
    const outcome = script[idx];
    call += 1;

    const recorded: Record<string, unknown> = {};
    let signal: AbortSignal | undefined;
    void strings;
    void args;
    const query: any = {
      parameter(name: string, value: unknown) {
        recorded[name] = value;
        return query;
      },
      timeout() {
        return query;
      },
      signal(s: AbortSignal) {
        signal = s;
        return query;
      },
      cancel() {
        return query;
      },
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        state.signals.push(signal);
        state.paramsList.push(recorded);
        const result =
          outcome === 'ok'
            ? Promise.resolve([[{ id: 'x' }]])
            : Promise.reject(ydbErr(Code.ABORTED));
        return result.then(onFulfilled, onRejected);
      },
    };
    return query;
  }) as unknown as YdbExecutor;

  return executor;
}

describe("withRetryPolicy(): политика вызывается через операции executor'а", () => {
  it('выключенная политика возвращает executor как есть (#98 не меняется)', () => {
    const base = makeSimpleFlakyExecutor(['ok'], {
      signals: [],
      paramsList: [],
    });
    expect(withRetryPolicy(base, false)).toBe(base);
    expect(withRetryPolicy(base, undefined)).toBe(base);
  });

  it('транзитные ошибки ретраятся: три исполнения, параметры воспроизводятся', async () => {
    const { sleep, delays } = recordingSleep();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    // fail, fail, ok — и далее ok (на случай лишних попыток)
    const base = makeSimpleFlakyExecutor(
      ['fail-aborted', 'fail-aborted', 'ok'],
      state,
    );
    const wrapped = withRetryPolicy(base, {
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    const rows = await wrapped`SELECT * FROM users WHERE id = ${'u1'}`
      .parameter(':p1', 'v1')
      .idempotent(true);

    expect(rows).toEqual([[{ id: 'x' }]]);
    expect(state.paramsList).toHaveLength(3);
    // Параметры билдера воспроизводятся на каждой попытке политики:
    for (const params of state.paramsList) {
      expect(params).toEqual({ ':p1': 'v1' });
    }
    // Задержки политики: 100 -> 200 (дефолты, jitter выключен).
    expect(delays).toEqual([100, 200]);
  });

  it('детерминированная ошибка не ретрается — одно исполнение', async () => {
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.BAD_REQUEST);
    let calls = 0;
    const base = ((strings: TemplateStringsArray): YdbQuery => {
      void strings;
      calls += 1;
      const query: any = {
        parameter() {
          return query;
        },
        timeout() {
          return query;
        },
        signal() {
          return query;
        },
        cancel() {
          return query;
        },
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.reject(boom).then(onFulfilled, onRejected);
        },
      };
      return query;
    }) as unknown as YdbExecutor;

    await expect(withRetryPolicy(base, { sleep })`SELECT 1`).rejects.toBe(boom);
    expect(calls).toBe(1);
  });

  it('исчерпание maxAttempts: ровно N исполнений, последняя ошибка как есть', async () => {
    const { sleep } = recordingSleep();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['fail-aborted'], state);

    const last = new Error('last');
    // Подменить последнюю ошибку нельзя (скрипт всегда abort) — проверяем
    // число исполнений: ровно maxAttempts, без умножения.
    await expect(
      withRetryPolicy(base, { maxAttempts: 4, sleep })`SELECT 1`.idempotent(
        true,
      ),
    ).rejects.toBeInstanceOf(YDBError);
    expect(state.signals).toHaveLength(4);
    void last;
  });
});

describe('withRetryPolicy(): отмена и сигналы попытки', () => {
  function honoringSleep(): { sleep: YdbRetrySleepFn } {
    const sleep: YdbRetrySleepFn = (_ms, signal) => {
      if (signal?.aborted) {
        const reason = signal.reason;
        return Promise.reject(
          reason instanceof Error ? reason : new Error('aborted'),
        );
      }
      return Promise.resolve();
    };
    return { sleep };
  }

  it('сигнал пользователя доходит до каждой попытки запроса', async () => {
    const { sleep } = honoringSleep();
    const controller = new AbortController();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['ok'], state);
    const wrapped = withRetryPolicy(base, { sleep });

    await wrapped`SELECT 1`.signal(controller.signal);

    // Единственная попытка получила связанный сигнал попытки политики:
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0]).toBeInstanceOf(AbortSignal);
    expect(controller.signal.aborted).toBe(false);
  });

  it('отмена во время backoff останавливает операцию с причиной отмены', async () => {
    const { sleep } = honoringSleep();
    const controller = new AbortController();
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['fail-aborted'], state);

    let pendingReject: unknown;
    const pending = Promise.resolve(
      withRetryPolicy(base, {
        maxAttempts: 5,
        jitterRatio: 0,
        rng: () => 0,
        sleep,
        signal: controller.signal,
        onRetry: () => controller.abort(new Error('stop-after-first-attempt')),
      })`SELECT 1`.idempotent(true),
    );
    pending.catch((error: unknown) => {
      pendingReject = error;
    });

    await expect(pending).rejects.toMatchObject({
      message: 'stop-after-first-attempt',
    });
    void pendingReject;
    // Ровно одна попытка БД: отмена запретила вторую.
    expect(state.signals).toHaveLength(1);
  });

  it('уже отменённый сигнал политики — ни одного обращения к БД', async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const state: FakeQueryState = { signals: [], paramsList: [] };
    const base = makeSimpleFlakyExecutor(['ok'], state);
    const wrapped = withRetryPolicy(base, {
      sleep,
      signal: controller.signal,
    });

    await expect(wrapped`SELECT 1`.idempotent(true)).rejects.toBeInstanceOf(
      Error,
    );
    expect(state.signals).toHaveLength(0);
  });
});

describe('withRetryPolicy(): гашение внутреннего ретрая SDK (событие retry)', () => {
  /**
   * Имитация SDK-запроса (@ydbjs/query): внутренний цикл хочет повторять
   * транзитную ошибку бесконечно; событие 'retry' эмитится после задержки,
   * следующая попытка начинается с throwIfAborted на сигнале запроса.
   */
  function makeSdkLikeExecutor(options: {
    failuresBeforeSuccess: number;
    executions: number[];
  }): YdbExecutor {
    let failureCount = 0;
    const executor = ((_strings: TemplateStringsArray): YdbQuery => {
      const listeners: Array<(ctx: unknown) => void> = [];
      let signal: AbortSignal | undefined;
      const query: any = {
        parameter() {
          return query;
        },
        timeout() {
          return query;
        },
        signal(s: AbortSignal) {
          signal = s;
          return query;
        },
        cancel() {
          return query;
        },
        on(event: string, listener: (ctx: unknown) => void) {
          if (event === 'retry') listeners.push(listener);
          return query;
        },
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve()
            .then((): unknown => {
              if (signal?.aborted) {
                const abortError = new Error('The operation was aborted');
                abortError.name = 'AbortError';
                throw abortError;
              }
              if (failureCount < options.failuresBeforeSuccess) {
                failureCount += 1;
                options.executions.push(failureCount);
                const boom = ydbErr(Code.ABORTED);
                // SDK-стратегия решает повторить: событие после задержки.
                for (const listener of listeners) {
                  listener({ attempt: failureCount, error: boom });
                }
                // Политика отменила сигнал — следующей попытки не будет:
                if (signal?.aborted) {
                  const abortError = new Error('The operation was aborted');
                  abortError.name = 'AbortError';
                  throw abortError;
                }
                throw boom;
              }
              options.executions.push(failureCount + 1);
              return [[{ done: true }]];
            })
            .then(onFulfilled, onRejected);
        },
      };
      return query;
    }) as unknown as YdbExecutor;
    return executor;
  }

  it('одна попытка политики = одна попытка SDK: попытки НЕ перемножаются', async () => {
    const { sleep } = recordingSleep();
    const executions: number[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 2,
      executions,
    });
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 5,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    await expect(wrapped`SELECT 1`.idempotent(true)).resolves.toEqual([
      [{ done: true }],
    ]);
    // Две транзитные неудачи + успех = РОВНО 3 обращения к БД. Внутренний
    // цикл SDK (неограниченный бюджет) погашен политикой: без гашения
    // каждая попытка политики уходила бы в бесконечный цикл SDK.
    expect(executions).toEqual([1, 2, 3]);
  });

  it('исходная ошибка доходит до политики, а не AbortError от отмены', async () => {
    const { sleep } = recordingSleep();
    const executions: number[] = [];
    const base = makeSdkLikeExecutor({ failuresBeforeSuccess: 1, executions });
    const seenErrors: unknown[] = [];
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 2,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
      onRetry: (ctx) => {
        seenErrors.push(ctx.error);
      },
    });

    await expect(wrapped`SELECT 1`.idempotent(true)).resolves.toEqual([
      [{ done: true }],
    ]);
    // Политика увидела именно YDBError ABORTED, а не AbortError подмены:
    expect(seenErrors).toHaveLength(1);
    expect(seenErrors[0]).toBeInstanceOf(YDBError);
  });
});

describe('withRetryPolicy(): transaction() пробрасывается как есть', () => {
  it('хэндл транзакции не оборачивается политикой', async () => {
    const openedOptions: YdbTransactionOptions[] = [];
    const handle: YdbTransactionHandle = {
      execute: async (fn) =>
        fn((() => {}) as unknown as YdbExecutor, undefined),
    };
    const base = ((_strings: TemplateStringsArray): YdbQuery => {
      throw new Error('should not be called');
    }) as unknown as YdbExecutor;
    (base as unknown as Record<string, unknown>).transaction = (
      options?: YdbTransactionOptions,
    ) => {
      openedOptions.push(options ?? {});
      return handle;
    };

    const wrapped = withRetryPolicy(base, { maxAttempts: 3 });
    await wrapped.transaction({ idempotent: true }).execute((trx) => {
      void trx;
      return Promise.resolve('tx');
    });

    expect(openedOptions).toEqual([{ idempotent: true }]);
  });
});

describe('withRetryPolicy(): правило идемпотентности (#27, fail-safe)', () => {
  /**
   * SDK-подобный запрос с внутренним «бесконечным» циклом повтора
   * (как @ydbjs/query): всегда-повторяемые статусы ретраются независимо
   * от пометки idempotent, событие 'retry' эмитится после каждой неудачи,
   * следующая попытка выполняется только при живом сигнале.
   * realExecutions — счётчик РЕАЛЬНЫХ обращений к БД.
   */
  function makeSdkLikeExecutor(options: {
    failuresBeforeSuccess: number;
    statusCodes: number[];
    realExecutions: number[];
    idempotentMarks: boolean[];
  }): YdbExecutor {
    let failures = 0;
    const executor = ((_strings: TemplateStringsArray): YdbQuery => {
      void _strings;
      const listeners: Array<(ctx: unknown) => void> = [];
      let signal: AbortSignal | undefined;
      const query: any = {
        parameter() {
          return query;
        },
        timeout() {
          return query;
        },
        signal(s: AbortSignal) {
          signal = s;
          return query;
        },
        idempotent(flag?: boolean) {
          options.idempotentMarks.push(flag !== false);
          return query;
        },
        cancel() {
          return query;
        },
        on(event: string, listener: (ctx: unknown) => void) {
          if (event === 'retry') listeners.push(listener);
          return query;
        },
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve()
            .then((): unknown => {
              if (signal?.aborted) {
                const abortError = new Error('The operation was aborted');
                abortError.name = 'AbortError';
                throw abortError;
              }
              if (failures < options.failuresBeforeSuccess) {
                const code =
                  options.statusCodes[
                    Math.min(failures, options.statusCodes.length - 1)
                  ];
                failures += 1;
                options.realExecutions.push(failures);
                const boom = new YDBError(code, []);
                for (const listener of listeners) {
                  listener({ attempt: failures, error: boom });
                }
                // Политика погасила внутренний цикл — следующей попытки нет:
                if (signal?.aborted) {
                  const abortError = new Error('The operation was aborted');
                  abortError.name = 'AbortError';
                  throw abortError;
                }
                throw boom;
              }
              options.realExecutions.push(failures + 1);
              return [[{ done: true }]];
            })
            .then(onFulfilled, onRejected);
        },
      };
      return query;
    }) as unknown as YdbExecutor;
    return executor;
  }

  const TRANSIENT = [Code.ABORTED, Code.UNAVAILABLE, Code.OVERLOADED];

  it('(1) непомеченный запрос + транзитная ошибка → ровно одна попытка БД', async () => {
    const { sleep } = recordingSleep();
    const realExecutions: number[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 50,
      statusCodes: TRANSIENT,
      realExecutions,
      idempotentMarks: [],
    });
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 3,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    await expect(wrapped`UPSERT users SET ...`).rejects.toBeInstanceOf(
      YDBError,
    );
    // Внутренний цикл SDK хочет повторять бесконечно — политика гасит его:
    // РОВНО одно обращение к БД, повтор записи невозможен.
    expect(realExecutions).toHaveLength(1);
  });

  it('(2) помеченный idempotent запрос ретраится до maxAttempts', async () => {
    const { sleep } = recordingSleep();
    const realExecutions: number[] = [];
    const marks: boolean[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 2,
      statusCodes: TRANSIENT,
      realExecutions,
      idempotentMarks: marks,
    });
    const wrapped = withRetryPolicy(base, {
      maxAttempts: 3,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });

    await expect(
      wrapped`SELECT * FROM users`.idempotent(true),
    ).resolves.toEqual([[{ done: true }]]);
    expect(realExecutions).toEqual([1, 2, 3]);
    // Пометка проброшена в SDK-запрос на каждой попытке:
    expect(marks).toEqual([true, true, true]);
  });

  it('(3) непомеченная запись не ретраится ни при одном из транзитных статусов', async () => {
    for (const code of TRANSIENT) {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: 5,
        statusCodes: [code],
        realExecutions,
        idempotentMarks: [],
      });
      const wrapped = withRetryPolicy(base, { maxAttempts: 3, sleep });

      await expect(wrapped`INSERT INTO t ...`).rejects.toBeInstanceOf(YDBError);
      expect(realExecutions).toHaveLength(1);
    }
  });

  it('(4) помеченный запрос ретрается при каждом из транзитных статусов', async () => {
    for (const code of TRANSIENT) {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: 1,
        statusCodes: [code],
        realExecutions,
        idempotentMarks: [],
      });
      const wrapped = withRetryPolicy(base, { maxAttempts: 2, sleep });

      await expect(wrapped`SELECT 1`.idempotent(true)).resolves.toEqual([
        [{ done: true }],
      ]);
      expect(realExecutions).toHaveLength(2);
    }
  });

  it('(5) попытки политики и SDK не перемножаются в обе стороны', async () => {
    // a) непомеченный: один реальный вызов при «вечном» желании SDK повторять.
    {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: Number.POSITIVE_INFINITY,
        statusCodes: [Code.ABORTED],
        realExecutions,
        idempotentMarks: [],
      });
      await expect(
        withRetryPolicy(base, { maxAttempts: 10, sleep })`UPDATE t SET x = 1`,
      ).rejects.toBeInstanceOf(YDBError);
      expect(realExecutions).toHaveLength(1);
    }
    // b) помеченный: исчерпание ровно на maxAttempts, без лишних попыток SDK.
    {
      const { sleep } = recordingSleep();
      const realExecutions: number[] = [];
      const base = makeSdkLikeExecutor({
        failuresBeforeSuccess: 5,
        statusCodes: [Code.ABORTED],
        realExecutions,
        idempotentMarks: [],
      });
      const wrapped = withRetryPolicy(base, {
        maxAttempts: 3,
        jitterRatio: 0,
        rng: () => 0,
        sleep,
      });
      await expect(
        wrapped`DELETE FROM t ...`.idempotent(true),
      ).rejects.toBeInstanceOf(YDBError);
      expect(realExecutions).toHaveLength(3);
    }
  });

  it('.idempotent(false)/без пометки — одно исполнение; пометка доходит до SDK', async () => {
    const { sleep } = recordingSleep();
    const marks: boolean[] = [];
    const realExecutions: number[] = [];
    const base = makeSdkLikeExecutor({
      failuresBeforeSuccess: 3,
      statusCodes: TRANSIENT,
      realExecutions,
      idempotentMarks: marks,
    });

    await expect(
      withRetryPolicy(base, { maxAttempts: 5, sleep })`SELECT 1`.idempotent(
        false,
      ),
    ).rejects.toBeInstanceOf(YDBError);
    expect(realExecutions).toHaveLength(1);

    // Успешный помеченный запрос: флаг дошёл до SDK-запроса.
    const okBase = makeSdkLikeExecutor({
      failuresBeforeSuccess: 0,
      statusCodes: TRANSIENT,
      realExecutions: [],
      idempotentMarks: marks,
    });
    await withRetryPolicy(okBase, { sleep })`SELECT 2`.idempotent(true);
    expect(marks).toContain(true);
  });
});
