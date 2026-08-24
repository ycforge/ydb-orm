import { jest } from '@jest/globals';
import type {
  YdbExecutor,
  YdbQuery,
  YdbTransactionOptions,
} from '../../src/index.js';

/**
 * Программируемый детерминированный мок YdbExecutor (#109).
 *
 * В отличие от легаси-`createMockExecutor` (один набор result sets на все
 * вызовы или «каждый N-й вызов получает свой»), этот мок требует ЯВНОЙ
 * сценарной очереди шагов:
 *
 *   const db = createScriptedExecutor();
 *   db.expect('SELECT COUNT(*)').returnsRows([{ cnt: 1 }]);
 *   db.expect(/UPSERT INTO `users`/)
 *     .inTransaction()
 *     .throws(unavailableError());
 *   await db.transaction().execute(async (trx) => { ... });
 *   db.assertComplete(); // неистребованные шаги — падение теста
 *
 * Строгость:
 *  - неожиданный SQL или нарушение порядка — НЕМЕДЛЕННАЯ ошибка из `then`
 *    запроса (fail fast), с ожидаемым и фактическим SQL в сообщении;
 *  - неистребованные шаги ловятся `assertComplete()` — вызывайте его
 *    в конце теста (или через afterEach);
 *  - транзакция моделируется как begin → тело → commit | rollback:
 *    события фиксируются, а не просто считаются; после rollback ни один
 *    последующий шаг очереди не может быть исполнен («коммита нет —
 *    записей нет»);
 *  - AbortSignal/timeout/cancel ЗАПИСЫВАЮТСЯ на каждый вызов; шаг с
 *    `.hangsUntilAbort()` резолвится только отменой — отмена наблюдаема;
 *  - мок НЕ эмулирует то, чего не гарантирует реальный SDK: никаких
 *    внутренних ретраев, никакой невидимой проверки уже-абортнутого
 *    сигнала у мгновенных шагов.
 */

/** Один записанный вызов query: SQL, параметры и опции цепочки. */
export interface RecordedCall {
  /** Текст SQL (strings[0] шаблонной строки). */
  sql: string;
  /** Параметры, собранные .parameter(name, value). */
  params: Record<string, unknown>;
  /** Значения .timeout(ms) — если заданы. */
  timeoutMs?: number;
  /** Сигнал из .signal(sig) — если задан. */
  signal?: AbortSignal;
  /** Вызывался ли .cancel(). */
  cancelled: boolean;
  /** Вызывался ли .idempotent(...) и с каким значением. */
  idempotent?: boolean;
  /** Где исполнялся вызов: 'base' — вне транзакции, иначе метка транзакции. */
  scope: string;
  /**
   * Был ли запрос реально отправлен (then() вызван). У реального SDK Query
   * исполнение ленивое: создание запроса ≠ отправка. false при раннем
   * отказе до await (например, пред-абортнутый сигнал в executeQuery).
   */
  awaited: boolean;
}

/** Событие жизненного цикла транзакции. */
export type TransactionEvent =
  | { type: 'begin'; options: YdbTransactionOptions | undefined; label: string }
  | { type: 'commit'; label: string }
  | { type: 'rollback'; label: string; error: unknown };

/** Шаг сценария: ожидаемый SQL + поведение при совпадении. */
interface ScriptStep {
  pattern: string | RegExp;
  /** Result sets запроса: массив массивов строк. */
  resultSets: any[][];
  /** Ошибка для отклонения запроса. */
  error?: Error;
  /** Шаг обязан исполняться внутри транзакции. */
  requireTransaction: boolean;
  /** Шаг обязан исполняться ВНЕ транзакции. */
  forbidTransaction: boolean;
  /** Шаг «висит», пока сигнал не будет отменён (наблюдаемая отмена). */
  hangsUntilAbort: boolean;
}

/**
 * Ошибка несоответствия сценария: неожиданный SQL, порядок или контекст.
 * Отдельный класс — чтобы тесты могли отличать её от прикладных ошибок.
 */
export class UnexpectedMockQueryError extends Error {
  constructor(
    message: string,
    readonly receivedSql: string,
  ) {
    super(message);
    this.name = 'UnexpectedMockQueryError';
  }
}

/** Опции создания мока. */
export interface ScriptedExecutorOptions {
  /**
   * Метка экземпляра (попадает в сообщения об ошибках) — удобно, когда
   * в тесте два мока: «база» и «транзакция».
   */
  label?: string;
}

/** Дескриптор одного ожидания — текучий интерфейс настройки шага. */
export interface StepBuilder {
  /** Задаёт result sets запроса (массив result sets; один — передайте rows). */
  returns(resultSets: any[][]): StepBuilder;
  /** Сахар над returns: ровно один result set из перечисленных строк. */
  returnsRows(...rows: Record<string, unknown>[]): StepBuilder;
  /** Запрос отклоняется этой ошибкой. */
  throws(error: Error): StepBuilder;
  /** Шаг должен исполняться внутри открытой транзакции. */
  inTransaction(): StepBuilder;
  /** Шаг должен исполняться вне транзакции. */
  outsideTransaction(): StepBuilder;
  /** Шаг не резолвится, пока сигнал запроса не отменят (AbortError). */
  hangsUntilAbort(): StepBuilder;
}

export interface ScriptedMockExecutor {
  executor: YdbExecutor;
  /** Сахар над executor.transaction(options) — тот же хэндл. */
  transaction(options?: YdbTransactionOptions): {
    execute<T>(
      fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
    ): Promise<T>;
  };
  /** Все вызовы query по порядку (включая исполненные в транзакциях). */
  calls: RecordedCall[];
  /** События begin/commit/rollback всех транзакций по порядку. */
  transactionEvents: TransactionEvent[];
  /** Опции каждой transaction(options). */
  transactionOptions: Array<YdbTransactionOptions | undefined>;
  /** Добавляет следующий шаг сценария (матч по подстроке или регэкспу). */
  expect(pattern: string | RegExp): StepBuilder;
  /** Метка экземпляра. */
  readonly label: string;
  /**
   * Падает, если остались неистребованные шаги сценария. Вызывайте
   * в конце каждого теста — «missing expected call» должно ронять тест.
   */
  assertComplete(): void;
}

/** Нормализует шаг: строки матчатся подстрокой, регэкспы — test(). */
function matchesPattern(pattern: string | RegExp, sql: string): boolean {
  if (typeof pattern === 'string') return sql.includes(pattern);
  return pattern.test(sql);
}

function describePattern(pattern: string | RegExp): string {
  return typeof pattern === 'string' ? `"…${pattern}…"` : String(pattern);
}

const ABORT_ERROR_NAME = 'AbortError';

/** Создаёт ошибку вида AbortError (как у SDK при отмене запроса). */
export function abortError(message = 'The operation was aborted'): Error {
  const error = new Error(message);
  error.name = ABORT_ERROR_NAME;
  return error;
}

/**
 * Ждёт отмены сигнала (или немедленно, если уже отменён) и резолвится
 * ошибкой вида AbortError — так отмена в тесте НАБЛЮДАЕМА: без .signal()
 * или без abort() шаг никогда не завершится и тест упадёт по таймауту.
 */
function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener('abort', () => reject(abortError()), {
      once: true,
    });
  });
}

export function createScriptedExecutor(
  options: ScriptedExecutorOptions = {},
): ScriptedMockExecutor {
  const label = options.label ?? 'db';
  const steps: ScriptStep[] = [];
  let cursor = 0;
  let openTransactionLabel: string | undefined;
  let txCounter = 0;

  const calls: RecordedCall[] = [];
  const transactionEvents: TransactionEvent[] = [];
  const transactionOptions: Array<YdbTransactionOptions | undefined> = [];

  function nextStepFor(sql: string, scope: string): ScriptStep {
    // Строгий порядок: только СЛЕДУЮЩИЙ шаг сценария может принять вызов.
    const step = steps[cursor];
    if (!step || !matchesPattern(step.pattern, sql)) {
      const expected =
        step === undefined ? '(queue is empty)' : describePattern(step.pattern);
      throw new UnexpectedMockQueryError(
        `[${label}] unexpected ${scope} query #${calls.length}: "${sql}". ` +
          `Expected step #${cursor + 1}: ${expected}.`,
        sql,
      );
    }
    if (step.requireTransaction && !openTransactionLabel) {
      throw new UnexpectedMockQueryError(
        `[${label}] step #${cursor + 1} (${describePattern(step.pattern)}) ` +
          `must run inside a transaction, but no transaction is active.`,
        sql,
      );
    }
    if (step.forbidTransaction && openTransactionLabel) {
      throw new UnexpectedMockQueryError(
        `[${label}] step #${cursor + 1} (${describePattern(step.pattern)}) ` +
          `must run OUTSIDE a transaction, but "${openTransactionLabel}" is active.`,
        sql,
      );
    }
    cursor += 1;
    return step;
  }

  function buildQuery(sql: string, record: RecordedCall): YdbQuery {
    // then() ленивый: матчинг шага и исполнение происходят только при
    // реальном ожидании промиса — как у SDK Query (ленивое исполнение).
    let settled: Promise<any> | undefined;

    const query: any = {
      parameter(name: string, value: unknown) {
        record.params[name] = value;
        return query;
      },
      timeout(ms: number) {
        record.timeoutMs = ms;
        return query;
      },
      signal(signal: AbortSignal) {
        record.signal = signal;
        return query;
      },
      idempotent(flag?: boolean) {
        record.idempotent = flag !== false;
        return query;
      },
      cancel() {
        record.cancelled = true;
        return query;
      },
      on(): typeof query {
        /* SDK-события ('retry') в моке не эмулируются: их нет у реального
         * запроса до сбоя транспорта. Политика ORM корректно работает и
         * без подписки (см. retry-executor.ts). */
        return query;
      },
      then(onFulfilled?: any, onRejected?: any) {
        if (!settled) {
          record.awaited = true;
          const scope = record.scope;
          let step: ScriptStep;
          try {
            step = nextStepFor(sql, scope);
          } catch (error) {
            settled = Promise.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
            return settled.then(onFulfilled, onRejected);
          }

          if (step.error) {
            settled = Promise.reject(step.error);
          } else if (step.hangsUntilAbort) {
            // rejectOnAbort всегда резолвится Error-ом вида AbortError
            settled = rejectOnAbort(record.signal);
          } else {
            settled = Promise.resolve(step.resultSets);
          }
        }
        return settled.then(onFulfilled, onRejected);
      },
    };
    return query as YdbQuery;
  }

  function makeScopedExecutor(scope: string): YdbExecutor {
    const scoped: any = jest.fn((strings: TemplateStringsArray) => {
      const sql = strings[0];
      const record: RecordedCall = {
        sql,
        params: {},
        cancelled: false,
        scope,
        awaited: false,
      };
      calls.push(record);
      return buildQuery(sql, record);
    });
    return scoped as YdbExecutor;
  }

  const executor = makeScopedExecutor('base');

  (executor as any).transaction = (
    options?: YdbTransactionOptions,
  ): {
    execute<T>(
      fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
    ): Promise<T>;
  } => {
    transactionOptions.push(options);
    return {
      execute: async <T>(
        fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
      ): Promise<T> => {
        const trxLabel = `${label}-trx-${++txCounter}`;
        transactionEvents.push({ type: 'begin', options, label: trxLabel });

        // У транзакции свой executor-«сессия»: видно, какой executor
        // реально выполнил каждый шаг, но очередь сценария общая —
        // порядок begin→шаги→commit|rollback проверяется глобально.
        const prevOpen = openTransactionLabel;
        openTransactionLabel = trxLabel;
        try {
          const result = await fn(makeScopedExecutor(trxLabel));
          transactionEvents.push({ type: 'commit', label: trxLabel });
          return result;
        } catch (error) {
          transactionEvents.push({
            type: 'rollback',
            label: trxLabel,
            error,
          });
          throw error;
        } finally {
          openTransactionLabel = prevOpen;
        }
      },
    };
  };

  function expect(pattern: string | RegExp): StepBuilder {
    const step: ScriptStep = {
      pattern,
      resultSets: [[]],
      requireTransaction: false,
      forbidTransaction: false,
      hangsUntilAbort: false,
    };
    steps.push(step);

    const builder: StepBuilder = {
      returns(resultSets: any[][]) {
        step.resultSets = resultSets;
        return builder;
      },
      returnsRows(...rows: Record<string, unknown>[]) {
        step.resultSets = [rows];
        return builder;
      },
      throws(error: Error) {
        step.error = error;
        return builder;
      },
      inTransaction() {
        step.requireTransaction = true;
        step.forbidTransaction = false;
        return builder;
      },
      outsideTransaction() {
        step.forbidTransaction = true;
        step.requireTransaction = false;
        return builder;
      },
      hangsUntilAbort() {
        step.hangsUntilAbort = true;
        return builder;
      },
    };
    return builder;
  }

  function assertComplete(): void {
    if (cursor >= steps.length) return;
    const pending = steps
      .slice(cursor)
      .map((s, i) => `#${cursor + i + 1} ${describePattern(s.pattern)}`);
    throw new Error(
      `[${label}] ${pending.length} expected query step(s) were never executed: ` +
        pending.join('; '),
    );
  }

  const mock: ScriptedMockExecutor = {
    executor,
    transaction: ((options?: YdbTransactionOptions) =>
      (executor as any).transaction(
        options,
      )) as ScriptedMockExecutor['transaction'],
    calls,
    transactionEvents,
    transactionOptions,
    expect,
    label,
    assertComplete,
  };

  return mock;
}
