import { YdbExecutor } from './interfaces.js';
import {
  ensureExecutorIdentity,
  inheritExecutorIdentity,
} from '../transaction/transaction-context.js';

/**
 * Query information for logging.
 */
export interface QueryLogEntry {
  /** SQL query (template string). */
  sql: string;
  /** Parameter names (without values). */
  paramNames: string[];
  /** Masked parameter values: raw is hidden, only type + size class. */
  maskedParams: Record<string, unknown>;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Error (if the query failed). */
  error?: Error;
}

/**
 * Query logger interface.
 * The user may supply their own logger (e.g. pino, winston, OpenTelemetry span).
 *
 * `warn` — optional hook for ORM warnings (#206): routed through the logger
 * configured via `logQueries`, e.g. the `warnOutsideTransaction` warning. The
 * method is optional for backward compatibility — a logger without `warn`
 * simply does not receive warnings.
 */
export interface QueryLogger {
  log(entry: QueryLogEntry): void;
  warn?(message: string): void;
}

/**
 * Logging wrapper options (#168): control disclosure of raw parameter values.
 * By default values are not logged at all.
 */
export interface YdbLoggingOptions {
  /** Raw-value disclosure policy for parameter names. */
  values?: YdbLogParamValues;
}

/** Maximum length of a raw parameter value in logs (opt-in disclosure). */
const MAX_PARAM_LENGTH = 64;

/**
 * Raw parameter value disclosure permission for logs (#168).
 *
 * By default (undefined/false) the logger prints for each parameter only safe
 * metadata — the type and a coarse size class (`<string:1-31>`,
 * `<json:512-2047>`), never the values themselves; binary data (including
 * column ciphertext) is always masked. Exact length is not disclosed: an
 * exact-length channel would let values be distinguished by size
 * (fingerprinting). The historical denylist masking by name tokens leaked
 * sensitive values with arbitrary names (`salary`, `medical_record`, etc.),
 * so it was removed (#168).
 *
 * Raw value disclosure is an explicit application opt-in:
 * - `true` — disclose all values (except binary; a knowingly unsafe logger);
 * - `string[]` — disclose only the listed parameter names;
 * - `RegExp` — disclose by parameter-name pattern;
 * - `(name: string) => boolean` — arbitrary application predicate.
 *
 * Blind-index hashes (`{field}_bi`) are ordinary string parameters: masked by
 * default, and on explicit opt-in disclosed by the application deliberately
 * (the only hard boundary is binary values).
 */
export type YdbLogParamValues =
  boolean | string[] | RegExp | ((name: string) => boolean);

/** An application-approved name — the raw-value source selector (#168). */
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
 * Safe metadata about a parameter value (#168): the raw value is not logged,
 * only the type and a coarse size class. The exact value length is NOT
 * disclosed — exact `<string:N>`/`<json:N>` would allow distinguishing
 * low-cardinality values by length (fingerprinting). Size classes retain
 * diagnostic value ("empty?", "huge BLOB?") without an unambiguous channel to
 * distinguish values.
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
        // Cyclic/non-serializable structure: mask without size;
        // logging must not crash and take the query down (see #190).
        return '<json>';
      }
      return `<json:${lengthBucket(len)}>`;
    }
    default:
      return `<${typeof value}>`;
  }
}

/**
 * Coarse length class for metadata (#190): the exact length is not disclosed
 * so values cannot be distinguished from logs.
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
 * Masking of a scalar value. Bytes are never disclosed (only the size class).
 * Raw values are allowed only for names in the application's explicit
 * allowlist (#168); long strings are then truncated.
 */
function maskScalarValue(
  name: string,
  value: unknown,
  allowRaw: boolean,
): unknown {
  if (value instanceof Uint8Array) {
    // Hard boundary: binary data is never disclosed, only the size class
    // (exact length is hidden, #190).
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

/** Masks a parameter value by parameter name. */
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

/** Serializes a parameter value for console output (#190). */
function formatParamValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (value !== null && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // Cyclic structure (raw opt-in disclosure): a placeholder instead of
      // crashing the logger.
    }
    return '<circular>';
  }
  const json = JSON.stringify(value);
  return json === undefined ? '<unserializable>' : json;
}

/**
 * Default console query logger.
 * Format: [YDB] QUERY <durationMs>ms — sql with parameters
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

  /**
   * ORM warning (#206): printed as is (the text carries its own `[ydb-orm]`
   * prefix), so the warning content is not distorted.
   */
  warn(message: string): void {
    console.warn(message);
  }
}

/**
 * Private per-executor logger registry (#206), modeled after the identity
 * approach of #217: the "executor → logger" link is module-local metadata and
 * must not live in a mutable property a consumer could overwrite. The WeakMap
 * prevents external code (including a wrapper holder) from swapping the
 * configuration logger and does not break frozen/sealed executors.
 */
const executorLoggers = new WeakMap<YdbExecutor, QueryLogger>();

/** Returns the logger bound to an executor in wrapExecutorWithLogging. */
export function getExecutorLogger(
  executor: YdbExecutor | undefined,
): QueryLogger | undefined {
  if (!executor) {
    return undefined;
  }
  return executorLoggers.get(executor);
}

/**
 * Resolves the logger for entity operations (#206): the logger bound to the
 * configuration executor, or a shared console fallback if logging is not
 * configured. The fallback is the standalone `ConsoleQueryLogger`, so the
 * behavior without a custom logger is preserved (warnings go to the console),
 * and a separate configuration cannot pick up a foreign custom logger.
 */
const fallbackQueryLogger = new ConsoleQueryLogger();

export function resolveExecutorLogger(
  executor: YdbExecutor | undefined,
): QueryLogger {
  return getExecutorLogger(executor) ?? fallbackQueryLogger;
}

/**
 * Wraps an executor with logging: measures duration, masks parameters, logs
 * SQL and errors.
 *
 * @param options Raw parameter value disclosure settings (#168):
 *   by default only names and metadata (type + size class, without exact
 *   length) go into the log.
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
        // Return the proxy, otherwise a parameter().parameter() chain escapes
        // the proxy and subsequent calls lose logging
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
      // Without forwarding idempotent(), the #27 marker would be silently lost
      // on this proxy (executeQuery calls query.idempotent?.(true)), and the
      // query would drop out of the retry policy while logQueries is enabled.
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
    // Transaction options (#98) pass through as is — only the executor is
    // logged, execution semantics are unchanged.
    const tx = executor.transaction(txOptions);
    return {
      execute: (
        fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<unknown>,
      ) =>
        tx.execute((trx: YdbExecutor, signal?: AbortSignal) => {
          // The transactional executor is wrapped with the same logger: every
          // query inside runInTransaction (and nested transactions) is logged
          // with the same semantics as ordinary queries.
          return fn(wrapExecutorWithLogging(trx, logger, options), signal);
        }),
    };
  };

  // Identity (#207): the wrapper and its source represent one logical
  // executor, so the wrapper inherits the source's identity token, and the
  // source gets its own token if needed. Different wrappers of one logical
  // executor share the token — nested-transaction detection compares DB
  // contexts BY VALUE, not by object reference.
  ensureExecutorIdentity(executor);
  inheritExecutorIdentity(executor, wrapped);

  // The logger travels with the executor (#206): entity operations can fetch
  // it via getExecutorLogger/resolveExecutorLogger, so warnings
  // (warnOutsideTransaction) reach THEIR configuration's logger, not a
  // foreign one or the console directly. Registration goes into the private
  // registry, not into a wrapper property — the logger cannot be overwritten
  // externally (see executorLoggers).
  executorLoggers.set(wrapped as YdbExecutor, logger);

  return wrapped as YdbExecutor;
}
