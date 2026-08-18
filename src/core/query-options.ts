import { YdbExecutor } from './interfaces.js';

export interface QueryOptions {
  /** Транзакция / executor */
  trx?: YdbExecutor;
  /** AbortSignal для отмены */
  signal?: AbortSignal;
  /** Таймаут в миллисекундах */
  timeout?: number;
  /** Максимум строк в SELECT (по умолчанию 100) */
  limit?: number;
  /** Смещение для SELECT */
  offset?: number;
  /** Конкретные колонки для SELECT (вместо SELECT *) */
  select?: string[];
}
