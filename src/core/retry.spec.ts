import { describe, it, expect, jest } from '@jest/globals';
import { CommitError, YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import {
  classifyYdbError,
  computeRetryDelayMs,
  isTransientYdbError,
  runWithRetry,
  validateYdbRetryPolicyOptions,
  DEFAULT_YDB_RETRY_POLICY_OPTIONS,
  TRANSIENT_YDB_STATUSES,
} from './retry.js';
import type { YdbRetrySleepFn } from './retry.js';
import type { YdbExecutor } from '../core/interfaces.js';

/**
 * Юнит-тесты retry-политики по типу ошибки (#27): классификация строго по
 * структурным статусам YDB, ограничение попыток, bounded exponential
 * backoff + jitter, отмена через AbortSignal и отсутствие скрытого
 * ретрая вокруг транзакций (#98). Все задержки инъецируются — реальных
 * снов нет, тесты детерминированы.
 */

/** YDB-ошибка с заданным статус-кодом (структурная классификация). */
function ydbErr(code: number): YDBError {
  return new YDBError(code, []);
}

/** Записывающая задержка: вместо сна копит вычисленные задержки. */
function recordingSleep(): { sleep: YdbRetrySleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: YdbRetrySleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

/** Детерминированный rng: отдаёт значения из очереди по кругу. */
function seqRng(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('classifyYdbError(): классификация по статус-кодам (#27)', () => {
  it('только ABORTED/UNAVAILABLE/OVERLOADED — transient', () => {
    expect([...TRANSIENT_YDB_STATUSES].sort((a, b) => a - b)).toEqual(
      [Code.ABORTED, Code.UNAVAILABLE, Code.OVERLOADED].sort((a, b) => a - b),
    );
    expect(classifyYdbError(ydbErr(Code.ABORTED))).toBe('transient');
    expect(classifyYdbError(ydbErr(Code.UNAVAILABLE))).toBe('transient');
    expect(classifyYdbError(ydbErr(Code.OVERLOADED))).toBe('transient');
    expect(isTransientYdbError(ydbErr(Code.OVERLOADED))).toBe(true);
  });

  it('статусы, которые SDK ретраит, политикой НЕ ретраются (политика строже)', () => {
    // BAD_SESSION/SESSION_BUSY SDK всегда повторяет внутри себя — ORM-политика
    // не должна дублировать это; иначе попытки перемножаются.
    expect(classifyYdbError(ydbErr(Code.BAD_SESSION))).toBe('fatal');
    expect(classifyYdbError(ydbErr(Code.SESSION_BUSY))).toBe('fatal');
    // Условно-retryable у SDK — для политики fatal:
    expect(classifyYdbError(ydbErr(Code.SESSION_EXPIRED))).toBe('fatal');
    expect(classifyYdbError(ydbErr(Code.UNDETERMINED))).toBe('fatal');
    expect(classifyYdbError(ydbErr(Code.TIMEOUT))).toBe('fatal');
  });

  it('детерминированные ошибки приложения/схемы/запроса — fatal', () => {
    const deterministic = [
      Code.BAD_REQUEST,
      Code.UNAUTHORIZED,
      Code.INTERNAL_ERROR,
      Code.SCHEME_ERROR,
      Code.GENERIC_ERROR,
      Code.PRECONDITION_FAILED,
      Code.ALREADY_EXISTS,
      Code.NOT_FOUND,
      Code.UNSUPPORTED,
      Code.EXTERNAL_ERROR,
      Code.CANCELLED,
    ];
    for (const code of deterministic) {
      expect(classifyYdbError(ydbErr(code))).toBe('fatal');
    }
  });

  it('CommitError раскрывается в причину (структурно, без текста)', () => {
    expect(
      classifyYdbError(new CommitError('commit failed', ydbErr(Code.ABORTED))),
    ).toBe('transient');
    expect(
      classifyYdbError(
        new CommitError('commit failed', ydbErr(Code.SCHEME_ERROR)),
      ),
    ).toBe('fatal');
    expect(classifyYdbError(new CommitError('commit failed'))).toBe('fatal');
  });

  it('всё не-YDB (прикладные ошибки, отмены) — fatal', () => {
    const named = (name: string): Error =>
      Object.assign(new Error(name), { name });

    expect(classifyYdbError(new Error('application error'))).toBe('fatal');
    expect(classifyYdbError(new TypeError('x is not a function'))).toBe(
      'fatal',
    );
    expect(classifyYdbError('thrown string')).toBe('fatal');
    expect(classifyYdbError(undefined)).toBe('fatal');
    expect(classifyYdbError(named('AbortError'))).toBe('fatal');
    expect(classifyYdbError(named('TimeoutError'))).toBe('fatal');
  });
});

describe('computeRetryDelayMs(): bounded exponential backoff + jitter', () => {
  it('экспоненциальный рост без jitter: base, 2*base, 4*base...', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0 };
    expect(computeRetryDelayMs(1, opts, seqRng([0]))).toBe(100);
    expect(computeRetryDelayMs(2, opts, seqRng([0]))).toBe(200);
    expect(computeRetryDelayMs(3, opts, seqRng([0]))).toBe(400);
    expect(computeRetryDelayMs(4, opts, seqRng([0]))).toBe(800);
  });

  it('рост ограничен maxDelayMs (bounded)', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 2500, jitterRatio: 0 };
    expect(computeRetryDelayMs(1, opts, seqRng([0]))).toBe(1000);
    expect(computeRetryDelayMs(2, opts, seqRng([0]))).toBe(2000);
    expect(computeRetryDelayMs(3, opts, seqRng([0]))).toBe(2500);
    expect(computeRetryDelayMs(10, opts, seqRng([0]))).toBe(2500);
  });

  it('jitter сжимает задержку вниз в [(1-r)*raw, raw]', () => {
    const opts = { baseDelayMs: 200, maxDelayMs: 10_000, jitterRatio: 0.5 };
    expect(computeRetryDelayMs(1, opts, seqRng([0]))).toBe(100); // нижняя граница
    expect(computeRetryDelayMs(1, opts, seqRng([0.999999]))).toBe(200); // верхняя
    expect(computeRetryDelayMs(1, opts, seqRng([0.5]))).toBe(150);
  });

  it('jitter никогда не превышает raw и maxDelayMs', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 300, jitterRatio: 1 };
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const delay = computeRetryDelayMs(attempt, opts, seqRng([0.99]));
      expect(delay).toBeLessThanOrEqual(
        Math.min(100 * 2 ** (attempt - 1), 300),
      );
    }
  });

  it('без опций используются дефолты политики', () => {
    // Дефолты: base 100, jitterRatio 0.25; rng -> 0 даёт нижнюю границу
    // коридора джиттера: round(100 * (1 - 0.25)) = 75.
    expect(computeRetryDelayMs(1, undefined, seqRng([0]))).toBe(75);
  });
});

describe('validateYdbRetryPolicyOptions(): fail-fast валидация', () => {
  it('undefined и корректные опции проходят', () => {
    expect(() => validateYdbRetryPolicyOptions(undefined)).not.toThrow();
    const signal = new AbortController().signal;
    expect(() =>
      validateYdbRetryPolicyOptions({
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitterRatio: 0.5,
        signal,
        onRetry: () => {},
        shouldRetry: () => true,
        sleep: () => Promise.resolve(),
        rng: () => 0,
      }),
    ).not.toThrow();
  });

  it('невалидные значения отклоняются сразу', async () => {
    expect(() => validateYdbRetryPolicyOptions(null as never)).toThrow();
    expect(() => validateYdbRetryPolicyOptions(42 as never)).toThrow();
    expect(() => validateYdbRetryPolicyOptions({ maxAttempts: 0 })).toThrow(
      /maxAttempts/,
    );
    expect(() => validateYdbRetryPolicyOptions({ maxAttempts: 2.5 })).toThrow(
      /maxAttempts/,
    );
    expect(() =>
      validateYdbRetryPolicyOptions({ maxAttempts: Number.NaN }),
    ).toThrow(/maxAttempts/);
    expect(() => validateYdbRetryPolicyOptions({ baseDelayMs: 0 })).toThrow(
      /baseDelayMs/,
    );
    expect(() => validateYdbRetryPolicyOptions({ baseDelayMs: -1 })).toThrow(
      /baseDelayMs/,
    );
    expect(() => validateYdbRetryPolicyOptions({ maxDelayMs: 0 })).toThrow(
      /maxDelayMs/,
    );
    expect(() => validateYdbRetryPolicyOptions({ jitterRatio: -0.1 })).toThrow(
      /jitterRatio/,
    );
    expect(() => validateYdbRetryPolicyOptions({ jitterRatio: 1.5 })).toThrow(
      /jitterRatio/,
    );
    expect(() =>
      validateYdbRetryPolicyOptions({ signal: 'nope' as never }),
    ).toThrow(/signal/);
    expect(() =>
      validateYdbRetryPolicyOptions({ onRetry: 'nope' as never }),
    ).toThrow(/onRetry/);
    // runWithRetry валидирует опции до первой попытки:
    await expect(
      runWithRetry(() => Promise.resolve(1), { maxAttempts: 0 }),
    ).rejects.toThrow(/maxAttempts/);
  });
});

describe('runWithRetry(): повторы только транзитных ошибок (#27)', () => {
  it('успех с первой попытки — fn вызвана один раз', async () => {
    const { sleep, delays } = recordingSleep();
    const fn = jest.fn(() => Promise.resolve('ok'));

    await expect(runWithRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('транзитная ошибка, затем успех — ровно один повтор', async () => {
    const { sleep, delays } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(boom) : Promise.resolve('recovered');
    });

    await expect(
      runWithRetry(fn, { sleep, jitterRatio: 0, rng: seqRng([0]) }),
    ).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    // Дефолтная база 100 мс, jitter выключен явно:
    expect(delays).toEqual([DEFAULT_YDB_RETRY_POLICY_OPTIONS.baseDelayMs]);
  });

  it('детерминированная/прикладная ошибка пробрасывается немедленно', async () => {
    const { sleep, delays } = recordingSleep();

    for (const error of [
      ydbErr(Code.BAD_REQUEST),
      ydbErr(Code.SCHEME_ERROR),
      new Error('app'),
    ]) {
      const fn = jest.fn(() => Promise.reject(error));
      await expect(runWithRetry(fn, { sleep })).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(delays).toEqual([]);
  });

  it('исчерпание попыток пробрасывает ПОСЛЕДНЮЮ ошибку как есть', async () => {
    const { sleep } = recordingSleep();
    // Все три ошибки транзитные — иначе политика остановится раньше на фатальной.
    const errors = [
      ydbErr(Code.OVERLOADED),
      ydbErr(Code.UNAVAILABLE),
      ydbErr(Code.ABORTED),
    ];
    let calls = 0;
    const fn = jest.fn(() => Promise.reject(errors[calls++]));

    await expect(runWithRetry(fn, { maxAttempts: 3, sleep })).rejects.toBe(
      errors[2],
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('maxAttempts: 1 — одна попытка без задержек даже для транзитной ошибки', async () => {
    const { sleep, delays } = recordingSleep();
    const boom = ydbErr(Code.UNAVAILABLE);
    const fn = jest.fn(() => Promise.reject(boom));

    await expect(runWithRetry(fn, { maxAttempts: 1, sleep })).rejects.toBe(
      boom,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});

describe('runWithRetry(): детерминированный backoff и хуки', () => {
  it('последовательность задержек: экспонента с учётом cap и jitter', async () => {
    const { sleep, delays } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    const fn = jest.fn(() => Promise.reject(boom));

    await expect(
      runWithRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 250,
        jitterRatio: 0,
        rng: seqRng([0]),
        sleep,
      }),
    ).rejects.toBe(boom);

    // Попытки 1..4, повторы после 1..3: 100 -> 200 -> 250(cap)
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([100, 200, 250]);
  });

  it('onRetry вызывается перед каждым повтором с контекстом попытки', async () => {
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(boom) : Promise.resolve('done');
    });
    const onRetry = jest.fn<
      (ctx: { attempt: number; error: unknown; delayMs: number }) => void
    >(() => {});

    await expect(
      runWithRetry(fn, {
        baseDelayMs: 50,
        jitterRatio: 0,
        rng: seqRng([0]),
        sleep,
        onRetry,
      }),
    ).resolves.toBe('done');

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      error: boom,
      delayMs: 50,
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      error: boom,
      delayMs: 100,
    });
  });

  it('onRetry не вызывается при фатальной ошибке и при исчерпании', async () => {
    const { sleep } = recordingSleep();
    const fatal = new Error('deterministic');
    const onRetry = jest.fn<() => void>(() => {});

    await expect(
      runWithRetry(() => Promise.reject(fatal), { sleep, onRetry }),
    ).rejects.toBe(fatal);

    await expect(
      runWithRetry(() => Promise.reject(ydbErr(Code.ABORTED)), {
        sleep,
        onRetry,
        maxAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(YDBError);

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('кастомный shouldRetry замещает классификацию по умолчанию', async () => {
    const { sleep, delays } = recordingSleep();
    const appError = new Error('flaky infra wrapped as app error');
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(appError) : Promise.resolve('ok');
    });

    await expect(
      runWithRetry(fn, {
        sleep,
        shouldRetry: (error: unknown) => error === appError,
      }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays.length).toBe(1);

    // И наоборот: shouldRetry: () => false отключает повторы вовсе.
    const boom = ydbErr(Code.ABORTED);
    const strictFn = jest.fn(() => Promise.reject(boom));
    await expect(
      runWithRetry(strictFn, { sleep, shouldRetry: () => false }),
    ).rejects.toBe(boom);
    expect(strictFn).toHaveBeenCalledTimes(1);
  });
});

describe('runWithRetry(): отмена через AbortSignal', () => {
  it('уже отменённый сигнал — fn не вызывается, отклонение с причиной', async () => {
    const controller = new AbortController();
    const cancelReason = new Error('cancelled-before-start');
    controller.abort(cancelReason);
    const fn = jest.fn(() => Promise.resolve('never'));

    await expect(runWithRetry(fn, { signal: controller.signal })).rejects.toBe(
      cancelReason,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('не-Error причина отмены заворачивается в Error c исходником в cause', async () => {
    const controller = new AbortController();
    controller.abort('cancelled-with-string');
    const fn = jest.fn(() => Promise.resolve('never'));

    const rejected = runWithRetry(fn, { signal: controller.signal });
    await expect(rejected).rejects.toBeInstanceOf(Error);
    await rejected.catch((error: Error & { cause?: unknown }) => {
      expect(error.message).toContain('cancelled-with-string');
      expect(error.cause).toBe('cancelled-with-string');
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('отмена во время ожидания задержки прерывает pending retry', async () => {
    const controller = new AbortController();
    const cancelReason = new Error('cancelled-mid-backoff');
    let sleepCalls = 0;
    const sleep: YdbRetrySleepFn = (_ms, signal) => {
      sleepCalls += 1;
      controller.abort(cancelReason);
      void signal;
      return Promise.reject(cancelReason);
    };
    const boom = ydbErr(Code.OVERLOADED);
    const fn = jest.fn(() => Promise.reject(boom));
    const onRetry = jest.fn<() => void>(() => {});

    await expect(
      runWithRetry(fn, { signal: controller.signal, sleep, onRetry }),
    ).rejects.toBe(cancelReason);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('отмена между попытками запрещает старт следующей', async () => {
    const controller = new AbortController();
    const cancelReason = new Error('stopped-after-first-failure');
    const { sleep } = recordingSleep();
    const boom = ydbErr(Code.ABORTED);
    let calls = 0;
    const fn = jest.fn(() => {
      calls += 1;
      if (calls === 1) {
        controller.abort(cancelReason);
        return Promise.reject(boom);
      }
      return Promise.resolve('no');
    });

    await expect(
      runWithRetry(fn, { signal: controller.signal, sleep }),
    ).rejects.toBe(cancelReason);
    expect(calls).toBe(1);
  });
});

describe('интеграция с транзакциями: без умножения попыток (#98 + #27)', () => {
  interface FakeTxCall {
    options: Record<string, unknown>;
  }

  /** Минимальный фейковый executor БД с управляемым поведением execute(). */
  function makeFakeDb(
    executeImpl: (
      fn: any,
      opts: any,
      trx: any,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {
    const transactions: FakeTxCall[] = [];
    const executor: any = jest.fn(() => ({
      parameter() {
        return this;
      },
      timeout() {
        return this;
      },
      signal() {
        return this;
      },
      cancel() {
        return this;
      },
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    }));
    executor.transaction = (options?: Record<string, unknown>) => {
      transactions.push({ options: options ?? {} });
      const trx: any = jest.fn(() => ({
        parameter() {
          return this;
        },
        timeout() {
          return this;
        },
        signal() {
          return this;
        },
        cancel() {
          return this;
        },
        then(
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve([]).then(onFulfilled, onRejected);
        },
      }));
      const controller = new AbortController();
      return {
        execute: (fn: any) =>
          executeImpl(fn, options ?? {}, trx, controller.signal),
      };
    };
    return { executor: executor as unknown as YdbExecutor, transactions };
  }

  async function makeManager(dbExecutor: YdbExecutor) {
    const mod = await import('../transaction/transaction.manager.js');
    return new mod.YdbTransactionManager(dbExecutor);
  }

  it('runInTransaction НЕ имеет скрытого ORM-ретрая: транзитная ошибка выходит сразу', async () => {
    const boom = ydbErr(Code.ABORTED);
    let bodyCalls = 0;
    const db = makeFakeDb((_fn, _opts, _trx, _signal) => {
      bodyCalls += 1;
      return Promise.reject(boom);
    });

    const manager = await makeManager(db.executor);

    await expect(
      manager.runInTransaction(() => Promise.resolve('x')),
    ).rejects.toBe(boom);
    // Ровно одна попытка: ретраить тело транзакции — работа SDK (idempotent),
    // а не скрытая политика ORM.
    expect(bodyCalls).toBe(1);
    expect(db.transactions).toHaveLength(1);
  });

  it('явная композиция: runWithRetry ПОВЕРХ idempotent-транзакции дополняет SDK-ретрай', async () => {
    const boom = ydbErr(Code.UNAVAILABLE);
    let sdkAttempts = 0;

    // Имитация @ydbjs/query: ПЕРВАЯ попытка тела транзакции падает транзитной
    // ошибкой, SDK-idempotent-повтор (вторая попытка ВНУТРИ execute)
    // успешен — наружу транзитная ошибка не выходит.
    const db = makeFakeDb(
      async (fn: any, opts: any, trx: any, signal: AbortSignal) => {
        for (;;) {
          sdkAttempts += 1;
          try {
            if (sdkAttempts === 1 && opts.idempotent) throw boom;
            return await fn(trx, signal);
          } catch (error) {
            if (error === boom && sdkAttempts < 2) continue; // SDK ретраит сам
            throw error;
          }
        }
      },
    );

    const manager = await makeManager(db.executor);

    const outerFn = jest.fn(() =>
      manager.runInTransaction(() => Promise.resolve('inner'), {
        idempotent: true,
      }),
    );

    // Внешний ретрай срабатывает нулевой раз: транзитная ошибка поглощена
    // SDK-idempotent-повтором ВНУТРИ, политика наружу её не видит.
    await expect(runWithRetry(outerFn, { maxAttempts: 3 })).resolves.toBe(
      'inner',
    );
    expect(outerFn).toHaveBeenCalledTimes(1);
    expect(sdkAttempts).toBe(2);
    expect(db.transactions[0].options).toMatchObject({ idempotent: true });
  });

  it('фатальная ошибка транзакции внешним ретраем не повторяется', async () => {
    const fatal = ydbErr(Code.BAD_REQUEST);
    const db = makeFakeDb(() => Promise.reject(fatal));
    const manager = await makeManager(db.executor);

    const outerFn = jest.fn(() =>
      manager.runInTransaction(() => Promise.resolve('x')),
    );
    await expect(runWithRetry(outerFn, { maxAttempts: 3 })).rejects.toBe(fatal);
    expect(outerFn).toHaveBeenCalledTimes(1);
  });
});
