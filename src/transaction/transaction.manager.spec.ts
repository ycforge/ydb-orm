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
  getActiveTransaction,
  resolveOperationExecutor,
} from './transaction-context.js';
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
    transactions.push({ options: options ?? {}, trx: trxExecutors[0] });
    let attempt = 0;
    return {
      async execute(fn) {
        // Имитация @ydbjs/query: каждая попытка — новый session/tx executor.
        let result = await fn(trxExecutors[attempt]);
        attempt += 1;
        while (attempt < attempts) {
          result = await fn(trxExecutors[attempt]);
          attempt += 1;
        }
        return result;
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

  it('propagates an already-aborted user signal', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    const controller = new AbortController();
    controller.abort();

    await manager.runInTransaction(() => Promise.resolve(), {
      signal: controller.signal,
    });

    const signal = db.transactions[0].options.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });

  it('enforces timeout via a merged AbortSignal that fires after the deadline', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(() => Promise.resolve(), { timeout: 25 });

    const signal = db.transactions[0].options.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(true);
  }, 5000);

  it('links user signal with the timeout signal', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);
    const controller = new AbortController();

    await manager.runInTransaction(async () => {}, {
      timeout: 60_000,
      signal: controller.signal,
    });

    const merged = db.transactions[0].options.signal!;
    expect(merged.aborted).toBe(false);
    controller.abort();
    expect(merged.aborted).toBe(true);
  });
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
