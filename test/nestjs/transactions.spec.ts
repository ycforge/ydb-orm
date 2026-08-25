import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Module } from '@nestjs/common';
import { jest } from '@jest/globals';
import { createAuth } from '@ycforge/auth';
import { TestOnlyEncryptionProvider } from '@ycforge/js-dev-tools';
import {
  YdbCoreModule,
  YdbModule,
  YdbTransactionManager,
  YDB_DRIVER,
  YDB_QUERY,
  type YdbModuleOptions,
  type YdbExecutor,
  type YdbTransactionHandle,
} from '../../src/index.js';
import { getActiveTransaction } from '../../src/index.js';
import { UserEntity } from '../fixtures/user/user.entity.js';
import { createMockExecutor } from '../helpers/mock-executor.js';

/**
 * Интеграционные тесты транзакций (#98): ambient-контекст через репозитории,
 * запрет смешивания, очистка контекста после commit/rollback, независимость
 * параллельных транзакций, предупреждения о запросах вне транзакции.
 *
 * Фейковый db создаёт для каждой транзакции СВОЙ executor с меткой — так
 * видно, какой executor реально выполнил запрос.
 */

interface TaggedQuery {
  tag: string;
  sql: string;
}

interface TaggedDb {
  base: YdbExecutor;
  queries: TaggedQuery[];
  /** Опции каждой открытой транзакции. */
  transactionOptions: Array<Record<string, unknown>>;
}

function createTaggedDb(): TaggedDb {
  const queries: TaggedQuery[] = [];
  const transactionOptions: Array<Record<string, unknown>> = [];
  let txCounter = 0;

  const makeExecutor = (tag: string): any => {
    const exec = jest.fn((strings: TemplateStringsArray) => {
      queries.push({ tag, sql: strings[0] });
      // count() ожидает строку с cnt.
      const rows = /COUNT\(\*\)/i.test(strings[0]) ? [{ cnt: 1 }] : [];
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
        then(onFulfilled: any, onRejected: any) {
          return Promise.resolve([rows]).then(onFulfilled, onRejected);
        },
      };
      return query;
    });
    return exec;
  };

  const base = makeExecutor('base');
  base.transaction = (
    options?: Record<string, unknown>,
  ): YdbTransactionHandle => {
    const trx = makeExecutor(`trx-${++txCounter}`);
    transactionOptions.push(options ?? {});
    // Глобальный пользовательский сигнал виден колбэку каждой попытки
    // (имитация linkSignals в @ydbjs/query).
    const globalSignal = options?.signal;
    return {
      execute: async <T>(
        fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
      ): Promise<T> =>
        fn(trx, globalSignal instanceof AbortSignal ? globalSignal : undefined),
    };
  };

  return { base: base as YdbExecutor, queries, transactionOptions };
}

@Module({
  imports: [YdbModule.forFeature([UserEntity])],
})
class TestFeatureModule {}

async function createTestingModule(
  db: TaggedDb,
  transactions?: YdbModuleOptions['transactions'],
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      YdbCoreModule.forRootAsync({
        useFactory: () => ({
          endpoint: 'grpc://localhost:2136/local',
          auth: createAuth({ type: 'anonymous' }),
          sync: false,
          // UserEntity содержит @YdbEncrypted-поля: без провайдеров
          // валидация метаданных на старте упадёт.
          encryptionProvider: new TestOnlyEncryptionProvider(),
          blindIndexProvider: new TestOnlyEncryptionProvider(),
          ...(transactions ? { transactions } : {}),
        }),
      }),
      TestFeatureModule,
    ],
  })
    .overrideProvider(YDB_DRIVER)
    .useValue({})
    .overrideProvider(YDB_QUERY)
    .useValue(db.base)
    .compile();

  return { moduleRef, txManager: moduleRef.get(YdbTransactionManager) };
}

describe('NestJS integration: transactions (#98)', () => {
  let db: TaggedDb;

  beforeEach(() => {
    db = createTaggedDb();
  });

  describe('ambient context enabled via module options', () => {
    let moduleRef: Awaited<ReturnType<typeof createTestingModule>>['moduleRef'];
    let txManager: YdbTransactionManager;

    beforeEach(async () => {
      ({ moduleRef, txManager } = await createTestingModule(db, {
        ambient: true,
      }));
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    it('repository operation without { trx } joins the ambient transaction across async boundaries', async () => {
      await txManager.runInTransaction(
        async () => {
          // Асинхронная граница внутри транзакции: контекст должен пережить await.
          await new Promise((resolve) => setTimeout(resolve, 5));
          const count = await UserEntity.count({});
          expect(count).toBe(1);
        },
        { ambient: true },
      );

      // Запрос ушёл в executor ТРАНЗАКЦИИ, а не в базовый executor.
      expect(db.queries.length).toBeGreaterThan(0);
      expect(db.queries.every((q) => q.tag.startsWith('trx-'))).toBe(true);
    });

    it('explicit { trx } equal to the ambient transaction works', async () => {
      await txManager.runInTransaction(
        async (trx) => {
          await expect(UserEntity.count({}, { trx })).resolves.toBe(1);
        },
        { ambient: true },
      );

      expect(db.queries.every((q) => q.tag.startsWith('trx-'))).toBe(true);
    });

    it('explicit DIFFERENT { trx } fails clearly instead of silently mixing', async () => {
      const stranger = createMockExecutor([[[]]]).executor;

      await expect(
        txManager.runInTransaction(
          async () => {
            await UserEntity.count({}, { trx: stranger });
          },
          { ambient: true },
        ),
      ).rejects.toThrow(/mixing detected.*different transaction is active/s);

      // Запрос к постороннему executor не дошёл.
      expect(stranger).not.toHaveBeenCalled();
    });

    it('context is cleared after commit', async () => {
      await txManager.runInTransaction(async () => {}, { ambient: true });
      expect(getActiveTransaction()).toBeUndefined();

      await UserEntity.count({});
      expect(db.queries.every((q) => q.tag === 'base')).toBe(true);
    });

    it('context is cleared after rollback', async () => {
      await expect(
        txManager.runInTransaction(
          async () => {
            await UserEntity.count({});
            throw new Error('boom');
          },
          { ambient: true },
        ),
      ).rejects.toThrow('boom');

      expect(getActiveTransaction()).toBeUndefined();
      await UserEntity.count({});
      expect(db.queries[db.queries.length - 1].tag).toBe('base');
    });

    it('concurrent independent transactions do not leak context into each other', async () => {
      await Promise.all([
        txManager.runInTransaction(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const tag = getActiveTransaction()?.trx;
            await UserEntity.count({});
            return tag;
          },
          { ambient: true },
        ),
        txManager.runInTransaction(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 2));
            await UserEntity.count({});
          },
          { ambient: true },
        ),
      ]);

      const trxTags = new Set(
        db.queries.filter((q) => q.tag !== 'base').map((q) => q.tag),
      );
      // Две РАЗНЫЕ транзакции, каждая со своим executor.
      expect(trxTags.size).toBe(2);
      expect(getActiveTransaction()).toBeUndefined();
    });

    it('nested runInTransaction is rejected through DI; { reuse: true } joins', async () => {
      await expect(
        txManager.runInTransaction(() =>
          txManager.runInTransaction(() => Promise.resolve(1)),
        ),
      ).rejects.toThrow(/Nested runInTransaction\(\) detected/);

      // Вложенный вызов не открыл вторую транзакцию.
      expect(db.transactionOptions.length).toBe(1);

      await txManager.runInTransaction(async (outerTrx) => {
        const joined = await txManager.runInTransaction(
          (innerTrx) => Promise.resolve(innerTrx === outerTrx),
          { reuse: true },
        );
        expect(joined).toBe(true);
      });
      // reuse не открыл ещё одну транзакцию: итого две top-level.
      expect(db.transactionOptions.length).toBe(2);
    });

    it('nested { reuse: true } keeps the outer ambient routing intact', async () => {
      await txManager.runInTransaction(
        async () => {
          await txManager.runInTransaction(
            async () => {
              await UserEntity.count({});
            },
            { reuse: true },
          );
        },
        { ambient: true },
      );

      // Все запросы — в executor внешней (переиспользованной) транзакции.
      expect(db.queries.every((q) => q.tag.startsWith('trx-'))).toBe(true);
      expect(db.transactionOptions.length).toBe(1);
    });
  });

  describe('ambient disabled by default (#7 backward compatibility)', () => {
    let moduleRef: Awaited<ReturnType<typeof createTestingModule>>['moduleRef'];
    let txManager: YdbTransactionManager;

    beforeEach(async () => {
      ({ moduleRef, txManager } = await createTestingModule(db));
    });

    afterEach(async () => {
      await moduleRef.close();
    });

    it('repository operation without { trx } still uses the entity executor inside a transaction', async () => {
      await txManager.runInTransaction(async (trx) => {
        // Явный { trx } работает как раньше...
        await expect(UserEntity.count({}, { trx })).resolves.toBe(1);
        // ...а без { trx } запрос идёт мимо транзакции (прежнее поведение).
        await UserEntity.count({});
      });

      const tags = db.queries.map((q) => q.tag);
      expect(tags).toContain('base');
      expect(tags.some((t) => t?.startsWith('trx-'))).toBe(true);
    });

    it('per-call { ambient: true } enables auto-join without global config', async () => {
      await txManager.runInTransaction(
        async () => {
          await UserEntity.count({});
        },
        { ambient: true },
      );

      expect(db.queries.every((q) => q.tag.startsWith('trx-'))).toBe(true);
    });

    it('inner { reuse: true, ambient: true } routes repo ops into the REUSED transaction (#98)', async () => {
      await txManager.runInTransaction(
        async () =>
          txManager.runInTransaction(
            async () => {
              // Без явного { trx }: должно уйти в переиспользованную
              // транзакцию благодаря ambient: true на внутреннем вызове.
              await UserEntity.count({});
              return getActiveTransaction()?.trx;
            },
            { reuse: true, ambient: true },
          ),
        // Внешний вызов БЕЗ ambient.
        {},
      );

      const tags = db.queries.map((q) => q.tag);
      // Ровно одна транзакция, и запрос внутри внутреннего вызова попал
      // именно в её executor, а не в base.
      expect(db.transactionOptions.length).toBe(1);
      expect(tags.length).toBe(1);
      expect(tags[0]?.startsWith('trx-')).toBe(true);

      // После завершения обоих вызовов контекст очищен.
      expect(getActiveTransaction()).toBeUndefined();
      await UserEntity.count({});
      expect(db.queries[db.queries.length - 1].tag).toBe('base');
    });
  });

  describe('warnOutsideTransaction (#98)', () => {
    let warnSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('does not warn by default', async () => {
      const { moduleRef } = await createTestingModule(db);
      try {
        await UserEntity.count({});
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        await moduleRef.close();
      }
    });

    it('warns only when explicitly configured, and stays silent inside a transaction', async () => {
      const { moduleRef, txManager } = await createTestingModule(db, {
        warnOutsideTransaction: true,
      });
      try {
        await UserEntity.count({});
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toMatch(
          /outside any transaction/,
        );

        warnSpy.mockClear();
        await txManager.runInTransaction(
          async () => {
            await UserEntity.count({});
          },
          { ambient: true },
        );
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        await moduleRef.close();
      }
    });
  });

  describe('options propagation through DI (#98)', () => {
    it('isolation/signal/timeout reach the transaction() call of the db', async () => {
      const { moduleRef, txManager } = await createTestingModule(db);
      try {
        const controller = new AbortController();
        controller.abort();

        let callbackSignal: AbortSignal | undefined;

        await txManager.runInTransaction(
          (_trx, signal) => {
            callbackSignal = signal;
            return Promise.resolve();
          },
          {
            isolation: 'snapshotReadWrite',
            idempotent: true,
            timeout: 60_000,
            signal: controller.signal,
          },
        );

        const opts = db.transactionOptions[0];
        expect(opts.isolation).toBe('snapshotReadWrite');
        expect(opts.idempotent).toBe(true);
        // Пользовательский сигнал уходит в SDK как есть — глобальный.
        expect(opts.signal).toBe(controller.signal);
        // Колбэк получает сигнал попытки, в который прокинут глобальный.
        expect(callbackSignal?.aborted).toBe(true);
      } finally {
        await moduleRef.close();
      }
    });
  });
});
