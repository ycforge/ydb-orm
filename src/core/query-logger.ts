import { YdbExecutor } from './interfaces.js';

/**
 * Информация о запросе для логирования.
 */
export interface QueryLogEntry {
  /** SQL-запрос (шаблонная строка). */
  sql: string;
  /** Имена параметров (без значений). */
  paramNames: string[];
  /** Замаскированные значения параметров: raw скрыт, только тип+класс размера. */
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
 * безопасную метаинформацию — тип и укрупнённый класс размера
 * (`<string:1-31>`, `<json:512-2047>`), никогда не раскрывая сами значения;
 * бинарные данные (в т.ч. ciphertext колонок) маскируются всегда. Точная
 * длина не раскрывается: exact-length канал позволил бы различать значения
 * по размеру (fingerprinting). Историческая денylist-маскировка по токенам
 * имени непокрыто утекала чувствительные значения с произвольными именами
 * (`salary`, `medical_record` и т.п.), поэтому убрана (#168).
 *
 * Раскрытие raw-значений — явный opt-in приложения:
 * - `true` — раскрывать все значения (кроме бинарных; заведомо unsafe-логгер);
 * - `string[]` — раскрывать только перечисленные имена параметров;
 * - `RegExp` — раскрывать по маске имени параметра;
 * - `(name: string) => boolean` — произвольный предикат приложения.
 *
 * Blind-index хеши (`{field}_bi`) — обычные строковые параметры: по умолчанию
 * маскируются, при явном opt-in раскрываются приложением осознанно (единский
 * hard-boundary — бинарные значения).
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
 * только тип и укрупнённый класс размера. Точная длина значения НЕ
 * раскрывается — точные `<string:N>`/`<json:N>` позволяли бы различать
 * low-cardinality значения по длине (fingerprinting). Классы размера оставляют
 * диагностическую ценность («пустой?», «массивный BLOB?») без однозначного
 * канала различения значений.
 */
function safeMetaValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `<bytes:${lengthBucket(value.length)}>`;
  }
  switch (typeof value) {
    case 'string':
      return `<string:${lengthBucket(value.length)}>`;
    case 'number':
      return '<number>';
    case 'bigint':
      return '<bigint>';
    case 'boolean':
      return '<boolean>';
    case 'object': {
      if (value === null) return null;
      if (value instanceof Date) return '<date>';
      let len: number;
      try {
        len = JSON.stringify(value).length;
      } catch {
        // Циклическая/несериализуемая структура: маскируем без размера,
        // логирование не должно падать и ронять запрос (см. #190).
        return '<json>';
      }
      return `<json:${lengthBucket(len)}>`;
    }
    default:
      return `<${typeof value}>`;
  }
}

/**
 * Укрупнённый класс длины для метаинформации (#190): точная длина не
 * раскрывается, чтобы по журналам нельзя было различать значения.
 */
function lengthBucket(length: number): string {
  const buckets = [
    { max: 0, label: '0' },
    { max: 31, label: '1-31' },
    { max: 127, label: '32-127' },
    { max: 511, label: '128-511' },
    { max: 2047, label: '512-2047' },
    { max: Infinity, label: '2048+' },
  ] as const;
  return buckets.find((b) => length <= b.max)!.label;
}

/**
 * Маскирование скалярного значения. Байты никогда не раскрываются (только
 * класс размера). Raw-значение допустимо только для имён из явного allowlist'а
 * приложения (#168); длинные строки в таком случае обрезаются.
 */
function maskScalarValue(
  name: string,
  value: unknown,
  allowRaw: boolean,
): unknown {
  if (value instanceof Uint8Array) {
    // Жёсткая граница: бинарные данные никогда не раскрываются, только
    // класс размера (точная длина скрыта, #190).
    return `<bytes:${lengthBucket(value.length)}>`;
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

/** Сериализация значения параметра для консольного вывода (#190). */
function formatParamValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // Циклическая структура (raw opt-in раскрытие): плейсхолдер вместо
      // падения логгера.
    }
    return '<circular>';
  }
  const json = JSON.stringify(value);
  return json === undefined ? '<unserializable>' : json;
}

/**
 * Консольный логгер запросов по умолчанию.
 * Формат: [YDB] QUERY <durationMs>ms — sql с параметрами
 */
export class ConsoleQueryLogger implements QueryLogger {
  log(entry: QueryLogEntry): void {
    const params = Object.entries(entry.maskedParams)
      .map(([k, v]) => `${k}=${formatParamValue(v)}`)
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
 *   по умолчанию в лог попадают только имена и метаинформация (тип + класс
 *   размера, без точной длины).
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
