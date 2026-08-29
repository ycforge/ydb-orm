import { describe, it, expect } from '@jest/globals';
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Code } from '@ydbjs/api/operation';
import { withRetryPolicy } from '../src/index.js';
import type { YdbRetrySleepFn } from '../src/index.js';
import { createScriptedExecutor, abortError } from './helpers/ydb-mock.js';

/**
 * Регресс-тесты одиночного исполнения и отмены прокси retry-политики
 * (#172): два await/подписчика на одном запросе не дублируют обращение
 * к БД, а cancel() останавливает операцию целиком — до исполнения, во
 * время попытки и на backoff между попытками.
 */

function ydbErr(code: number): YDBError {
  return new YDBError(code, []);
}

function recordingSleep(): YdbRetrySleepFn {
  return () => Promise.resolve();
}

/** Ждёт, пока запрошенное число реальных обращений к БД состоялось. */
async function waitForCalls(db: { calls: { awaited: boolean }[] }, n: number) {
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (db.calls.length >= n && db.calls[n - 1].awaited) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
}

describe('retry-прокси: одиночное исполнение операции (#172)', () => {
  it('два .then() одного запроса выполняют запрос один раз (idempotent)', async () => {
    const db = createScriptedExecutor({ label: 'settle' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`.idempotent(true);

    const [a, b] = await Promise.all([query, query]);

    expect(a).toEqual([[{ id: 1 }]]);
    expect(b).toEqual([[{ id: 1 }]]);
    // Ровно одна попытка БД: второй await не тронул сценарий.
    db.assertComplete();
    expect(db.calls).toHaveLength(1);
  });

  it('повторный await того же запроса не дублирует запрос (не idempotent)', async () => {
    const db = createScriptedExecutor({ label: 'settle' });
    db.expect('UPSERT INTO t').returns([[]]);
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`UPSERT INTO t (id) VALUES (1)`;

    await query;
    await query;

    db.assertComplete();
    expect(db.calls).toHaveLength(1);
  });

  it('подписки через .then() не порождают дополнительных попыток при повторе', async () => {
    const db = createScriptedExecutor({ label: 'retry' });
    db.expect('SELECT 2').throws(ydbErr(Code.ABORTED));
    db.expect('SELECT 2').returnsRows({ ok: true });
    const wrapped = withRetryPolicy(db.executor, {
      jitterRatio: 0,
      rng: () => 0,
      sleep: recordingSleep(),
    });
    const query = wrapped`SELECT 2`.idempotent(true);

    // Обе подписки висят на ОДНОМ общем исполнении: сценарий из двух шагов
    // (попытка 1 — ошибка, попытка 2 — успех) потребляется ровно один раз.
    const results = await Promise.all([query.then(), query.then()]);
    expect(results[0]).toEqual([[{ ok: true }]]);
    expect(results[1]).toEqual([[{ ok: true }]]);
    db.assertComplete();
  });
});

describe('retry-прокси: отмена до исполнения (#172)', () => {
  it('cancel() до первого .then() — ни одного обращения к БД', async () => {
    const db = createScriptedExecutor({ label: 'cancel' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`;

    query.cancel();

    await expect(query).rejects.toMatchObject({ name: 'AbortError' });
    // Сценарий не потреблён — обращения к БД не было вовсе.
    expect(db.calls).toHaveLength(0);
  });

  it('cancel() до исполнения не даёт стартовать и idempotent-запросу', async () => {
    const db = createScriptedExecutor({ label: 'cancel' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`.idempotent(true);

    query.cancel();

    await expect(query).rejects.toMatchObject({ name: 'AbortError' });
    expect(db.calls).toHaveLength(0);
  });
});

describe('retry-прокси: отмена во время попытки (#172)', () => {
  it('cancel() гасит летящую попытку и не запускает новые', async () => {
    const db = createScriptedExecutor({ label: 'cancel' });
    db.expect('SELECT 1').hangsUntilAbort();
    const wrapped = withRetryPolicy(db.executor, {
      maxAttempts: 5,
      sleep: recordingSleep(),
    });
    const query = wrapped`SELECT 1`.idempotent(true);

    // Запускаем исполнение в фоне: первый .then() создаёт общую операцию.
    const running = Promise.resolve(query);
    await waitForCalls(db, 1);
    query.cancel();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    // cancel() дошёл и до SDK-запроса (current.cancel()).
    expect(db.calls[0]?.cancelled).toBe(true);
    // Ровно одна попытка: последующие не стартовали.
    expect(db.calls).toHaveLength(1);
  });
});

describe('retry-прокси: отмена на backoff (#172)', () => {
  function pendingSleep(): {
    sleep: YdbRetrySleepFn;
  } {
    // Задержка никогда не резолвится сама по себе — только отменой сигнала.
    const sleep: YdbRetrySleepFn = (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError('aborted by cancel'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(abortError('aborted by cancel')),
          {
            once: true,
          },
        );
      });
    return { sleep };
  }

  it('cancel() на паузе между попытками останавливает операцию', async () => {
    const db = createScriptedExecutor({ label: 'cancel' });
    db.expect('SELECT 1').throws(ydbErr(Code.ABORTED));
    const { sleep } = pendingSleep();
    const wrapped = withRetryPolicy(db.executor, {
      maxAttempts: 5,
      jitterRatio: 0,
      rng: () => 0,
      sleep,
    });
    const query = wrapped`SELECT 1`.idempotent(true);

    // Первая попытка упала и ушла в backoff (sleep больше не резолвится).
    const running = Promise.resolve(query);
    await waitForCalls(db, 1);
    query.cancel();

    await expect(running).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('aborted by cancel'),
    });
    // Вторая попытка НЕ стартовала: backoff прерван отменой.
    expect(db.calls).toHaveLength(1);
  });
});

describe('retry-прокси: защита от мутаций после старта исполнения (#205)', () => {
  it('parameter() после await бросает ошибку', async () => {
    const db = createScriptedExecutor({ label: 'mutate' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`.idempotent(true);

    await query;
    expect(() => query.parameter('x', 1)).toThrow(
      /Cannot call \.parameter\(\) after query execution has started/,
    );
  });

  it('timeout() после await бросает ошибку', async () => {
    const db = createScriptedExecutor({ label: 'mutate' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`.idempotent(true);

    await query;
    expect(() => query.timeout(1000)).toThrow(
      /Cannot call \.timeout\(\) after query execution has started/,
    );
  });

  it('signal() после await бросает ошибку', async () => {
    const db = createScriptedExecutor({ label: 'mutate' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`.idempotent(true);

    await query;
    expect(() => query.signal(AbortSignal.timeout(1000))).toThrow(
      /Cannot call \.signal\(\) after query execution has started/,
    );
  });

  it('idempotent() после await бросает ошибку', async () => {
    const db = createScriptedExecutor({ label: 'mutate' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`.idempotent(true);

    await query;
    expect(() => query.idempotent(false)).toThrow(
      /Cannot call \.idempotent\(\) after query execution has started/,
    );
  });

  it('cancel() после await продолжает работать', async () => {
    const db = createScriptedExecutor({ label: 'mutate' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`.idempotent(true);

    await query;
    // cancel() должен не бросать, а просто возвращать proxy
    expect(query.cancel()).toBe(query);
  });

  it('mutation до await разрешена', async () => {
    const db = createScriptedExecutor({ label: 'mutate' });
    db.expect('SELECT 1').returnsRows({ id: 1 });
    const wrapped = withRetryPolicy(db.executor, {});
    const query = wrapped`SELECT 1`;

    query.parameter('x', 1);
    query.timeout(1000);
    query.signal(AbortSignal.timeout(1000));
    query.idempotent(true);

    await query;
    db.assertComplete();
  });
});
