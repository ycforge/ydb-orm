import { AsyncLocalStorage } from 'node:async_hooks';
import type { YdbExecutor } from '../core/interfaces.js';
import type { YdbTransactionsSettings } from '../core/interfaces.js';

/**
 * Активная транзакция в цепочке async-вызовов (#98).
 *
 * Хранится в AsyncLocalStorage и используется для двух независимых задач:
 * 1. Детекция вложенных runInTransaction() — работает ВСЕГДА, независимо от
 *    настроек (иначе вложенный вызов молча открыл бы отдельную транзакцию
 *    на другой сессии).
 * 2. Ambient auto-join: если включён (глобально через настройки модуля или
 *    локально через опцию `ambient` вызова), операции репозиториев без
 *    явного { trx } выполняются в активной транзакции.
 */
export interface ActiveTransactionContext {
  /** Executor транзакции — передаётся в операции вместо executor'а сущности. */
  trx: YdbExecutor;
  /** Executor БД, открывший транзакцию: детекция вложенности по ссылке. */
  db: YdbExecutor;
  /** Сигнал отмены конкретной попытки транзакции (при retry — новый). */
  signal?: AbortSignal;
  /** Включён ли ambient auto-join для этого контекста. */
  ambient: boolean;
}

const storage = new AsyncLocalStorage<ActiveTransactionContext>();

/** Настройки транзакций процесса (заполняются из YdbModuleOptions). */
let settings: Required<YdbTransactionsSettings> = {
  ambient: false,
  warnOutsideTransaction: false,
};

/**
 * Конфигурирует транзакционное поведение процесса (#98).
 * Вызывается YdbOrmModule при инициализации; доступен и standalone-пользователям.
 * Настройки глобальные для процесса — как реестр сущностей.
 */
export function configureTransactionContext(
  options?: YdbTransactionsSettings,
): void {
  settings = {
    ambient: options?.ambient ?? false,
    warnOutsideTransaction: options?.warnOutsideTransaction ?? false,
  };
}

/** Текущие настройки (для тестов и менеджера транзакций). */
export function getTransactionContextSettings(): Required<YdbTransactionsSettings> {
  return { ...settings };
}

/**
 * Эффективные настройки транзакций для одной операции (#199):
 * настройки конфигурации-владельца сущности, если заданы, иначе
 * процессно-глобальные (прежнее поведение одиночной конфигурации).
 */
export function resolveTransactionSettings(
  scopeSettings?: Required<YdbTransactionsSettings>,
): Required<YdbTransactionsSettings> {
  return scopeSettings ?? settings;
}

/** Активная транзакция в текущей async-цепочке, если есть. */
export function getActiveTransaction(): ActiveTransactionContext | undefined {
  return storage.getStore();
}

/** Выполняет fn с заданным контекстом активной транзакции. */
export function runWithTransactionContext<T>(
  context: ActiveTransactionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(context, fn);
}

/**
 * Резолвит executor для одной операции репозитория (#98).
 *
 * - Явный trx всегда побеждает, НО при активном ambient-контексте другой
 *   транзакции это почти наверняка ошибка — смешивать активную ambient-
 *   транзакцию с посторонней нельзя, кидаем понятную ошибку.
 * - Без явного trx при включённом ambient auto-join возвращаем активную
 *   транзакцию.
 * - Иначе — обычный executor сущности; если настроен
 *   warnOutsideTransaction и транзакции нет вовсе — предупреждение.
 *
 * Ошибки не глотаются и не заменяются фолбэками.
 */
export function resolveOperationExecutor(
  explicitTrx: YdbExecutor | undefined,
  fallback: YdbExecutor | undefined,
  entityName: string,
  scopeSettings?: Required<YdbTransactionsSettings>,
): YdbExecutor | undefined {
  const active = storage.getStore();
  const effectiveSettings = resolveTransactionSettings(scopeSettings);

  if (explicitTrx) {
    if (active?.ambient && active.trx !== explicitTrx) {
      throw new Error(
        `Transaction mixing detected in ${entityName}: an explicit { trx } was passed, ` +
          'but a different transaction is active in the current async context. ' +
          'Either drop the explicit { trx } to join the ambient transaction, or run this ' +
          'operation outside of it.',
      );
    }
    return explicitTrx;
  }

  if (active?.ambient) {
    return active.trx;
  }

  // Нет executor'а — вызывающий код сам бросит понятную ошибку «executor
  // not set», предупреждение тут не нужно.
  if (!fallback) {
    return fallback;
  }

  if (effectiveSettings.warnOutsideTransaction && !active) {
    console.warn(
      `[ydb-orm] ${entityName}: query executed outside any transaction ` +
        '(warnOutsideTransaction is enabled).',
    );
  }

  return fallback;
}
