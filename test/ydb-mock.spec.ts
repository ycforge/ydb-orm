import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import {
  createScriptedExecutor,
  abortError,
  UnexpectedMockQueryError,
} from './helpers/ydb-mock.js';
import {
  unavailableError,
  abortedTransactionError,
  schemeError,
  commitError,
} from './helpers/ydb-responses.js';
import { isTransientYdbError } from '../src/core/retry.js';

/**
 * Контракт программного мока (#109): сам по себе это инфраструктура, но
 * контракт ниже фиксирует строгую семантику, на которую опираются все
 * сценарные тесты:
 *  - неожиданный SQL/порядок/контекст — немедленная ошибка;
 *  - неистребованные шаги ловятся assertComplete();
 *  - транзакция моделируется begin → тело → commit | rollback;
 *  - отмена сигналом наблюдаема, а не проглатывается.
 */

describe('createScriptedExecutor (#109)', () => {
  describe('очередь шагов и результаты', () => {
    it('выдаёт каждому вызову СВОЙ набор result sets в порядке очереди', async () => {
      const db = createScriptedExecutor();
      db.expect('SELECT COUNT(*)').returnsRows({ cnt: 7 });
      db.expect('SELECT * FROM users').returnsRows(
        { uuid: 'u1' },
        { uuid: 'u2' },
      );
      db.expect(/UPSERT INTO/).returns([]);

      await db.executor(['SELECT COUNT(*) FROM users'] as any);
      const first = await db.executor(['SELECT * FROM users'] as any);
      await db.executor(['UPSERT INTO `users`'] as any);

      // Результат запроса — массив result sets (как у @ydbjs/query)
      expect(first).toEqual([[{ uuid: 'u1' }, { uuid: 'u2' }]]);
      // Параметры и SQL записываются по-прежнему
      expect(db.calls.map((c) => c.sql)).toEqual([
        'SELECT COUNT(*) FROM users',
        'SELECT * FROM users',
        'UPSERT INTO `users`',
      ]);
    });

    it('параметры цепочки parameter() записываются на вызов', async () => {
      const db = createScriptedExecutor();
      db.expect('INSERT INTO t').returns([]);
      db.expect('INSERT INTO t').returns([]);

      await db.executor(['INSERT INTO t VALUES ($a)'] as any).parameter('a', 1);
      await db.executor(['INSERT INTO t VALUES ($b)'] as any).parameter('b', 2);

      expect(db.calls[0].params).toEqual({ a: 1 });
      expect(db.calls[1].params).toEqual({ b: 2 });
    });

    it('шаг с .throws() отклоняет ровно свой вызов', async () => {
      const db = createScriptedExecutor();
      db.expect('first').returnsRows({ ok: true });
      db.expect('second').throws(unavailableError());
      db.expect('third').returns([]);

      await db.executor(['first query'] as any);
      await expect(db.executor(['second query'] as any)).rejects.toThrow(
        'session unavailable',
      );
      await db.executor(['third query'] as any);

      expect(db.calls[1].sql).toBe('second query');
    });

    it('timeout/signal/idempotent/cancel наблюдаются на записанных вызовах', async () => {
      const db = createScriptedExecutor();
      db.expect('q').returns([]);
      const signal = new AbortController().signal;

      const q = db.executor(['query'] as any);
      q.timeout(500).signal(signal).idempotent(true);
      await q;

      expect(db.calls[0].timeoutMs).toBe(500);
      expect(db.calls[0].signal).toBe(signal);
      expect(db.calls[0].idempotent).toBe(true);
      expect(db.calls[0].cancelled).toBe(false);
    });

    it('cancel() фиксируется на вызове', () => {
      const db = createScriptedExecutor();
      db.expect('q').returns([]);
      db.executor(['query'] as any).cancel();

      expect(db.calls[0].cancelled).toBe(true);
    });
  });

  describe('строгость: неожиданный SQL и порядок', () => {
    it('неожиданный SQL падает НЕМЕДЛЕННО из then() запроса', async () => {
      const db = createScriptedExecutor();
      db.expect('SELECT expected').returns([]);

      const error = await db.executor(['UPDATE unexpected'] as any).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(UnexpectedMockQueryError);
      // Сообщение содержит и фактический, и ожидаемый SQL, и номер шага.
      expect((error as Error).message).toBe(
        '[db] unexpected base query #1: "UPDATE unexpected". ' +
          'Expected step #1: "…SELECT expected…".',
      );
    });

    it('нарушение порядка шагов обнаруживается так же строго', async () => {
      const db = createScriptedExecutor();
      db.expect('first').returns([]);
      db.expect('second').returns([]);

      // first пропущен: сразу second → ошибка с указанием ожидаемого шага
      await expect(db.executor(['second query'] as any)).rejects.toThrow(
        /Expected step #1: "…first…"/,
      );
    });

    it('исчерпанная очередь — тоже неожиданный вызов', async () => {
      const db = createScriptedExecutor();
      db.expect('only one').returns([]);

      await db.executor(['only one query'] as any);
      await expect(db.executor(['extra query'] as any)).rejects.toThrow(
        /\(queue is empty\)/,
      );
    });

    it('.inTransaction(): шаг вне транзакции запрещён', async () => {
      const db = createScriptedExecutor();
      db.expect('WRITE').inTransaction().returns([]);

      await expect(db.executor(['WRITE query'] as any)).rejects.toThrow(
        /must run inside a transaction/,
      );
    });

    it('.outsideTransaction(): чтение внутри транзакции помечается ошибкой', async () => {
      const db = createScriptedExecutor();
      db.expect('DDL').outsideTransaction().returns([]);

      await expect(
        db.transaction({ idempotent: true }).execute(async (trx) => {
          await trx(['DDL query'] as unknown as TemplateStringsArray);
        }),
      ).rejects.toThrow(UnexpectedMockQueryError);
    });
  });

  describe('assertComplete: неистребованные шаги', () => {
    it('падает с перечнем неистребованных шагов', async () => {
      const db = createScriptedExecutor({ label: 'users-db' });
      db.expect('executed').returns([]);
      db.expect('never-executed-a').returns([]);
      db.expect('never-executed-b').returns([]);

      await db.executor(['executed query'] as any);

      expect(() => db.assertComplete()).toThrow(
        /\[users-db\] 2 expected query step\(s\) were never executed: #2 "…never-executed-a…"; #3 "…never-executed-b…"/,
      );
    });

    it('после полного исполнения сценария не падает', async () => {
      const db = createScriptedExecutor();
      db.expect('done').returns([]);
      await db.executor(['done query'] as any);
      expect(() => db.assertComplete()).not.toThrow();
    });
  });

  describe('транзакции: begin/commit/rollback как события', () => {
    it('успешное тело: begin → шаги в scope trx-N → commit', async () => {
      const db = createScriptedExecutor({ label: 'tx-db' });
      db.expect('READ').inTransaction().returnsRows({ v: 1 });
      db.expect('WRITE').inTransaction().returns([]);

      await db
        .transaction({ isolation: 'serializableReadWrite' })
        .execute(async (trx) => {
          await trx(['READ x'] as unknown as TemplateStringsArray);
          await trx(['WRITE y'] as unknown as TemplateStringsArray);
        });

      expect(db.transactionEvents).toHaveLength(2);
      const [begin, commit] = db.transactionEvents;
      expect(begin.type).toBe('begin');
      expect(commit.type).toBe('commit');
      expect(begin.label).toBe(commit.label);
      // Шаги исполнились ВНУТРИ транзакции (scope), а не на базовом executor
      expect(db.calls.map((c) => c.scope)).toEqual([begin.label, begin.label]);
      expect(db.transactionOptions[0]).toMatchObject({
        isolation: 'serializableReadWrite',
      });
    });

    it('сбой тела: rollback вместо commit, ошибка пробрасывается', async () => {
      const db = createScriptedExecutor();
      const failure = abortedTransactionError();
      db.expect('WRITE').inTransaction().throws(failure);

      await expect(
        db.transaction({ idempotent: true }).execute(async (trx) => {
          await trx(['WRITE x'] as unknown as TemplateStringsArray);
        }),
      ).rejects.toBe(failure);

      expect(db.transactionEvents.map((e) => e.type)).toEqual([
        'begin',
        'rollback',
      ]);
      const rollback = db.transactionEvents[1];
      if (rollback.type === 'rollback') {
        expect(rollback.error).toBe(failure);
      } else {
        throw new Error('expected rollback event');
      }
    });

    it('ошибка ПОСЛЕ успешных шагов: шаги исполнены, но коммита нет', async () => {
      const db = createScriptedExecutor();
      db.expect('WRITE a').inTransaction().returns([]);
      const boom = new Error('app logic failed');

      await expect(
        db.transaction().execute(async (trx) => {
          await trx(['WRITE a'] as unknown as TemplateStringsArray);
          throw boom;
        }),
      ).rejects.toBe(boom);

      // Запрос прошёл (записан), но транзакция завершилась rollback —
      // «операции после сбоя не появляются закоммиченными».
      expect(db.calls).toHaveLength(1);
      expect(db.transactionEvents.map((e) => e.type)).toEqual([
        'begin',
        'rollback',
      ]);
    });

    it('вложенные execute() у одного handle невозможны, но последовательные транзакции независимы', async () => {
      const db = createScriptedExecutor();
      db.expect('one').inTransaction().returns([]);
      db.expect('two').inTransaction().returns([]);

      const handle = db.transaction();
      await handle.execute(async (trx) => {
        await trx(['one q'] as unknown as TemplateStringsArray);
      });
      await handle.execute(async (trx) => {
        await trx(['two q'] as unknown as TemplateStringsArray);
      });

      const labels = db.transactionEvents
        .filter((e) => e.type === 'begin')
        .map((e) => e.label);
      expect(new Set(labels).size).toBe(2);
    });
  });

  describe('отмена и таймаут наблюдаемы', () => {
    it('hangsUntilAbort резолвится AbortError только отменой переданного сигнала', async () => {
      const db = createScriptedExecutor();
      db.expect('long scan').hangsUntilAbort();

      const controller = new AbortController();
      const promise = Promise.resolve(
        db.executor(['long scan'] as any).signal(controller.signal),
      );

      // До отмены промис висит: микрозадачи не резолвят его
      let settled = false;
      void promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);

      controller.abort();
      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
      });
      // Отмена видна и на записи вызова
      expect(db.calls[0].signal?.aborted).toBe(true);
    });

    it('уже отменённый сигнал отклоняет hangsUntilAbort немедленно', async () => {
      const db = createScriptedExecutor();
      db.expect('slow').hangsUntilAbort();

      const controller = new AbortController();
      controller.abort();

      await expect(
        Promise.resolve(db.executor(['slow'] as any).signal(controller.signal)),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('abortError() имеет имя AbortError — как у SDK при отмене', () => {
      expect(abortError('cancelled').name).toBe('AbortError');
      expect(abortError().message).toContain('aborted');
    });
  });

  describe('совместимость с обёртками ORM', () => {
    it('переживает двойной then() одного запроса (PromiseLike)', async () => {
      const db = createScriptedExecutor();
      db.expect('q').returnsRows({ n: 1 });

      const query = db.executor(['q'] as any);
      const [viaFirst, viaSecond] = await Promise.all([query, query]);
      // Один шаг исполняется ровно один раз, результат кеширован
      expect(viaFirst).toEqual(viaSecond);
      expect(db.calls).toHaveLength(1);
    });
  });
});

describe('фабрики ответов/ошибок (#109)', () => {
  it('commitError сохраняет причину для классификации', () => {
    const cause = unavailableError();
    const error = commitError(cause);
    expect(error.cause).toBe(cause);
  });

  it('статусные ошибки несут код YDB', () => {
    expect(unavailableError().code).toBe(StatusIds_StatusCode.UNAVAILABLE);
    expect(abortedTransactionError().code).toBe(StatusIds_StatusCode.ABORTED);
    // Транзитные по классификации ORM (#27)
    expect(isTransientYdbError(unavailableError())).toBe(true);
    expect(isTransientYdbError(schemeError())).toBe(false);
  });
});
