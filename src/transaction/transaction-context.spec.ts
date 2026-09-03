import { describe, it, expect, jest } from '@jest/globals';
import {
  createTransactionContext,
  runWithTransactionContext,
  getActiveTransaction,
  ActiveTransactionContext,
} from './transaction-context.js';
import type { YdbExecutor } from '../core/interfaces.js';

function makeMockExecutor(): YdbExecutor {
  const executor = jest.fn(() => ({
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
    then(onFulfilled?: (value: unknown) => unknown) {
      return Promise.resolve([]).then(onFulfilled);
    },
  }));
  return executor as unknown as YdbExecutor;
}

describe('createTransactionContext(): invariant validation (#208)', () => {
  const validTrx = makeMockExecutor();
  const validDb = makeMockExecutor();
  const validTransactionId = Symbol('transaction');
  const validSignal = new AbortController().signal;

  it('creates a valid context with all required fields', () => {
    const context = createTransactionContext({
      transactionId: validTransactionId,
      trx: validTrx,
      db: validDb,
      signal: validSignal,
      ambient: true,
    });

    expect(context.transactionId).toBe(validTransactionId);
    expect(context.trx).toBe(validTrx);
    expect(context.db).toBe(validDb);
    expect(context.signal).toBe(validSignal);
    expect(context.ambient).toBe(true);
  });

  it('creates a valid context without optional signal', () => {
    const context = createTransactionContext({
      transactionId: validTransactionId,
      trx: validTrx,
      db: validDb,
      ambient: false,
    });

    expect(context.signal).toBeUndefined();
    expect(context.ambient).toBe(false);
  });

  it('rejects non-symbol transactionId', () => {
    expect(() =>
      createTransactionContext({
        transactionId: 'not-a-symbol' as any,
        trx: validTrx,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('transactionId must be a symbol');
  });

  it('rejects null transactionId', () => {
    expect(() =>
      createTransactionContext({
        transactionId: null as any,
        trx: validTrx,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('transactionId must be a symbol');
  });

  it('rejects undefined transactionId', () => {
    expect(() =>
      createTransactionContext({
        transactionId: undefined as any,
        trx: validTrx,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('transactionId must be a symbol');
  });

  it('rejects invalid trx (null)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: null as any,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('trx must be a valid executor');
  });

  it('rejects invalid trx (undefined)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: undefined as any,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('trx must be a valid executor');
  });

  it('rejects invalid trx (primitive)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: 'not-an-executor' as any,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('trx must be a valid executor');
  });

  it('rejects invalid trx (number)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: 42 as any,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('trx must be a valid executor');
  });

  it('rejects invalid db (null)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: validTrx,
        db: null as any,
        ambient: false,
      }),
    ).toThrow('db must be a valid executor');
  });

  it('rejects invalid db (undefined)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: validTrx,
        db: undefined as any,
        ambient: false,
      }),
    ).toThrow('db must be a valid executor');
  });

  it('rejects invalid db (primitive)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: validTrx,
        db: 'not-an-executor' as any,
        ambient: false,
      }),
    ).toThrow('db must be a valid executor');
  });

  it('rejects invalid signal (non-AbortSignal)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: validTrx,
        db: validDb,
        signal: 'not-a-signal' as any,
        ambient: false,
      }),
    ).toThrow('signal must be an AbortSignal');
  });

  it('rejects invalid signal (object)', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: validTrx,
        db: validDb,
        signal: {} as any,
        ambient: false,
      }),
    ).toThrow('signal must be an AbortSignal');
  });

  it('rejects non-boolean ambient', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: validTrx,
        db: validDb,
        ambient: 'true' as any,
      }),
    ).toThrow('ambient must be a boolean');
  });

  it('rejects undefined ambient', () => {
    expect(() =>
      createTransactionContext({
        transactionId: validTransactionId,
        trx: validTrx,
        db: validDb,
        ambient: undefined as any,
      }),
    ).toThrow('ambient must be a boolean');
  });

  it('accepts function as valid trx (jest mock compatibility)', () => {
    const fnExecutor = jest.fn(() =>
      Promise.resolve([]),
    ) as unknown as YdbExecutor;
    const context = createTransactionContext({
      transactionId: validTransactionId,
      trx: fnExecutor,
      db: validDb,
      ambient: false,
    });
    expect(context.trx).toBe(fnExecutor);
  });

  it('accepts function as valid db (jest mock compatibility)', () => {
    const fnExecutor = jest.fn(() =>
      Promise.resolve([]),
    ) as unknown as YdbExecutor;
    const context = createTransactionContext({
      transactionId: validTransactionId,
      trx: validTrx,
      db: fnExecutor,
      ambient: false,
    });
    expect(context.db).toBe(fnExecutor);
  });
});

describe('runWithTransactionContext(): context propagation with validation (#208)', () => {
  const validTrx = makeMockExecutor();
  const validDb = makeMockExecutor();
  const validTransactionId = Symbol('transaction');

  it('propagates valid context through ALS', async () => {
    const context = createTransactionContext({
      transactionId: validTransactionId,
      trx: validTrx,
      db: validDb,
      ambient: true,
    });

    const result = await runWithTransactionContext(context, () => {
      const active = getActiveTransaction();
      expect(active).toBe(context);
      return Promise.resolve('success');
    });

    expect(result).toBe('success');
    expect(getActiveTransaction()).toBeUndefined();
  });

  it('createTransactionContext rejects invalid context at factory boundary', () => {
    expect(() =>
      createTransactionContext({
        transactionId: 'invalid' as any,
        trx: validTrx,
        db: validDb,
        ambient: false,
      }),
    ).toThrow('transactionId must be a symbol');
  });

  it('restores previous context after fn throws', async () => {
    const outerContext = createTransactionContext({
      transactionId: Symbol('outer'),
      trx: validTrx,
      db: validDb,
      ambient: true,
    });

    const innerContext = createTransactionContext({
      transactionId: Symbol('inner'),
      trx: validTrx,
      db: validDb,
      ambient: false,
    });

    await runWithTransactionContext(outerContext, async () => {
      expect(getActiveTransaction()).toBe(outerContext);

      await expect(
        runWithTransactionContext(innerContext, () => {
          expect(getActiveTransaction()).toBe(innerContext);
          return Promise.reject(new Error('inner error'));
        }),
      ).rejects.toThrow('inner error');

      expect(getActiveTransaction()).toBe(outerContext);
    });

    expect(getActiveTransaction()).toBeUndefined();
  });
});

describe('runWithTransactionContext(): rejects invalid contexts at the boundary (#208)', () => {
  const validTrx = makeMockExecutor();
  const validDb = makeMockExecutor();

  it('rejects a plain object cast to a context (factory bypass)', () => {
    const fake = {
      transactionId: Symbol('fake'),
      trx: validTrx,
      db: validDb,
      ambient: true,
    } as unknown as ActiveTransactionContext;

    expect(() =>
      runWithTransactionContext(fake, () => Promise.resolve('never')),
    ).toThrow('invalid context');

    // The context did not reach the ALS.
    expect(getActiveTransaction()).toBeUndefined();
  });

  it('rejects cast contexts with invalid field values', () => {
    for (const invalid of [
      { transactionId: 'id', trx: validTrx, db: validDb, ambient: true },
      { transactionId: Symbol('t'), trx: null, db: validDb, ambient: true },
      { transactionId: Symbol('t'), trx: validTrx, db: null, ambient: true },
      {
        transactionId: Symbol('t'),
        trx: validTrx,
        db: validDb,
        ambient: 'yes',
      },
      {
        transactionId: Symbol('t'),
        trx: validTrx,
        db: validDb,
        signal: {},
        ambient: true,
      },
    ] as unknown as ActiveTransactionContext[]) {
      expect(() =>
        runWithTransactionContext(invalid, () => Promise.resolve('never')),
      ).toThrow('ActiveTransactionContext');
      expect(getActiveTransaction()).toBeUndefined();
    }
  });

  it('rejects null and undefined contexts', () => {
    expect(() =>
      runWithTransactionContext(
        null as unknown as ActiveTransactionContext,
        () => Promise.resolve('never'),
      ),
    ).toThrow('invalid context');
    expect(() =>
      runWithTransactionContext(
        undefined as unknown as ActiveTransactionContext,
        () => Promise.resolve('never'),
      ),
    ).toThrow('invalid context');
    expect(getActiveTransaction()).toBeUndefined();
  });

  it('rejects a prototype-forged context (instanceof cannot fake the brand)', () => {
    const forged = Object.create(
      ActiveTransactionContext.prototype,
    ) as unknown as ActiveTransactionContext;

    expect(() =>
      runWithTransactionContext(forged, () => Promise.resolve('never')),
    ).toThrow('invalid context');
    expect(getActiveTransaction()).toBeUndefined();
  });

  it('preserves an active outer context when an invalid inner context is rejected', async () => {
    const outer = createTransactionContext({
      transactionId: Symbol('outer'),
      trx: validTrx,
      db: validDb,
      ambient: true,
    });
    const fake = {
      transactionId: Symbol('fake'),
      trx: validTrx,
      db: validDb,
      ambient: false,
    } as unknown as ActiveTransactionContext;

    await runWithTransactionContext(outer, () => {
      expect(() =>
        runWithTransactionContext(fake, () => Promise.resolve('never')),
      ).toThrow('invalid context');
      expect(getActiveTransaction()).toBe(outer);
      return Promise.resolve();
    });

    expect(getActiveTransaction()).toBeUndefined();
  });
});
