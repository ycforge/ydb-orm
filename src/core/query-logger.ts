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

/** Плейсхолдер вместо значения секретного/PII параметра в логах. */
const REDACTED = '<redacted>';

/**
 * Токены, по которым имя параметра признаётся чувствительным (секреты/PII).
 * Матчинг по токенам имени (password, token, secret, email, authorization и
 * т.п.) — короткие значения не должны попадать в лог открыто только потому,
 * что не длиннее MAX_PARAM_LENGTH.
 */
const SENSITIVE_TOKENS = new Set([
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'token',
  'tokens',
  'secret',
  'secrets',
  'authorization',
  'credential',
  'credentials',
  'apikey',
  'accesskey',
  'secretkey',
  'privatekey',
  'clientsecret',
  'email',
  'emails',
  'phone',
  'phone_number',
  'telephone',
  'mobile',
  'cellphone',
  'ssn',
  'passport',
  'cvv',
  'cvc',
  'card',
  'cardnumber',
  'pin',
  'first_name',
  'last_name',
  'full_name',
  'username',
  'login',
  'cookie',
  'session',
  'bearer',
]);

/**
 * Чувствителен ли параметр по имени.
 *
 * Кроме явных токенов секретов/PII маскируются synthetic-колонки blind index
 * (`{field}_bi`): их хеш детерминирован по plaintext, и по логам можно
 * коррелировать значения/подбирать их частотным анализом.
 */
function isSensitiveParam(name: string): boolean {
  const lower = name.toLowerCase();
  // {field}_bi — корневой параметр, {field}_bi_N — нумерованный
  // (non-root WHERE, см. buildFieldCondition в entity-persistence).
  if (/[-_]bi(_\d+)?$/.test(lower)) return true;
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  return tokens.some((t) => SENSITIVE_TOKENS.has(t));
}

/**
 * Маскирование скалярного значения: ciphertext/бинарные данные — только длиной,
 * чувствительные параметры — целиком, длинные строки обрезаются.
 */
function maskScalarValue(name: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    // Бинарные/зашифрованные данные никогда не логируем дословно.
    return `<bytes:${value.length}>`;
  }
  if (isSensitiveParam(name)) return REDACTED;
  if (typeof value === 'string' && value.length > MAX_PARAM_LENGTH) {
    return value.slice(0, MAX_PARAM_LENGTH) + '...';
  }
  return value;
}

/** Маскирование значения параметра по имени параметра. */
function maskValue(name: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (
    typeof value === 'object' &&
    'type' in (value as any) &&
    'value' in (value as any)
  ) {
    // YDB typed value { type: ..., value: ... }
    const inner = (value as any).value;
    if (inner === null || inner === undefined) return inner;
    return maskScalarValue(name, inner);
  }
  return maskScalarValue(name, value);
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
        maskedParams[name] = maskValue(name, value);
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
    options?: Parameters<YdbExecutor['transaction']>[0],
  ) => {
    // Опции транзакции (#98) пробрасываются как есть — логируется только
    // executor, семантика исполнения не меняется.
    const tx = executor.transaction(options);
    return {
      execute: (
        fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<unknown>,
      ) =>
        tx.execute((trx: YdbExecutor, signal?: AbortSignal) => {
          // Транзакционный executor оборачивается тем же логгером: каждый
          // запрос внутри runInTransaction (и вложенных транзакций) логируется
          // с той же семантикой, что и обычные запросы.
          return fn(wrapExecutorWithLogging(trx, logger), signal);
        }),
    };
  };

  return wrapped as YdbExecutor;
}
