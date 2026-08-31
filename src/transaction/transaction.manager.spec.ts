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
import {
  wrapExecutorWithLogging,
  resolveExecutorLogger,
} from '../core/query-logger.js';
import type {
  YdbExecutor,
  YdbTransactionHandle,
  YdbTransactionOptions,
} from '../core/interfaces.js';

/**
 * Unit tests for the transaction manager (#98): option validation, option
 * propagation to the SDK call, nesting detection, reuse, ambient context,
 * retry semantics. No network — a fake executor is used.
 */

interface RecordedTransaction {
  options: YdbTransactionOptions;
  trx: YdbExecutor;
}

interface FakeDb {
  executor: YdbExecutor;
  transactions: RecordedTransaction[];
  /** How many times transaction() opened a transaction. */
  count(): number;
}

function makeFakeDb(
  opts: {
    /** Simulate SDK idempotent-retry: the execute callback is invoked N times. */
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
    // Each attempt has its own cancellation signal (like linkSignals in
    // @ydbjs/query), linked to the global user signal from the options.
    const attemptControllers = Array.from(
      { length: attempts },
      () => new AbortController(),
    );
    transactions.push({ options: options ?? {}, trx: trxExecutors[0] });
    return {
      async execute(fn) {
        // Simulation of @ydbjs/query: each attempt is a new session/tx executor
        // and a new attempt signal.
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

    // The user signal goes to the SDK unchanged — it is global.
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

    // The timeout does NOT reach the SDK as a shared deadline...
    expect(db.transactions[0].options.signal).toBeUndefined();
    // ...but is applied to the specific attempt's signal.
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
          // The first attempt "hung" longer than the timeout.
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
        return Promise.resolve('ok');
      },
      { idempotent: true, timeout: 30 },
    );

    expect(received.length).toBe(2);
    // The first attempt hit the timeout...
    expect(received[0].aborted).toBe(true);
    // ...but the retry got a FRESH signal, not the already-expired deadline.
    expect(received[1].aborted).toBe(false);
    expect(received[1]).not.toBe(received[0]);
    // The timeout did not leak into the SDK as the operation's shared deadline.
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
          // The global deadline expires while the first attempt is running.
          await new Promise((resolve) => setTimeout(resolve, 90));
        }
        return Promise.resolve('ok');
      },
      // The full operation-wide deadline is set by the user explicitly.
      { idempotent: true, signal: AbortSignal.timeout(30) },
    );

    expect(received.length).toBe(2);
    // Both signals are aborted: the global deadline propagates to retry.
    expect(received[0].aborted).toBe(true);
    expect(received[1].aborted).toBe(true);
    // The signal in the SDK options is exactly the user's.
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

    // The second transaction was not opened.
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
    // Exactly one transaction is opened — the outer one.
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
            // The nested ambient context points to the SAME transaction.
            const active = getActiveTransaction();
            expect(active?.trx).toBe(outerTrx);
            expect(active?.signal).toBe(outerSignal);
            expect(active?.ambient).toBe(true);
            // Operations without an explicit { trx } go into the reused
            // transaction, not the outer executor.
            expect(
              resolveOperationExecutor(undefined, db.executor, 'UserEntity'),
            ).toBe(outerTrx);
            return Promise.resolve('inner');
          },
          { reuse: true, ambient: true },
        ),
      { ambient: false },
    );

    // No new DB transaction was opened.
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
          // The context is the outer one — no nested context is created.
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
    // With attemptsPerTransaction > 1 the fake SDK replays the WHOLE callback,
    // so the reference executor is captured at the top level of the same attempt.
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
            // After the inner call finishes, the context is restored:
            // the OUTER (non-ambient wrapper with the same trx) is active again.
            const restored = getActiveTransaction();
            expect(restored?.trx).toBe(outerContextBeforeInner?.trx);
            expect(restored).toBe(outerContextBeforeInner);
            // The transaction is still active — the inner call did not finish it.
            expect(db.count()).toBe(1);
            return Promise.resolve();
          },
          { reuse: true, ambient: true },
        );
      },
      { ambient: false },
    );

    // Exactly one transaction and one attempt executor across all reuse levels.
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
    // A second wrapper of the same logical executor (logging).
    const managerB = new YdbTransactionManager(
      wrapExecutorWithLogging(db.executor, noopLogger),
    );

    await expect(
      managerA.runInTransaction(() =>
        managerB.runInTransaction(() => Promise.resolve('inner')),
      ),
    ).rejects.toThrow(/Nested runInTransaction\(\) detected/);

    // No second independent transaction was opened — nesting is recognized.
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
          // reuse joins the outer call's active transaction —
          // the same trx, no new DB transaction is opened.
          expect(innerTrx).toBe(outerTrx);
          return Promise.resolve('joined');
        },
        { reuse: true },
      ),
    );

    expect(result).toBe('joined');
    // Exactly one transaction is opened — the outer one.
    expect(db.count()).toBe(1);
  });

  it('does not treat a wrapped executor of the SAME transaction as mixing (ambient)', async () => {
    const db = makeFakeDb();
    const manager = new YdbTransactionManager(db.executor);

    await manager.runInTransaction(
      (trx) => {
        const wrappedTrx = wrapExecutorWithLogging(trx, noopLogger);
        // A wrapper of the active transaction as an explicit { trx } under
        // ambient — it is the same logical transaction, so no mixing error.
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
        // A foreign transaction (even wrapped) under an active ambient —
        // mixing, the error is preserved.
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

    // Try to "forge" the identity by writing an arbitrary symbol into the
    // executor's properties, including the old global Symbol.for(...) key.
    const forged = Symbol('forged');
    (executor as unknown as Record<PropertyKey, unknown>)[
      Symbol.for('ydb.transaction.id')
    ] = forged;
    (executor as unknown as Record<string, unknown>).anyOtherProp = forged;

    // The identity registry does not read object properties — identity unchanged.
    expect(getTransactionId(executor)).not.toBe(forged);

    // Nested detection still works via the registry identity.
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

    // Nested detection works on a frozen executor (no writes into the object).
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
        // A wrapper of the SAME transaction — not mixing.
        const wrapped = wrapExecutorWithLogging(trx, noopLogger);
        expect(() =>
          resolveOperationExecutor(wrapped, db.executor, 'UserEntity'),
        ).not.toThrow();
        // A foreign executor — mixing under an active ambient transaction.
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
    // Reset the global settings so other tests in the file are not affected.
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
        // Matches the active ambient — ok.
        expect(resolveOperationExecutor(trx, db.executor, 'UserEntity')).toBe(
          trx,
        );
        // A foreign trx under an active ambient transaction — mixing error.
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
      // Ambient is off: an explicit { trx } is a legitimate pattern (backwards
      // compatibility), no error should be raised.
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
    // The callback ran twice: side effects repeat on retry.
    expect(seen.length).toBe(2);
    expect(sideEffectCount).toBe(2);
    // Each attempt gets ITS OWN transaction executor and context.
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
    // Without the explicit flag the manager does not enable callback replay.
    expect(db.transactions[0].options.idempotent).toBeUndefined();
  });
});

describe('warnOutsideTransaction (#98) through the ORM logger (#206)', () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    configureTransactionContext({});
  });

  it('does not warn by default', () => {
    resolveOperationExecutor(
      undefined,
      makeFakeDb().executor,
      'UserEntity',
      undefined,
      resolveExecutorLogger(makeFakeDb().executor),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns through the fallback console logger when configured and no transaction is active', () => {
    configureTransactionContext({ warnOutsideTransaction: true });
    const fallback = makeFakeDb().executor;
    // Without a configured logger the resolved logger is the established
    // ConsoleQueryLogger fallback — console output is preserved.
    const resolved = resolveOperationExecutor(
      undefined,
      fallback,
      'UserEntity',
      undefined,
      resolveExecutorLogger(fallback),
    );

    expect(resolved).toBe(fallback);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/outside any transaction/);
  });

  it('routes the warning to the configured logger and keeps the content', () => {
    configureTransactionContext({ warnOutsideTransaction: true });
    const warnings: string[] = [];
    const logger = {
      log: () => undefined,
      warn: (message: string) => warnings.push(message),
    };

    resolveOperationExecutor(
      undefined,
      makeFakeDb().executor,
      'UserEntity',
      undefined,
      logger,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      '[ydb-orm] UserEntity: query executed outside any transaction ' +
        '(warnOutsideTransaction is enabled).',
    );
    // The warning does not require a direct console.warn: the custom logger
    // receives the message and the console is not involved.
    expect(warnSpy).not.toHaveBeenCalled();
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
          undefined,
          resolveExecutorLogger(db.executor),
        );
        expect(resolved).toBe(trx);
        return Promise.resolve();
      },
      { ambient: true },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
