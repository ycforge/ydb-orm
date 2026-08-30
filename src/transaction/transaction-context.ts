import { AsyncLocalStorage } from 'node:async_hooks';
import type { YdbExecutor } from '../core/interfaces.js';
import type { YdbTransactionsSettings } from '../core/interfaces.js';

/** Параметры создания контекста активной транзакции (#208). */
export interface TransactionContextParams {
  transactionId: symbol;
  trx: YdbExecutor;
  db: YdbExecutor;
  signal?: AbortSignal;
  ambient: boolean;
}

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
 *
 * Идентичность транзакции определяется `transactionId`, а не ссылкой на
 * executor, так как разные обёртки могут представлять одну и ту же
 * логическую транзакцию (например, при оборачивании executor'а для логирования).
 *
 * Инварианты (#208) валидируются в единственной точке создания — конструкторе,
 * поэтому невалидный инстанс создать невозможно ни через фабрику
 * createTransactionContext(), ни напрямую через new. Приватное brand-поле
 * делает контекст непрозрачным для структурной типизации и защищает
 * runWithTransactionContext() от подделок через cast/instanceof.
 */
export class ActiveTransactionContext {
  /** Уникальный идентификатор транзакции (символ) — для сравнения по значению. */
  readonly transactionId: symbol;
  /** Executor транзакции — передаётся в операции вместо executor'а сущности. */
  readonly trx: YdbExecutor;
  /** Executor БД, открывший транзакцию: детекция вложенности по transactionId. */
  readonly db: YdbExecutor;
  /** Сигнал отмены конкретной попытки транзакции (при retry — новый). */
  readonly signal: AbortSignal | undefined;
  /** Включён ли ambient auto-join для этого контекста. */
  readonly ambient: boolean;
  /** Приватная brand-метка: есть только у инстансов, созданных через фабрику. */
  readonly #brand = Symbol('ActiveTransactionContext');

  constructor(params: TransactionContextParams) {
    validateTransactionContextParams(params);
    this.transactionId = params.transactionId;
    this.trx = params.trx;
    this.db = params.db;
    this.signal = params.signal;
    this.ambient = params.ambient;
  }

  /** Возвращает true только для настоящего фабричного инстанса. */
  static isContext(value: unknown): value is ActiveTransactionContext {
    return typeof value === 'object' && value !== null && #brand in value;
  }
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

/**
 * Выполняет fn с заданным контекстом активной транзакции.
 *
 * Публичная граница (#208): контекст обязан быть настоящим инстансом,
 * созданным через createTransactionContext() — приватный brand-проверкой
 * исключаются и обычные объекты, и подделки через cast/instanceof.
 */
export function runWithTransactionContext<T>(
  context: ActiveTransactionContext,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ActiveTransactionContext.isContext(context)) {
    throw new Error(
      'ActiveTransactionContext: invalid context. Create it via createTransactionContext().',
    );
  }
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
    if (
      active?.ambient &&
      active.transactionId !== getTransactionId(explicitTrx)
    ) {
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

/**
 * Приватный реестр identity (#217): executor -> символ.
 *
 * Источник правды для transaction/executor identity находится ЗДЕСЬ, а не в
 * мутируемом свойстве executor'а. Слабые ключи позволяют собирать объекты,
 * на которые больше нет ссылок (в т.ч. краткоживущие trx-executor'ы каждой
 * попытки), и НЕ требуют мутации объект executor'а вовсе — frozen/sealed
 * executor'ы работают без изменений. Потребители не имеют доступа к реестру,
 * поэтому не могут перезаписать чужой identity и соединить два независимых
 * контекста в один.
 */
const identityRegistry = new WeakMap<YdbExecutor, symbol>();

/**
 * Получает identity-токен из executor'а (#207/#217).
 * Возвращает символ из приватного реестра (для live-транзакции это её
 * transactionId, для логического DB-executor'а — стабильный идентификатор
 * этого executor'а), иначе сам executor для обратной совместимости
 * (сравнение по ссылке для executor'ов без identity).
 */
export function getTransactionId(trx: YdbExecutor): symbol | YdbExecutor {
  return identityRegistry.get(trx) ?? trx;
}

/**
 * Явно запоминает identity-токен для executor'а в приватном реестре (#217).
 * Используется, чтобы присвоить свежесозданному trx-executor'у данной попытки
 * её transactionId (см. runAttemptBody, entity-relations). Не мутирует объект.
 */
export function setExecutorIdentity(executor: YdbExecutor, id: symbol): void {
  identityRegistry.set(executor, id);
}

/**
 * Присваивает executor'у стабильный identity-токен, если его ещё нет (#207).
 * Используется для логических DB-executor'ов: разные обёртки одного и того же
 * логического executor'а разделяют этот токен, поэтому детекция вложенных
 * транзакций может сравнивать DB-контексты по значению, а не по ссылке на
 * объект. Токен хранится в приватном реестре и не мутирует executor.
 */
export function ensureExecutorIdentity(executor: YdbExecutor): symbol {
  const existing = identityRegistry.get(executor);
  if (existing) return existing;
  const id = Symbol('ydb.executor');
  identityRegistry.set(executor, id);
  return id;
}

/**
 * Наследует identity-токен с внутреннего executor'а на обёртку (#207):
 * wrapExecutorWithLogging()/withRetryPolicy() создают НОВЫЕ объекты, и чтобы
 * обёртки того же логического executor'а распознавались как один DB-контекст,
 * они копируют токен с исходного executor'а в приватный реестр обёртки.
 */
export function inheritExecutorIdentity(
  source: YdbExecutor,
  target: YdbExecutor,
): void {
  const id = identityRegistry.get(source);
  if (id !== undefined) {
    identityRegistry.set(target, id);
  }
}

/**
 * Единственная точка валидации инвариантов ActiveTransactionContext (#208):
 *
 * - transactionId должен быть символом
 * - trx должен быть валидным executor'ом (объект или функция)
 * - db должен быть валидным executor'ом (объект или функция)
 * - signal, если задан, должен быть AbortSignal
 * - ambient должен быть boolean
 *
 * @throws Error если любой инвариант нарушен
 */
function validateTransactionContextParams(
  params: TransactionContextParams,
): void {
  if (typeof params.transactionId !== 'symbol') {
    throw new Error(
      'ActiveTransactionContext: transactionId must be a symbol.',
    );
  }
  if (
    !params.trx ||
    (typeof params.trx !== 'object' && typeof params.trx !== 'function')
  ) {
    throw new Error(
      'ActiveTransactionContext: trx must be a valid executor (object or function).',
    );
  }
  if (
    !params.db ||
    (typeof params.db !== 'object' && typeof params.db !== 'function')
  ) {
    throw new Error(
      'ActiveTransactionContext: db must be a valid executor (object or function).',
    );
  }
  if (params.signal !== undefined && !(params.signal instanceof AbortSignal)) {
    throw new Error(
      'ActiveTransactionContext: signal must be an AbortSignal if provided.',
    );
  }
  if (typeof params.ambient !== 'boolean') {
    throw new Error('ActiveTransactionContext: ambient must be a boolean.');
  }
}

/**
 * Канонический способ получения ActiveTransactionContext: валидация инвариантов
 * (#208) происходит в конструкторе, brand-поле блокирует структурные подделки
 * (объектные литералы и касты в runWithTransactionContext отклоняются).
 */
export function createTransactionContext(
  params: TransactionContextParams,
): ActiveTransactionContext {
  return new ActiveTransactionContext(params);
}
