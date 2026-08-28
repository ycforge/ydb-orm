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

/**
 * Опции обёртки логирования (#168): управление раскрытием raw-значений
 * параметров. По умолчанию значения не логируются вовсе.
 */
export interface YdbLoggingOptions {
  values?: YdbLogParamValues;
}

/** Максимальная длина raw-значения параметра в логах (opt-in раскрытие). */
const MAX_PARAM_LENGTH = 64;

/**
 * Разрешение на раскрытие raw-значений параметров в логах (#168).
 *
 * По умолчанию (undefined/false) логгер выводит для каждого параметра только
 * безопасную метаинформацию — тип и длину (`<string:8>`), никогда не раскрывая
 * сами значения (байты и blind index маскируются всегда). Историческая
 * денylist-маскировка по токенам имени непокрыто утекала чувствительные
 * значения с произвольными именами (`salary`, `medical_record` и т.п.).
 *
 * Раскрытие raw-значений — явный opt-in приложения:
 * - `true` — раскрывать все значения (заведомо unsafe-логгер);
 * - `string[]` — раскрывать только перечисленные имена параметров;
 * - `RegExp` — раскрывать по маске имени параметра;
 * - `(name: string) => boolean` — произвольный предикат приложения.
 */
export type YdbLogParamValues =
  boolean | string[] | RegExp | ((name: string) => boolean);

/** Допущенное приложением имя — выбор источника raw-значений (#168). */
function allowRawValue(
  values: YdbLogParamValues | undefined,
  name: string,
): boolean {
  if (values === undefined || values === false) return false;
  if (values === true) return true;
  if (typeof values === 'function') return values(name);
  if (Array.isArray(values)) return values.includes(name);
  values.lastIndex = 0;
  return values.test(name);
}

/**
 * Безопасная метаинформация о значении параметра (#168): raw не логируется,
 * только тип и длина. Строки/числа/JSON/булевы не раскрываются, чтобы по
 * журналам нельзя было восстановить sensitive-значения с именами, которых
 * нет ни в каком денylist'е.
 */
function safeMetaValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return `<bytes:${value.length}>`;
  switch (typeof value) {
    case 'string':
      return `<string:${value.length}>`;
    case 'number':
      return '<number>';
    case 'bigint':
      return '<bigint>';
    case 'boolean':
      return '<boolean>';
    case 'object': {
      if (value === null) return null;
      if (value instanceof Date) return '<date>';
      return `<json:${JSON.stringify(value).length}>`;
    }
    default:
      return `<${typeof value}>`;
  }
}

/**
 * Маскирование скалярного значения. Байты никогда не раскрываются (только
 * длина). Raw-значение допустимо только для имён из явного allowlist'а
 * приложения (#168); длинные строки в таком случае обрезаются.
 */
function maskScalarValue(
  name: string,
  value: unknown,
  allowRaw: boolean,
): unknown {
  if (value instanceof Uint8Array) {
    return `<bytes:${value.length}>`;
  }
  if (allowRaw) {
    if (typeof value === 'string' && value.length > MAX_PARAM_LENGTH) {
      return value.slice(0, MAX_PARAM_LENGTH) + '...';
    }
    return value;
  }
  return safeMetaValue(value);
}

/** Маскирование значения параметра по имени параметра. */
function maskValue(
  name: string,
  value: unknown,
  values?: YdbLogParamValues,
): unknown {
  if (value === null || value === undefined) return value;
  if (
    typeof value === 'object' &&
    'type' in (value as any) &&
    'value' in (value as any)
  ) {
    // YDB typed value { type: ..., value: ... }
    const inner = (value as any).value;
    if (inner === null || inner === undefined) return inner;
    return maskScalarValue(name, inner, allowRawValue(values, name));
  }
  return maskScalarValue(name, value, allowRawValue(values, name));
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
 *
 * @param options Настройки раскрытия raw-значений параметров (#168):
 *   по умолчанию в лог попадают только имена и метаинформация (тип+длина).
 */
export function wrapExecutorWithLogging(
  executor: YdbExecutor,
  logger: QueryLogger,
  options?: YdbLoggingOptions,
): YdbExecutor {
  const values = options?.values;
  const wrapped: any = (strings: TemplateStringsArray, ...args: any[]) => {
    const sql = strings[0];
    const startTime = performance.now();
    const paramNames: string[] = [];
    const maskedParams: Record<string, unknown> = {};

    const query = executor(strings, ...args);
    const originalParameter = query.parameter.bind(query);

    const proxied: any = {
      parameter(name: string, value: unknown) {
        paramNames.push(name);
        maskedParams[name] = maskValue(name, value, values);
        originalParameter(name, value);
        // Возвращаем прокси, иначе цепочка parameter().parameter() сбегает
        // из прокси и последующие вызовы теряют логирование
        return proxied;
      },
      timeout(ms: number) {
        query.timeout(ms);
        return proxied;
      },
      signal(signal: AbortSignal) {
        query.signal(signal);
        return proxied;
      },
      // Без проброса idempotent() пометка #27 молча терялась бы на этом
      // прокси (executeQuery вызывает query.idempotent?.(true)), и запрос
      // выпадал бы из retry-политики при включённом logQueries.
      idempotent(flag?: boolean) {
        query.idempotent?.(flag);
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

  wrapped.transaction = (
    txOptions?: Parameters<YdbExecutor['transaction']>[0],
  ) => {
    // Опции транзакции (#98) пробрасываются как есть — логируется только
    // executor, семантика исполнения не меняется.
    const tx = executor.transaction(txOptions);
    return {
      execute: (
        fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<unknown>,
      ) =>
        tx.execute((trx: YdbExecutor, signal?: AbortSignal) => {
          // Транзакционный executor оборачивается тем же логгером: каждый
          // запрос внутри runInTransaction (и вложенных транзакций) логируется
          // с той же семантикой, что и обычные запросы.
          return fn(wrapExecutorWithLogging(trx, logger, options), signal);
        }),
    };
  };

  return wrapped as YdbExecutor;
}
