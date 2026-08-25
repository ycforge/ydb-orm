import { YdbExecutor } from './interfaces.js';

export interface QueryOptions {
  /** Транзакция / executor */
  trx?: YdbExecutor;
  /** AbortSignal для отмены */
  signal?: AbortSignal;
  /** Таймаут в миллисекундах */
  timeout?: number;
  /**
   * Пометка идемпотентности запроса (#27). Пробрасывается в SDK как
   * `.idempotent(true)` и разрешает retry-политике ORM повторять запрос
   * при транзитных ошибках (ABORTED/UNAVAILABLE/OVERLOADED).
   *
   * БЕЗ пометки запрос выполняется РОВНО ОДИН раз даже при включённой
   * политике (`YdbModuleOptions.retry`): повтор незнакомого записывающего
   * запроса после двусмысленного сбоя транспорта может продублировать
   * побочные эффекты. Помечайте только операции, устойчивые к повтору
   * (идемпотентные SELECT, INSERT по фиксированному PK и т.п.).
   */
  idempotent?: boolean;
  /** Максимум строк в SELECT (по умолчанию 100) */
  limit?: number;
  /** Смещение для SELECT */
  offset?: number;
  /** Конкретные колонки для SELECT (вместо SELECT *) */
  select?: string[];
}
