import 'reflect-metadata';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import {
  YdbTransactionManager,
  validateRunInTransactionOptions,
} from './transaction.manager.js';
import {
  configureTransactionContext,
  ensureExecutorIdentity,
  getActiveTransaction,
  getTransactionId,
  resolveOperationExecutor,
} from './transaction-context.js';
import { wrapExecutorWithLogging } from '../core/query-logger.js';
import type {
  YdbExecutor,
  YdbTransactionHandle,
  YdbTransactionOptions,
} from '../core/interfaces.js';

/**
 * Юнит-тесты менеджера транзакций (#98): валидация опций, проброс опций
 * в SDK-вызов, детекция вложенности, reuse, ambient-контекст, retry-
 * семантика. Сети нет — используется фейковый executor.
 */

interface RecordedTransaction {
  options: YdbTransactionOptions;
  trx: YdbExecutor;
}

interface FakeDb {
  executor: YdbExecutor;
  transactions: RecordedTransaction[];
  /** Сколько раз transaction() открывал транзакцию. */
  count(): number;
}

function makeFakeDb(
  opts: {
    /** Имитировать idempotent-retry SDK: колбэк execute вызывается N раз. */
    attemptsPerTransaction?: number;
  } = {},
): FakeDb {
  const transactions: RecordedTransaction[] = [];
  const attempts = opts.attemptsPerTransaction ?? 1;

  const makeQueryExecutor = (): any =>
    jest.fn((_strings: TemplateStringsArray) => ({
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

  const executor: any = makeQueryExecutor();
  executor.transaction = (
    options?: YdbTransactionOptions,
  ): YdbTransactionHandle => {
    const trxExecutors = Array.from({ length: attempts }, () =>
      makeQueryExecutor(),
    );
    // Каждая попытка — свой сигнал отмены (как linkSignals в @ydbjs/query),
    // связанный с глобальным пользовательским сигналом из опций.
    const attemptControllers = Array.from(
      { length: attempts },
      () => new AbortController(),
    );
    transactions.push({ options: options ?? {}, trx: trxExecutors[0] });
    return {
      async execute(fn) {
        // Имитация @ydbjs/query: каждая попытка — новый session/tx executor
        // и новый сигнал попытки.
        let result: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const ownSignal = attemptControllers[attempt].signal;
          const globalSignal = options?.signal;
          const attemptSignal =
            globalSignal instanceof AbortSignal
              ? AbortSignal.any([globalSignal, ownSignal])
              : ownSignal;
          result = await fn(trxExecutors[attempt], attemptSignal);
        }
        return result as any;
      },
    };
  };

  return {
    executor: executor as YdbExecutor,
    transactions,
    count: () => transactions.length,
  };
}

describe('runInTransaction(): option validation (#98)', () => {
  it('accepts valid options and undefined', () => {
    expect(() => validateRunInTransactionOptions(undefined)).not.toThrow();
    expect(() => validateRunInTransactionOptions({})).not.toThrow();
    expect(() =>
      validateRunInTransactionOptions({
        isolation: 'snapshotReadWrite',
        timeout: 5_000,
        idempotent: true,
      }),
    ).not.toThrow();
  });

  it('rejects unknown keys (typo protection)', () => {
    expect(() =>
      validateRunInTransactionOptions({ isolaton: 'x' } as any),
    ).toThrow(/unknown option\(s\) "isolaton"/);
  });

  it('rejects invalid isolation level', () => {
    expect(() =>
      validateRunInTransactionOptions({ isolation: 'onlineReadOnly' as any }),
    ).toThrow(/invalid isolation level/);
  });

  it('rejects non-positive and non-numeric timeout', () => {
    expect(() => validateRunInTransactionOptions({ timeout: 0 })).toThrow(
      /timeout/,
    );
    expect(() => validateRunInTransactionOptions({ timeout: -5 })).toThrow(
      /timeout/,
    );
    expect(() =>
      validateRunInTransactionOptions({ timeout: '100' as any }),
    ).toThrow(/timeout/);
  });

  it('rejects non-AbortSignal signal', () => {
    expect(() =>
      validateRunInTransactionOptions({ signal: 'abort' as any }),
    ).toThrow(/signal.*AbortSignal/);
  });

  it('rejects non-boolean flags', () => {
    expect(() =>
      validateRunInTransactionOptions({ idempotent: 'yes' as any }),
    ).toThrow(/"idempotent" must be a boolean/);
    expect(() => validateRunInTransactionOptions({ reuse: 1 as any })).toThrow(
      /"reuse" must be a boolean/,
    );
  });

  it('rejects reuse combined with transaction-defining options', () => {
    expect(() =>
      validateRunInTransactionOptions({
        reuse: true,
        isolation: 'snapshotReadOnly',
      }),
    ).toThrow(/reuse: true.*cannot be changed mid-flight/s);
    expect(() =>
      validateRunInTransactionOptions({ reuse: true, timeout: 100 }),
    ).toThrow(/reuse: true/);
  });
});

describe('runInTransaction(): options propagation to the SDK call (#98)', () => {
  it('propagates isolation and idempotent to transaction()', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(() => Promise.resolve('ok'), {
      isolation: 'snapshotReadOnly',
      idempotent: true,
    });

    expect(db.count()).toBe(1);
    expect(db.transactions[0].options.isolation).toBe('snapshotReadOnly');
    expect(db.transactions[0].options.idempotent).toBe(true);
  });

  it('propagates the user signal to the SDK as-is (global, spans retries)', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    const controller = new AbortController();
    controller.abort();

    await manager.runInTransaction(() => Promise.resolve(), {
      signal: controller.signal,
    });

    // Пользовательский сигнал уходит в SDK без изменений — он глобальный.
    expect(db.transactions[0].options.signal).toBe(controller.signal);
  });

  it('timeout is per-attempt: the callback signal fires after the deadline', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    let attemptSignal: AbortSignal | undefined;

    await manager.runInTransaction(
      async (_trx, signal) => {
        attemptSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 90));
      },
      { timeout: 30 },
    );

    // Таймаут НЕ попадает в SDK как общий дедлайн...
    expect(db.transactions[0].options.signal).toBeUndefined();
    // ...а применяется к сигналу конкретной попытки.
    expect(attemptSignal).toBeInstanceOf(AbortSignal);
    expect(attemptSignal?.aborted).toBe(true);
  }, 5000);

  it('user signal + timeout: aborting the user signal aborts the current attempt', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    const controller = new AbortController();

    await manager.runInTransaction(
      (_trx, signal) => {
        expect(signal?.aborted).toBe(false);
        controller.abort();
        expect(signal?.aborted).toBe(true);
        return Promise.resolve();
      },
      { timeout: 60_000, signal: controller.signal },
    );
  });
});

describe('timeout semantics across retries (#98)', () => {
  it('a retry receives a FRESH per-attempt signal after a previous attempt timed out', async () => {
    const db = makeFakeDb({ attemptsPerTransaction: 2 });
    const manager = new YdbTransactionManager(db.executor);

    const received: AbortSignal[] = [];

    await manager.runInTransaction(
      async (_trx, signal) => {
        received.push(signal!);
        if (received.length === 1) {
          // Первая попытка «зависла» дольше таймаута.
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
        return Promise.resolve('ok');
      },
      { idempotent: true, timeout: 30 },
    );

    expect(received.length).toBe(2);
    // Первая попытка упёрлась в таймаут...
    expect(received[0].aborted).toBe(true);
    // ...но retry получил СВЕЖИЙ сигнал, а не уже истёкший дедлайн.
    expect(received[1].aborted).toBe(false);
    expect(received[1]).not.toBe(received[0]);
    // Таймаут не просочился в SDK как общий дедлайн операции.
    expect(db.transactions[0].options.signal).toBeUndefined();
  }, 5000);

  it('an explicit user AbortSignal is a GLOBAL deadline: it spans retries', async () => {
    const db = makeFakeDb({ attemptsPerTransaction: 2 });
    const manager = new YdbTransactionManager(db.executor);

    const received: AbortSignal[] = [];

    await manager.runInTransaction(
      async (_trx, signal) => {
        received.push(signal!);
        if (received.length === 1) {
          // Глобальный дедлайн истекает, пока выполняется первая попытка.
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
        return Promise.resolve('ok');
      },
      // Полный дедлайн на всю операцию задаётся пользователем явно.
      { idempotent: true, signal: AbortSignal.timeout(30) },
    );

    expect(received.length).toBe(2);
    // Оба сигнала прерваны: глобальный дедлайн распространяется на retry.
    expect(received[0].aborted).toBe(true);
    expect(received[1].aborted).toBe(true);
    // При этом сигнал SDK в опциях — именно пользовательский.
    expect(db.transactions[0].options.signal).toBeDefined();
  }, 5000);
});

describe('runInTransaction(): nested call detection (#98)', () => {
  it('rejects nested runInTransaction on the same db by default', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await expect(
      manager.runInTransaction(async () => {
        await manager.runInTransaction(() => Promise.resolve('inner'));
      }),
    ).rejects.toThrow(/Nested runInTransaction\(\) detected/);

    // Вторая транзакция не была открыта.
    expect(db.count()).toBe(1);
  });

  it('reuses the active transaction with { reuse: true } without opening a new one', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    const result = await manager.runInTransaction((outerTrx) => {
      return manager.runInTransaction(
        (innerTrx) => {
          expect(innerTrx).toBe(outerTrx);
          expect(getActiveTransaction()?.trx).toBe(outerTrx);
          return Promise.resolve('joined');
        },
        { reuse: true },
      );
    });

    expect(result).toBe('joined');
    // Открыта ровно одна транзакция — внешняя.
    expect(db.count()).toBe(1);
  });

  it('{ reuse: true, ambient: true } forces the REUSED transaction into the ambient context (#98)', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    configureTransactionContext({ ambient: false });

    await manager.runInTransaction(
      (outerTrx, outerSignal) =>
        manager.runInTransaction(
          () => {
            // Вложенный ambient-контекст указывает на ТУ ЖЕ транзакцию.
            const active = getActiveTransaction();
            expect(active?.trx).toBe(outerTrx);
            expect(active?.signal).toBe(outerSignal);
            expect(active?.ambient).toBe(true);
            // Операции без явного { trx } попадают в переиспользованную
            // транзакцию, а не во внешний executor.
            expect(
              resolveOperationExecutor(undefined, db.executor, 'UserEntity'),
            ).toBe(outerTrx);
            return Promise.resolve('inner');
          },
          { reuse: true, ambient: true },
        ),
      { ambient: false },
    );

    // Новая БД-транзакция не открывалась.
    expect(db.count()).toBe(1);
  }, 5000);

  it('{ reuse: true } without ambient preserves the outer ambient state as-is', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    configureTransactionContext({ ambient: true });

    await manager.runInTransaction((outerTrx) =>
      manager.runInTransaction(
        () => {
          const active = getActiveTransaction();
          // Контекст внешний — без создания вложенного.
          expect(active?.trx).toBe(outerTrx);
          expect(active?.ambient).toBe(true);
          return Promise.resolve();
        },
        { reuse: true },
      ),
    );

    expect(db.count()).toBe(1);
  });

  it('nested reuse never commits/rolls back independently and ALS is restored after the inner callback', async () => {
    const db = makeFakeDb({ attemptsPerTransaction: 2 });
    const manager = new YdbTransactionManager(db.executor);
    configureTransactionContext({ ambient: false });

    let outerContextBeforeInner: ReturnType<typeof getActiveTransaction>;
    let trxExecutorSeenInside: unknown;
    // При attemptsPerTransaction > 1 фейковый SDK повторяет ВЕСЬ колбэк,
    // поэтому эталонный executor фиксируем на верхнем уровне той же попытки.
    let outerLevelTrx: unknown;

    await manager.runInTransaction(
      () => {
        outerLevelTrx = getActiveTransaction()?.trx;
        return manager.runInTransaction(
          async () => {
            outerContextBeforeInner = getActiveTransaction();
            await manager.runInTransaction(
              () => {
                trxExecutorSeenInside = getActiveTransaction()?.trx;
                return Promise.resolve();
              },
              { reuse: true, ambient: true },
            );
            // После завершения внутреннего вызова контекст восстановлен:
            // снова активен ВНЕШНИЙ (не ambient-обёртка с тем же trx).
            const restored = getActiveTransaction();
            expect(restored?.trx).toBe(outerContextBeforeInner?.trx);
            expect(restored).toBe(outerContextBeforeInner);
            // Транзакция всё ещё активна — внутренний вызов её не завершил.
            expect(db.count()).toBe(1);
            return Promise.resolve();
          },
          { reuse: true, ambient: true },
        );
      },
      { ambient: false },
    );

    // Ровно одна транзакция и один executor попытки на все уровни reuse.
    expect(db.count()).toBe(1);
    expect(trxExecutorSeenInside).toBe(outerLevelTrx);
    expect(getActiveTransaction()).toBeUndefined();
  }, 5000);

  it('allows nesting on a DIFFERENT db executor (independent database/session)', async () => {
    const outerDb = makeFakeDb();
    const innerDb = makeFakeDb();
    const outer = new YdbTransactionManager(outerDb.executor);
    const inner = new YdbTransactionManager(innerDb.executor);

    await expect(
      outer.runInTransaction(() =>
        inner.runInTransaction(() => Promise.resolve(1)),
      ),
    ).resolves.toBe(1);

    expect(outerDb.count()).toBe(1);
    expect(innerDb.count()).toBe(1);
  });

  it('clears the active context so a follow-up top-level call works', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(() => Promise.resolve());
    expect(getActiveTransaction()).toBeUndefined();

    await manager.runInTransaction(() => Promise.resolve());
    expect(db.count()).toBe(2);
  });
});

describe('nested detection and mixing with executor wrappers (#207)', () => {
  const noopLogger = { log() {} };

  it('recognizes nested runInTransaction across different wrappers of the same logical DB', async () => {
    const db = makeFakeDb();
    const managerA = new YdbTransactionManager(db.executor);
    // Вторая обёртка того же логического executor'а (логирование).
    const managerB = new YdbTransactionManager(
      wrapExecutorWithLogging(db.executor, noopLogger),
    );

    await expect(
      managerA.runInTransaction(() =>
        managerB.runInTransaction(() => Promise.resolve('inner')),
      ),
    ).rejects.toThrow(/Nested runInTransaction\(\) detected/);

    // Вторая независимая транзакция не открылась — вложенность распознана.
    expect(db.count()).toBe(1);
  });

  it('reuses the active transaction across different wrappers of the same logical DB', async () => {
    const db = makeFakeDb();
    const managerA = new YdbTransactionManager(db.executor);
    const managerB = new YdbTransactionManager(
      wrapExecutorWithLogging(db.executor, noopLogger),
    );

    const result = await managerA.runInTransaction((outerTrx) =>
      managerB.runInTransaction(
        (innerTrx) => {
          // reuse присоединяется к активной транзакции внешнего вызова —
          // тот же trx, новая БД-транзакция не открывается.
          expect(innerTrx).toBe(outerTrx);
          return Promise.resolve('joined');
        },
        { reuse: true },
      ),
    );

    expect(result).toBe('joined');
    // Открыта ровно одна транзакция — внешняя.
    expect(db.count()).toBe(1);
  });

  it('does not treat a wrapped executor of the SAME transaction as mixing (ambient)', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(
      (trx) => {
        const wrappedTrx = wrapExecutorWithLogging(trx, noopLogger);
        // Обёртка активной транзакции как явный { trx } при ambient —
        // это та же логическая транзакция, ошибки смешивания быть не должно.
        expect(() =>
          resolveOperationExecutor(wrappedTrx, db.executor, 'UserEntity'),
        ).not.toThrow();
        return Promise.resolve();
      },
      { ambient: true },
    );
  });

  it('still rejects a wrapped executor of a DISTINCT transaction as mixing (ambient)', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(
      async () => {
        const stranger = makeFakeDb().executor;
        const other = await new YdbTransactionManager(
          stranger,
        ).runInTransaction((otherTrx) =>
          Promise.resolve(wrapExecutorWithLogging(otherTrx, noopLogger)),
        );
        // Посторонняя транзакция (хоть и обёрнутая) при активной ambient —
        // смешивание, ошибка сохраняется.
        expect(() =>
          resolveOperationExecutor(other, db.executor, 'UserEntity'),
        ).toThrow(/mixing detected.*different transaction is active/s);
        return Promise.resolve();
      },
      { ambient: true },
    );
  });
});

describe('identity registry (#217): private, non-mutable source of truth', () => {
  const noopLogger = { log() {} };

  it('overwriting a symbol/property on the executor cannot forge its identity', async () => {
    const db = makeFakeDb();
    const executor = db.executor;
    const manager = new YdbTransactionManager(executor);

    // Пытаемся «подделать» identity, записав произвольный символ в свойства
    // executor'а, в т.ч. по прежнему глобальному ключу Symbol.for(...).
    const forged = Symbol('forged');
    (executor as unknown as Record<PropertyKey, unknown>)[
      Symbol.for('ydb.transaction.id')
    ] = forged;
    (executor as unknown as Record<string, unknown>).anyOtherProp = forged;

    // Реестр identity не читает свойства объекта — identity не изменился.
    expect(getTransactionId(executor)).not.toBe(forged);

    // Вложенная детекция по-прежнему работает по registry-identity.
    await expect(
      manager.runInTransaction(() =>
        manager.runInTransaction(() => Promise.resolve()),
      ),
    ).rejects.toThrow(/Nested runInTransaction\(\) detected/);
  });

  it('two wrappers of the same logical executor resolve to one identity', () => {
    const anExecutor = makeFakeDb().executor;
    ensureExecutorIdentity(anExecutor);
    const wrapped = wrapExecutorWithLogging(anExecutor, noopLogger);
    expect(getTransactionId(wrapped)).toBe(ensureExecutorIdentity(anExecutor));
  });

  it('different executors get different identities', () => {
    const a = makeFakeDb().executor;
    const b = makeFakeDb().executor;
    const idA = ensureExecutorIdentity(a);
    const idB = ensureExecutorIdentity(b);
    expect(idA).not.toBe(idB);
    expect(getTransactionId(a)).toBe(idA);
    expect(getTransactionId(b)).toBe(idB);
  });

  it('works for a frozen executor without requiring mutation', async () => {
    const db = makeFakeDb();
    Object.freeze(db.executor);
    const manager = new YdbTransactionManager(db.executor);

    const id = ensureExecutorIdentity(db.executor);
    expect(getTransactionId(db.executor)).toBe(id);

    // Вложенная детекция на frozen-executor'е работает (никаких записей в объект).
    await expect(
      manager.runInTransaction(() =>
        manager.runInTransaction(() => Promise.resolve()),
      ),
    ).rejects.toThrow(/Nested runInTransaction\(\) detected/);
  });

  it('same-vs-distinct transaction detection keeps working', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(
      (trx) => {
        // Обёртка ТОЙ ЖЕ транзакции — не смешивание.
        const wrapped = wrapExecutorWithLogging(trx, noopLogger);
        expect(() =>
          resolveOperationExecutor(wrapped, db.executor, 'UserEntity'),
        ).not.toThrow();
        // Чужой executor — смешивание при активной ambient-транзакции.
        const stranger = makeFakeDb().executor;
        expect(() =>
          resolveOperationExecutor(stranger, db.executor, 'UserEntity'),
        ).toThrow(/mixing detected.*different transaction is active/s);
        return Promise.resolve();
      },
      { ambient: true },
    );
  });
});

describe('ambient transaction context (#98)', () => {
  afterEach(() => {
    // Сбрасываем глобальные настройки, чтобы не влиять на другие тесты файла.
    configureTransactionContext({});
  });

  it('is opt-in per call: ambient flag puts trx into the context', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(
      (trx) => {
        expect(getActiveTransaction()?.trx).toBe(trx);
        expect(getActiveTransaction()?.ambient).toBe(true);
        return Promise.resolve();
      },
      { ambient: true },
    );
  });

  it('without opt-in the context is tracked but not ambient', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction((trx) => {
      expect(getActiveTransaction()?.trx).toBe(trx);
      expect(getActiveTransaction()?.ambient).toBe(false);
      return Promise.resolve();
    });
  });

  it('global settings enable ambient by default for every call', async () => {
    configureTransactionContext({ ambient: true });
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(() => {
      expect(getActiveTransaction()?.ambient).toBe(true);
      return Promise.resolve();
    });
  });
});

describe('resolveOperationExecutor semantics via repository resolution (#98)', () => {
  it('explicit trx equal to ambient passes; different trx fails', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    const stranger = makeFakeDb().executor;

    await manager.runInTransaction(
      (trx) => {
        // Совпадает с активной ambient — ок.
        expect(resolveOperationExecutor(trx, db.executor, 'UserEntity')).toBe(
          trx,
        );
        // Посторонний trx при активной ambient-транзакции — ошибка смешивания.
        expect(() =>
          resolveOperationExecutor(stranger, db.executor, 'UserEntity'),
        ).toThrow(/mixing detected.*different transaction is active/s);
        return Promise.resolve();
      },
      { ambient: true },
    );
  });

  it('explicit different trx is allowed when the active context is NOT ambient', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    const stranger = makeFakeDb().executor;

    await manager.runInTransaction(() => {
      // Ambient выключен: явный { trx } — легитимный паттерн (обратная
      // совместимость), никакой ошибки быть не должно.
      expect(
        resolveOperationExecutor(stranger, db.executor, 'UserEntity'),
      ).toBe(stranger);
      return Promise.resolve();
    });
  });
});

describe('retry semantics are surfaced, not hidden (#98)', () => {
  it('with idempotent: true the callback may be re-executed by the SDK (documented behaviour)', async () => {
    const db = makeFakeDb({ attemptsPerTransaction: 2 });
    const manager = new YdbTransactionManager(db.executor);

    const seen: YdbExecutor[] = [];
    let sideEffectCount = 0;

    const result = await manager.runInTransaction(
      (trx) => {
        seen.push(trx);
        sideEffectCount += 1;
        expect(getActiveTransaction()?.trx).toBe(trx);
        return Promise.resolve('done');
      },
      { idempotent: true },
    );

    expect(result).toBe('done');
    // Колбэк выполнен дважды: побочные эффекты повторяются при retry.
    expect(seen.length).toBe(2);
    expect(sideEffectCount).toBe(2);
    // Каждая попытка получает СВОЙ executor транзакции и свой контекст.
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('idempotent is not requested from the SDK unless explicitly enabled', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    let calls = 0;
    await manager.runInTransaction(() => {
      calls += 1;
      return Promise.resolve();
    });

    expect(calls).toBe(1);
    // Без явного флага менеджер не включает повторное выполнение колбэка.
    expect(db.transactions[0].options.idempotent).toBeUndefined();
  });
});

describe('warnOutsideTransaction (#98)', () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    configureTransactionContext({});
  });

  it('does not warn by default', () => {
    resolveOperationExecutor(undefined, makeFakeDb().executor, 'UserEntity');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when configured and no transaction is active', () => {
    configureTransactionContext({ warnOutsideTransaction: true });
    const fallback = makeFakeDb().executor;
    const resolved = resolveOperationExecutor(
      undefined,
      fallback,
      'UserEntity',
    );

    expect(resolved).toBe(fallback);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/outside any transaction/);
  });

  it('never warns inside an active transaction', async () => {
    configureTransactionContext({ warnOutsideTransaction: true });
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(
      (trx) => {
        const resolved = resolveOperationExecutor(
          undefined,
          db.executor,
          'UserEntity',
        );
        expect(resolved).toBe(trx);
        return Promise.resolve();
      },
      { ambient: true },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
