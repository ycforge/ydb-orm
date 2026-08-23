import { Injectable, Inject } from '@nestjs/common';
import { YDB_QUERY } from '../core/constants.js';
import type {
  YdbExecutor,
  YdbIsolationLevel,
  YdbTransactionOptions,
} from '../core/interfaces.js';
import {
  getActiveTransaction,
  getTransactionContextSettings,
  runWithTransactionContext,
} from './transaction-context.js';

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
 */
export interface RunInTransactionOptions extends YdbTransactionOptions {
  reuse?: boolean;
  ambient?: boolean;
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
]);

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

  if (reuse && (isolation || signal || timeout !== undefined || idempotent)) {
    throw new Error(
      'runInTransaction(): "reuse: true" joins the already-active transaction — ' +
        'isolation/signal/timeout/idempotent cannot be changed mid-flight. ' +
        'Pass them only to the outermost call.',
    );
  }
}

/**
 * Менеджер транзакций (#98).
 *
 * Семантика повтора (retry) — как в @ydbjs/query: при `idempotent: true`
 * SDK может ПОВТОРНО выполнить весь колбэк при retryable-ошибках (смерть
 * сессии, сетевые сбои). Это значит, что побочные эффекты колбэка и все
 * lifecycle hooks сущностей могут выполниться больше одного раза — колбэк
 * должен быть идемпотентным или устойчивым к повтору.
 *
 * Собственного ORM-ретрая поверх SDK нет (#27): повторами тела транзакции
 * управляет только SDK. Для составных операций ВНЕ транзакции используйте
 * явную политику runWithRetry() (core/retry) — вложение её сюда перемножило
 * бы попытки.
 */
@Injectable()
export class YdbTransactionManager {
  constructor(@Inject(YDB_QUERY) private readonly db: YdbExecutor) {}

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
    // либо глобально через настройки модуля (YdbModuleOptions.transactions).
    const settings = getTransactionContextSettings();
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

    // Контекст активной транзакции создаётся на каждый вызов execute():
    // при idempotent-retry SDK вызывает execute-колбэк заново с новой
    // сессией/транзакцией — контекст каждой попытки свой.
    return this.db.transaction(trxOptions).execute((trx, sdkSignal) => {
      // Сигнал конкретной попытки: сигнал от SDK (уже включает глобальный
      // пользовательский signal) + свежий AbortSignal.timeout этой попытки.
      let attemptSignal = sdkSignal;
      if (options?.timeout !== undefined) {
        const signals = [
          sdkSignal,
          AbortSignal.timeout(options.timeout),
        ].filter((s): s is AbortSignal => s instanceof AbortSignal);
        attemptSignal =
          signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      }

      return runWithTransactionContext(
        { trx, db: this.db, signal: attemptSignal, ambient },
        () => fn(trx, attemptSignal),
      );
    });
  }
}
