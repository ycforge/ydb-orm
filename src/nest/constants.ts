import { YdbTransactionManager } from '../transaction/transaction.manager.js';

export const YDB_DRIVER = Symbol('YDB_DRIVER');
export const YDB_QUERY = Symbol('YDB_QUERY');
export const YDB_OPTIONS = Symbol('YDB_OPTIONS');
export const YDB_CREDENTIALS_PROVIDER = Symbol('YDB_CREDENTIALS_PROVIDER');
export const YDB_ENCRYPTION_PROVIDER = Symbol('YDB_ENCRYPTION_PROVIDER');
export const YDB_BLIND_INDEX_PROVIDER = Symbol('YDB_BLIND_INDEX_PROVIDER');
export const YDB_VALIDATION_PROVIDER = Symbol('YDB_VALIDATION_PROVIDER');
export const YDB_SCHEMA_SYNC = Symbol('YDB_SCHEMA_SYNC');
/** Скоуп сущностей конкретного экземпляра ядра (#142): значение уникально
 * для каждого вызова YdbCoreModule.forRootAsync(), поэтому провайдеры
 * forFeature привязывают сущности к СВОЕМУ приложению независимо от
 * порядка резолва провайдеров. */
export const YDB_CORE_SCOPE = Symbol('YDB_CORE_SCOPE');
/** Скоуп ORM-конфигурации (#199): владение сущностями и per-scope настройки
 * транзакций. Значение уникально для каждого вызова forRootAsync. */
export const YDB_ORM_SCOPE = Symbol('YDB_ORM_SCOPE');
/** Имя конфигурации (#199): useValue-строка в провайдерах ядра — заодно
 * делает module token динамического модуля уникальным для каждого имени
 * (иначе NestJS дедуплицирует два forRootAsync одного класса). */
export const YDB_CONNECTION_NAME = Symbol('YDB_CONNECTION_NAME');
/**
 * Внутренний lifecycle-провайдер YdbCoreModule (schema sync на bootstrap,
 * закрытие драйвера и снятие с учёта при shutdown). Наружу не экспортируется.
 */
export const YDB_CORE_LIFECYCLE = Symbol('YDB_CORE_LIFECYCLE');

/** Имя конфигурации по умолчанию (#199). */
export const DEFAULT_CONNECTION_NAME = 'default';

/**
 * DI-токен конкретной конфигурации (#199). Для конфигурации по умолчанию
 * возвращается исходный символ (обратная совместимость одиночной
 * конфигурации); именованные конфигурации получают собственные токены,
 * поэтому несколько YdbCoreModule с разными именами не конфликтуют в DI.
 * Токены мемоизированы: повторный вызов с теми же base+name возвращает
 * ТОТ ЖЕ символ (Symbol(description) не равен другому такому же символу).
 */
const scopedTokens = new Map<string, symbol>();

export function getScopedToken(base: symbol, name: string): symbol {
  if (name === DEFAULT_CONNECTION_NAME) return base;
  const key = `${base.description ?? 'YDB'}#${name}`;
  let token = scopedTokens.get(key);
  if (!token) {
    token = Symbol(key);
    scopedTokens.set(key, token);
  }
  return token;
}

/** Токен YdbTransactionManager конкретной конфигурации (#199): для
 * дефолтной — исторический класс-токен, для именованных — свой символ. */
export function getTransactionManagerToken(
  name: string,
): symbol | typeof YdbTransactionManager {
  if (name === DEFAULT_CONNECTION_NAME) return YdbTransactionManager;
  return getScopedToken(YDB_TRANSACTION_MANAGER_BASE, name);
}

const YDB_TRANSACTION_MANAGER_BASE = Symbol('YDB_TRANSACTION_MANAGER');
