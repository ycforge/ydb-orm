import { bindTopicTransaction } from '../topic/transaction-binding.js';
import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { CredentialsProvider } from '@ydbjs/auth';
import { createYdbCredentialsProvider } from '@ycforge/auth/ydb';
import { YDB_AUTH_USAGE } from '@ycforge/auth';
import {
  YdbExecutor,
  YdbModuleOptions,
  YdbTransactionHandle,
  YdbTransactionOptions,
} from './interfaces.js';
import { ConsoleQueryLogger, wrapExecutorWithLogging } from './query-logger.js';
import { withRetryPolicy } from './retry-executor.js';
import { resolveYdbRetryPolicy } from './retry.js';

/**
 * Endpoint normalization (#244): surrounding whitespace is stripped in one
 * place so the AuthManager adapter and the driver derive the transport from
 * the same value. The driver treats the endpoint as a URL and also accepts
 * surrounding whitespace — without normalization `secure` could diverge from
 * the actual transport mode.
 */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim();
}

/**
 * Fail-fast validation of module options: without an endpoint the driver
 * would fail later with a confusing error deep inside the SDK. Returns the
 * endpoint normalized for reuse by the driver and the credentials adapter.
 */
export function validateYdbModuleOptions(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): string {
  if (
    !opts ||
    typeof opts.endpoint !== 'string' ||
    !normalizeEndpoint(opts.endpoint)
  ) {
    throw new Error(
      'YDB module options: "endpoint" is required ' +
        '(e.g. "grpcs://ydb.serverless.yandexcloud.net:2135"). ' +
        'Return it from useFactory/useClass in YdbCoreModule.forRootAsync().',
    );
  }
  assertNoCredentialsProviderConflict(opts);
  assertAuthPresent(opts, injected);
  assertAadFormat(opts);
  assertAadReadFallback(opts);
  // Executor-affecting options are validated here, up front (#232): an invalid
  // retry policy must fail BEFORE the connection-name claim and the driver are
  // allocated, otherwise the failure would surface later from createExecutor()
  // and leak both resources.
  validatePoolOptions(opts.poolOptions);
  resolveYdbRetryPolicy(opts.retry);
  return normalizeEndpoint(opts.endpoint);
}

/** Reject ignored/invalid pool options before allocating the driver. */
export function validatePoolOptions(
  options: YdbModuleOptions['poolOptions'],
): void {
  if (options === undefined) return;
  if (!options || typeof options !== 'object')
    throw new Error('poolOptions must be an object.');
  const allowed = new Set(['minSize', 'maxSize', 'waitQueueFactor']);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key))
      throw new Error(
        `Unsupported poolOptions.${key}. Use the options supported by @ydbjs/query.`,
      );
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < (key === 'minSize' ? 0 : 1))
    ) {
      throw new Error(
        `Invalid poolOptions.${key}: expected a ${key === 'minSize' ? 'non-negative' : 'positive'} integer.`,
      );
    }
  }
  if ((options.minSize ?? 0) > (options.maxSize ?? 50))
    throw new Error('poolOptions.minSize must not exceed maxSize.');
}

/**
 * Adapter options for the AuthManager path (#244): the endpoint is normalized
 * first so `secure` is derived from the same value the driver uses.
 */
function authAdapterOptions(endpoint: string): {
  endpoint: string;
  secure: boolean;
} {
  const normalized = normalizeEndpoint(endpoint);
  return {
    endpoint: normalized,
    // grpc:// — local insecure endpoint; grpcs:// — TLS (default).
    secure: !normalized.startsWith('grpc://'),
  };
}

/** Endpoints that already produced an insecure-transport warning. */
const warnedInsecureEndpoints = new Set<string>();

/**
 * Warns once per endpoint when plaintext gRPC is used. `grpc://` sends
 * credentials and data without TLS, which is acceptable for local development
 * but dangerous in production.
 */
function warnInsecureEndpoint(opts: YdbModuleOptions, endpoint: string): void {
  if (
    !endpoint.startsWith('grpc://') ||
    warnedInsecureEndpoints.has(endpoint)
  ) {
    return;
  }
  warnedInsecureEndpoints.add(endpoint);
  const message =
    `[ydb-orm] Endpoint "${endpoint}" uses grpc:// (insecure transport, ` +
    'no TLS). Use grpcs:// outside local development.';
  const logger =
    typeof opts.logQueries === 'object' && opts.logQueries !== null
      ? opts.logQueries
      : undefined;
  if (logger?.warn) {
    logger.warn(message);
  } else {
    console.warn(message);
  }
}

/**
 * Validation of the automatic AAD format detection option (#165): either
 * unset (the safe transitional mode is enabled) or a strict boolean.
 */
function assertAadReadFallback(opts: YdbModuleOptions): void {
  const fallback = opts.aadReadFallback;
  if (fallback !== undefined && typeof fallback !== 'boolean') {
    throw new Error(
      `YDB module options: "aadReadFallback" must be a boolean (got "${String(fallback)}").`,
    );
  }
}

/**
 * Validation of the Security AAD format (#165): only 'legacy' and 'v2'
 * (default) are allowed. An unknown value is a configuration error, not a
 * silent fallback to the default.
 */
function assertAadFormat(opts: YdbModuleOptions): void {
  const format = opts.aadFormat;
  if (format !== undefined && format !== 'legacy' && format !== 'v2') {
    throw new Error(
      `YDB module options: "aadFormat" must be "legacy" or "v2" (got "${String(format)}").`,
    );
  }
}

function assertAuthPresent(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): void {
  if (
    opts.auth === undefined &&
    opts.credentialsProvider === undefined &&
    opts.driverOptions?.credentialsProvider === undefined &&
    injected === undefined
  ) {
    throw new Error(
      'YDB auth is required: pass "auth" (AuthManager) or a CredentialsProvider.',
    );
  }
}

/**
 * CredentialsProvider source conflict (#96): if the low-level
 * driverOptions.credentialsProvider is set together with a top-level source
 * (an explicit credentialsProvider or auth/AuthManager), the priority is not
 * chosen silently — it is a configuration error.
 */
function assertNoCredentialsProviderConflict(opts: YdbModuleOptions): void {
  const lowLevel = opts.driverOptions?.credentialsProvider !== undefined;
  if (!lowLevel) return;
  const names: string[] = [];
  if (opts.credentialsProvider !== undefined)
    names.push('"credentialsProvider"');
  if (opts.auth !== undefined) names.push('"auth"');
  if (names.length > 0) {
    names.push('"driverOptions.credentialsProvider"');
    throw new Error(
      `Conflicting YDB credentials configuration: ${names.join(' and ')} ` +
        'are set. Keep only one source: either pass the provider via the ' +
        'top-level "credentialsProvider"/"auth" option or remove it from ' +
        '"driverOptions".',
    );
  }
}

/**
 * Resolves the final CredentialsProvider by the deterministic priority (#96):
 *
 *   1. opts.credentialsProvider — explicit provider from the module options;
 *   2. opts.auth — AuthManager from @ycforge/auth (the adapter
 *      createYdbCredentialsProvider from '@ycforge/auth/ydb');
 *   3. injected — a provider arriving from DI (YDB_CREDENTIALS_PROVIDER) or
 *      passed as an argument to createDriver();
 *   4. opts.driverOptions.credentialsProvider — the low-level driver option.
 *
 * The combination (1)/(2) + (4) is forbidden — a configuration error, not a
 * silent choice. Used by the NestJS module, createDriver() and the CLI.
 */
export function resolveCredentialsProvider(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): CredentialsProvider {
  assertNoCredentialsProviderConflict(opts);
  const provider =
    opts.credentialsProvider ??
    (opts.auth !== undefined
      ? createYdbCredentialsProvider(
          opts.auth,
          YDB_AUTH_USAGE,
          authAdapterOptions(opts.endpoint),
        )
      : undefined) ??
    injected ??
    opts.driverOptions?.credentialsProvider;

  if (provider === undefined) {
    throw new Error(
      'YDB auth is required: pass "auth" (AuthManager) or a CredentialsProvider.',
    );
  }

  return provider;
}

/** Creates a connected Driver from the module options. */
export async function createDriver(
  opts: YdbModuleOptions,
  credentialsProvider?: CredentialsProvider,
): Promise<Driver> {
  const endpoint = validateYdbModuleOptions(opts, credentialsProvider);
  warnInsecureEndpoint(opts, endpoint);
  // The provider is resolved by the single priority rule (#96) and is passed
  // AFTER spreading driverOptions: driverOptions.credentialsProvider cannot
  // silently overwrite the already-resolved provider.
  const resolvedProvider = resolveCredentialsProvider(
    opts,
    credentialsProvider,
  );
  const { credentialsProvider: _driverOptionsProvider, ...restDriverOptions } =
    opts.driverOptions ?? {};
  const driver = new Driver(endpoint, {
    ...restDriverOptions,
    credentialsProvider: resolvedProvider,
  });
  try {
    await driver.ready();
  } catch (error) {
    // The Driver constructor starts discovery and allocates a connection pool;
    // a failed ready() would otherwise leak both resources and poison
    // subsequent bootstrap attempts in the same process (#232).
    try {
      const closing = driver.close() as unknown;
      if (closing instanceof Promise) await closing;
    } catch {
      // Preserve the original connection error.
    }
    throw error;
  }
  return driver;
}

/** Creates an executor (query client) over the driver. */
export function createExecutor(
  driver: Driver,
  opts: YdbModuleOptions,
): YdbExecutor {
  validatePoolOptions(opts.poolOptions);
  const client = query(driver, {
    poolOptions: opts.poolOptions
      ? Object.fromEntries(
          Object.entries(opts.poolOptions).filter(([, v]) => v !== undefined),
        )
      : undefined,
  });

  // Adapts the @ydbjs/query client to the YdbExecutor interface (#98):
  // client.transaction(options, fn) is a function returning a promise, while
  // the ORM interface expects transaction(options?) => { execute(fn) }.
  // Previously the adaptation existed only in wrapExecutorWithLogging, which
  // made runInTransaction crash on the "live" SDK. Options (isolation/signal/
  // idempotent) pass through to the SDK as is; timeout is implemented by the
  // transaction manager per attempt (a fresh AbortSignal.timeout for each
  // attempt) and never reaches the SDK.
  const adapted = ((strings: TemplateStringsArray, ...args: unknown[]) =>
    client(strings, ...args)) as unknown as YdbExecutor;

  (adapted as any).transaction = (
    options?: YdbTransactionOptions,
  ): YdbTransactionHandle => ({
    execute: async <T>(
      fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const { isolation, signal, idempotent } = options ?? {};
      return client.transaction(
        { isolation, idempotent, signal },
        (tx, sgn) => {
          const transactionExecutor = ((
            strings: TemplateStringsArray,
            ...args: unknown[]
          ) => tx(strings, ...args)) as unknown as YdbExecutor;
          bindTopicTransaction(transactionExecutor, tx, driver, isolation, sgn);
          return fn(transactionExecutor, sgn);
        },
      );
    },
  });

  let executor = adapted;

  // Retry policy (#27): optional, disabled by default (only the SDK retries).
  // The wrapper is placed UNDER logging so each policy attempt is logged
  // separately.
  if (opts.retry !== undefined && opts.retry !== false) {
    executor = withRetryPolicy(executor, opts.retry);
  }

  if (opts.logQueries) {
    const logger =
      typeof opts.logQueries === 'object' && opts.logQueries !== null
        ? opts.logQueries
        : new ConsoleQueryLogger();
    executor = wrapExecutorWithLogging(executor, logger, {
      values: opts.logParamValues,
    });
  }

  return executor;
}
