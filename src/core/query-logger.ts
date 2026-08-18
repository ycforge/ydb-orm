import { YdbExecutor } from './interfaces.js';

/**
 * Информация о запросе для логирования.
 */
export interface QueryLogEntry {
  /** SQL-запрос (шаблонная строка). */
  sql: string;
  /** Имена параметров (без значений). */
  paramNames: string[];
  /** Замаскированные значения параметров (секреты скрыты). */
  maskedParams: Record<string, unknown>;
  /** Длительность выполнения в миллисекундах. */
  durationMs: number;
  /** Ошибка (если запрос упал). */
  error?: Error;
}

/**
 * Интерфейс логгера запросов.
 * Пользователь может передать свой логгер (e.g. pino, winston, OpenTelemetry span).
 */
export interface QueryLogger {
  log(entry: QueryLogEntry): void;
}

/** Максимальная длина замаскированного значения параметра. */
const MAX_PARAM_LENGTH = 64;

/** Маскирование значения параметра: секреты скрыты, длинные строки обрезаны. */
function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (
    typeof value === 'object' &&
    'type' in (value as any) &&
    'value' in (value as any)
  ) {
    // YDB typed value { type: ..., value: ... }
    const inner = (value as any).value;
    if (inner === null || inner === undefined) return inner;
    if (typeof inner === 'string') {
      return inner.length > MAX_PARAM_LENGTH
        ? inner.slice(0, MAX_PARAM_LENGTH) + '...'
        : inner;
    }
    if (inner instanceof Uint8Array) {
      return `<bytes:${inner.length}>`;
    }
    return inner;
  }
  if (value instanceof Uint8Array) {
    return `<bytes:${value.length}>`;
  }
  if (typeof value === 'string') {
    return value.length > MAX_PARAM_LENGTH
      ? value.slice(0, MAX_PARAM_LENGTH) + '...'
      : value;
  }
  return value;
}

/**
 * Консольный логгер запросов по умолчанию.
 * Формат: [YDB] QUERY <durationMs>ms — sql с параметрами
 */
export class ConsoleQueryLogger implements QueryLogger {
  log(entry: QueryLogEntry): void {
    const params = Object.entries(entry.maskedParams)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');

    const base = `[YDB] QUERY ${entry.durationMs}ms`;
    const sql =
      entry.sql.length > 200 ? entry.sql.slice(0, 200) + '...' : entry.sql;

    if (entry.error) {
      console.error(
        `${base} ERROR: ${entry.error.message}\n  SQL: ${sql}\n  Params: ${params}`,
      );
    } else {
      console.log(`${base}\n  SQL: ${sql}\n  Params: ${params}`);
    }
  }
}

/**
 * Оборачивает executor логированием: замеряет длительность,
 * маскирует параметры, логирует SQL + ошибки.
 */
export function wrapExecutorWithLogging(
  executor: YdbExecutor,
  logger: QueryLogger,
): YdbExecutor {
  const wrapped: any = (strings: TemplateStringsArray) => {
    const sql = strings[0];
    const startTime = performance.now();
    const paramNames: string[] = [];
    const maskedParams: Record<string, unknown> = {};

    const query = executor(strings);
    const originalParameter = query.parameter.bind(query);

    const proxied: any = {
      parameter(name: string, value: unknown) {
        paramNames.push(name);
        maskedParams[name] = maskValue(value);
        return originalParameter(name, value);
      },
      timeout(ms: number) {
        query.timeout(ms);
        return proxied;
      },
      signal(signal: AbortSignal) {
        query.signal(signal);
        return proxied;
      },
      cancel() {
        query.cancel();
        return proxied;
      },
      then(onFulfilled: any, onRejected: any) {
        const promise = query.then(
          (result: any) => {
            const durationMs = Math.round(performance.now() - startTime);
            logger.log({ sql, paramNames, maskedParams, durationMs });
            return result;
          },
          (error: any) => {
            const durationMs = Math.round(performance.now() - startTime);
            logger.log({
              sql,
              paramNames,
              maskedParams,
              durationMs,
              error: error instanceof Error ? error : new Error(String(error)),
            });
            throw error;
          },
        );
        return promise.then(onFulfilled, onRejected);
      },
    };
    return proxied;
  };

  wrapped.transaction = executor.transaction.bind(executor);

  return wrapped as YdbExecutor;
}
