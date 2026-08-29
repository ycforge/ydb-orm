import { resolveYdbRetryPolicy, runWithRetry } from '../core/retry.js';
import type { YdbRetryPolicyInput } from '../core/retry.js';
import type {
  YdbExecutor,
  YdbIsolationLevel,
  YdbTransactionOptions,
  YdbTransactionsSettings,
} from '../core/interfaces.js';
import {
  getActiveTransaction,
  resolveTransactionSettings,
  runWithTransactionContext,
  TRANSACTION_ID_KEY,
} from './transaction-context.js';

/** Генерирует уникальный идентификатор транзакции. */
function generateTransactionId(): symbol {
  return Symbol('transaction');
}

/**
 * Опции runInTransaction() (#98).
 *
 * Наследует опции исполнения YDB-транзакции (isolation/signal/timeout/
 * idempotent) и добавляет управление контекстом:
 *
 * - reuse — при вложенном вызове переиспользовать уже активную транзакцию
 *   вместо ошибки. Транзакция остаётся под управлением внешнего вызова:
 * внутренний колбэк не коммитит и не откатывает её самостоятельно.
 * - ambient — принудительно пробросить эту транзакцию в ambient-контекст
 *   (операции без явного { trx } будут выполняться в ней), даже если
 *   ambient выключен глобально. Работает и при вложенном `{ reuse: true }`:
 *   создаётся вложенный контекст с транзакцией внешнего вызова (коммит/
 *   откат по-прежнему у внешнего вызова). Значение false НЕ отключает
 *   глобальный ambient — используйте для этого настройки модуля.
 * - retry — retry-политика ORM по типу ошибки (#27): `true` — дефолты
 *   (maxAttempts: 3, bounded backoff + jitter), объект — кастомная политика.
 *   Когда политика задана, владение повторами тела ПЕРЕХОДИТ от SDK к ORM:
 *   на каждую попытку политики приходится ровно одна попытка тела (внутренний
 *   цикл SDK гасится), максимум исполнений колбэка равен maxAttempts —
 *   попытки не перемножаются. Без политики поведение прежнее (#98): тело
 *   ретраит SDK по своим правилам (неограниченный бюджет). Контракт
 *   идемпотентности — на КОЛБЭК целиком (#98): пометки .idempotent()
 *   отдельных запросов внутри тела SDK игнорирует и на повтор колбэка
 *   не влияют.
 */
export interface RunInTransactionOptions extends YdbTransactionOptions {
  reuse?: boolean;
  ambient?: boolean;
  retry?: YdbRetryPolicyInput;
}

/** Допустимые уровни изоляции — для fail-fast валидации опций. */
const ISOLATION_LEVELS: readonly YdbIsolationLevel[] = [
  'serializableReadWrite',
  'snapshotReadOnly',
  'snapshotReadWrite',
];

/** Ключи, допустимые в RunInTransactionOptions (защита от опечаток). */
const ALLOWED_OPTION_KEYS = new Set([
  'isolation',
  'signal',
  'timeout',
  'idempotent',
  'reuse',
  'ambient',
  'retry',
]);

/**
 * Маркер «внутренний ретрай SDK вытеснен политикой ORM» (#27): бросается
 * телом транзакции, когда SDK пытается начать попытку сверх лимита политики.
 * Для предиката повтора SDK это заведомо неповторяемая ошибка — цикл SDK
 * завершается; наружу пробрасывается исходная ошибка последней попытки.
 */
class SdkRetrySupersededError extends Error {
  constructor(readonly lastError: unknown) {
    super('SDK transaction retry superseded by the ORM retry policy (#27)');
    this.name = 'SdkRetrySupersededError';
  }
}

/** Глубина обхода cause-цепочки при распаковке ошибки транзакции. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Распаковывает ошибку execute(): SDK заворачивает неповторяемые ошибки
 * транзакции в Error('Transaction failed.', { cause }). Если в цепочке
 * найден маркер вытесненного ретрая — наружу идёт ИСХОДНАЯ ошибка
 * последней попытки (для классификации политикой), иначе ошибка как есть.
 */
function unwrapTransactionError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof SdkRetrySupersededError) {
      return (
        current.lastError ??
        new Error(
          'Previous transaction attempt failed (the failure occurred outside the ' +
            'transaction body, e.g. at commit); the original error is not available.',
        )
      );
    }
    const cause: unknown = (current as { cause?: unknown })?.cause;
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  return error;
}

/**
 * Fail-fast валидация опций транзакции: неизвестный ключ или невалидное
 * значение — ошибка конфигурации сразу, а не тихо проигнорированная опция.
 */
export function validateRunInTransactionOptions(
  options?: RunInTransactionOptions,
): void {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null) {
    throw new Error(
      'runInTransaction(): options must be an object if provided.',
    );
  }

  const unknown = Object.keys(options).filter(
    (key) => !ALLOWED_OPTION_KEYS.has(key),
  );
  if (unknown.length) {
    throw new Error(
      `runInTransaction(): unknown option(s) "${unknown.join('", "')}". ` +
        `Supported: ${[...ALLOWED_OPTION_KEYS].join(', ')}.`,
    );
  }

  const { isolation, signal, timeout, idempotent, reuse, ambient } = options;

  if (isolation !== undefined && !ISOLATION_LEVELS.includes(isolation)) {
    throw new Error(
      `runInTransaction(): invalid isolation level "${String(isolation)}". ` +
        `Supported: ${ISOLATION_LEVELS.join(', ')}.`,
    );
  }

  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error('runInTransaction(): "signal" must be an AbortSignal.');
  }

  if (timeout !== undefined) {
    if (
      typeof timeout !== 'number' ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    ) {
      throw new Error(
        'runInTransaction(): "timeout" must be a positive number of milliseconds.',
      );
    }
  }

  for (const [name, value] of [
    ['idempotent', idempotent],
    ['reuse', reuse],
    ['ambient', ambient],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`runInTransaction(): "${name}" must be a boolean.`);
    }
  }

  if (
    options.retry !== undefined &&
    typeof options.retry !== 'boolean' &&
    (typeof options.retry !== 'object' || options.retry === null)
  ) {
    throw new Error(
      'runInTransaction(): "retry" must be a boolean or a retry policy object.',
    );
  }

  if (reuse && (isolation || signal || timeout !== undefined || idempotent)) {
    throw new Error(
      'runInTransaction(): "reuse: true" joins the already-active transaction — ' +
        'isolation/signal/timeout/idempotent cannot be changed mid-flight. ' +
        'Pass them only to the outermost call.',
    );
  }

  // Политика не имеет смысла при reuse: повторами управляет внешний вызов.
  if (reuse && options.retry !== undefined) {
    throw new Error(
      'runInTransaction(): "retry" cannot be combined with "reuse: true" — ' +
        'the outermost call owns transaction retries.',
    );
  }
}

/**
 * Менеджер транзакций (#98).
 *
 * Семантика повтора по умолчанию — как в @ydbjs/query: при `idempotent:
 * true` SDK может ПОВТОРНО выполнить весь колбэк при retryable-ошибках
 * (смерть сессии, сетевые сбои). Это значит, что побочные эффекты колбэка
 * и все lifecycle hooks сущностей могут выполниться больше одного раза —
 * колбэк должен быть идемпотентным или устойчивым к повтору.
 *
 * Приоритет слоёв повтора (#27, детерминированный):
 * - опция `retry` не задана — повторами тела владеет ТОЛЬКО SDK (как в #98);
 * - опция `retry` задана (`true` или объект политики) — владение переходит
 *   к политике ORM: ровно одна попытка тела на попытку политики (внутренний
 *   цикл SDK гасится), максимум исполнений колбэка = maxAttempts, между
 *   попытками bounded backoff + jitter, повторяются только статусы
 *   ABORTED/UNAVAILABLE/OVERLOADED. Требование идемпотентности колбэка —
 *   то же, что у idempotent-транзакций #98.
 * Смешивания слоёв нет: попытки не перемножаются ни в одной из конфигураций.
 */
export class YdbTransactionManager {
  /**
   * @param db executor БД.
   * @param settings настройки транзакций конфигурации-владельца (#199);
   *   если не заданы, используются процессно-глобальные настройки
   *   (configureTransactionContext) — прежнее поведение.
   */
  constructor(
    private readonly db: YdbExecutor,
    private readonly settings?: YdbTransactionsSettings,
  ) {}

  /**
   * Выполняет fn внутри транзакции YDB.
   *
   * Вложенные вызовы по умолчанию запрещены: если runInTransaction()
   * вызывается, пока активна другая транзакция того же executor'а БД,
   * бросается ошибка — молча открыть независимую транзакцию на другой
   * сессии нельзя. Чтобы присоединиться к активной транзакции (коммитом и
   * откатом управляет внешний вызов), передайте `{ reuse: true }`.
   * Вложенность на ДРУГОМ executor'е БД не считается ошибкой: это независимые
   * базы/сессии.
   *
   * @param fn колбэк, получающий executor транзакции и сигнал отмены текущей
   *   попытки. При idempotent-retry вызывается повторно — см. выше.
   * @param options см. RunInTransactionOptions. Семантика отмены:
   *   `signal` — глобальный (отменяет все попытки), `timeout` — на каждую
   *   попытку (retry получает свежее окно; полный дедлайн —
   *   `signal: AbortSignal.timeout(ms)`).
   */
  async runInTransaction<T>(
    fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
    options?: RunInTransactionOptions,
  ): Promise<T> {
    validateRunInTransactionOptions(options);

    // Детекция вложенности работает всегда (ambient включён или нет).
    const active = getActiveTransaction();
    // Сравниваем по transactionId, а не по ссылке на executor (#207).
    // active.db === this.db проверяет, что это тот же executor БД.
    if (active && active.db === this.db) {
      if (options?.reuse) {
        // Переиспользуем активную транзакцию: коммит/откат остаются у
        // внешнего вызова, новая БД-транзакция не открывается. Если на
        // внутреннем вызове явно задан ambient: true, создаём вложенный
        // ALS-контекст с ТЕМИ ЖЕ trx/db/signal, но ambient-флагом вызова:
        // иначе per-call ambient: true игнорировался бы, когда внешняя
        // транзакция открыта с ambient: false.
        if (options.ambient === true) {
          return runWithTransactionContext(
            {
              transactionId: active.transactionId,
              trx: active.trx,
              db: this.db,
              signal: active.signal,
              ambient: true,
            },
            () => fn(active.trx, active.signal),
          );
        }
        return fn(active.trx, active.signal);
      }
      throw new Error(
        'Nested runInTransaction() detected: a transaction is already active in ' +
          'this async context. Opening an independent transaction on another session ' +
          'is not allowed. Pass { reuse: true } to join the active transaction.',
      );
    }

    // Ambient auto-join для операций БЕЗ явного { trx }: opt-in per-call,
    // настройки конфигурации-владельца (#199), либо глобальные настройки
    // процесса (configureTransactionContext) — в порядке приоритета.
    const settings = resolveTransactionSettings(
      this.settings
        ? {
            ambient: this.settings.ambient ?? false,
            warnOutsideTransaction:
              this.settings.warnOutsideTransaction ?? false,
          }
        : undefined,
    );
    const ambient = options?.ambient ?? settings.ambient;

    // Семантика таймаута (#98): timeout действует НА КАЖДУЮ попытку.
    // При idempotent-retry SDK выполняет колбэк повторно с новой сессией —
    // каждая попытка получает СВЕЖЕЕ окно таймаута, а не истёкший дедлайн
    // первой попытки. Пользовательский signal при этом ГЛОБАЛЬНЫЙ: он
    // передаётся в SDK как есть и отменяет операцию целиком (все попытки).
    // Полный общий дедлайн задаётся явно: signal: AbortSignal.timeout(ms).

    const trxOptions = {
      isolation: options?.isolation,
      idempotent: options?.idempotent,
      // Только пользовательский сигнал: таймаут не должен попадать сюда,
      // иначе он стал бы общим дедлайном для всех попыток.
      signal: options?.signal,
    };

    /** Сигнал конкретной попытки: сигнал SDK + свежий AbortSignal.timeout. */
    const composeAttemptSignal = (sdkSignal?: AbortSignal) => {
      if (options?.timeout === undefined) return sdkSignal;
      const signals = [sdkSignal, AbortSignal.timeout(options.timeout)].filter(
        (s): s is AbortSignal => s instanceof AbortSignal,
      );
      return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    };

    /**
     * Тело execute(): создаёт контекст попытки и вызывает колбэк.
     * Используется и легаси-путём, и под политикой (#27).
     */
    const runAttemptBody = (
      trx: YdbExecutor,
      sdkSignal: AbortSignal | undefined,
    ) => {
      const attemptSignal = composeAttemptSignal(sdkSignal);
      // Генерируем уникальный ID для этой транзакции и сохраняем на executor'е.
      const transactionId = generateTransactionId();
      // Защита для моков и нестандартных executor'ов: trx может быть
      // функцией (jest mock), объектом или примитивом.
      if (trx && (typeof trx === 'object' || typeof trx === 'function')) {
        (trx as unknown as Record<typeof TRANSACTION_ID_KEY, symbol>)[
          TRANSACTION_ID_KEY
        ] = transactionId;
      }
      return runWithTransactionContext(
        { transactionId, trx, db: this.db, signal: attemptSignal, ambient },
        () => fn(trx, attemptSignal),
      );
    };

    // Retry-политика (#27): без неё — прежнее поведение (#98), тело ретраит
    // только SDK по своим правилам. С ней — владение повторами переходит к
    // ORM: на одну попытку политики приходится ровно одна попытка тела
    // (внутренний цикл SDK гасится маркером SdkRetrySupersededError — для
    // его предиката это заведомо неповторяемая ошибка), поэтому попытки не
    // перемножаются, а максимум исполнений колбэка равен maxAttempts.
    const policy = resolveYdbRetryPolicy(options?.retry);
    if (!policy) {
      return this.db
        .transaction(trxOptions)
        .execute((trx, sdkSignal) => runAttemptBody(trx, sdkSignal));
    }

    return runWithRetry(() => {
      let sdkAttempt = 0;
      let lastFailure: unknown;

      return this.db
        .transaction(trxOptions)
        .execute(async (trx, sdkSignal) => {
          sdkAttempt += 1;
          if (sdkAttempt > 1) {
            throw new SdkRetrySupersededError(lastFailure);
          }
          try {
            return await runAttemptBody(trx, sdkSignal);
          } catch (error) {
            lastFailure = error;
            throw error;
          }
        })
        .catch((error: unknown) => {
          throw unwrapTransactionError(error);
        });
    }, policy);
  }
}
