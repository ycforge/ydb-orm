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

/**
 * Fail-fast validation of module options: without an endpoint the driver
 * would fail later with a confusing error deep inside the SDK.
 */
export function validateYdbModuleOptions(
  opts: YdbModuleOptions,
  injected?: CredentialsProvider,
): void {
  if (!opts || typeof opts.endpoint !== 'string' || !opts.endpoint.trim()) {
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
      ? createYdbCredentialsProvider(opts.auth, YDB_AUTH_USAGE, {
          endpoint: opts.endpoint,
          // grpc:// — local insecure endpoint; grpcs:// — TLS (default).
          secure: !opts.endpoint.startsWith('grpc://'),
        })
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
  validateYdbModuleOptions(opts, credentialsProvider);
  // The provider is resolved by the single priority rule (#96) and is passed
  // AFTER spreading driverOptions: driverOptions.credentialsProvider cannot
  // silently overwrite the already-resolved provider.
  const resolvedProvider = resolveCredentialsProvider(
    opts,
    credentialsProvider,
  );
  const { credentialsProvider: _driverOptionsProvider, ...restDriverOptions } =
    opts.driverOptions ?? {};
  const driver = new Driver(opts.endpoint, {
    ...restDriverOptions,
    credentialsProvider: resolvedProvider,
  });
  await driver.ready();
  return driver;
}

/** Creates an executor (query client) over the driver. */
export function createExecutor(
  driver: Driver,
  opts: YdbModuleOptions,
): YdbExecutor {
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
  const adapted = ((strings: TemplateStringsArray, ...args: any[]) =>
    client(strings, ...args)) as unknown as YdbExecutor;

  (adapted as any).transaction = (
    options?: YdbTransactionOptions,
  ): YdbTransactionHandle => ({
    execute: async <T>(
      fn: (trx: YdbExecutor, signal?: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const { isolation, signal, idempotent } = options ?? {};
      return client.transaction({ isolation, idempotent, signal }, (tx, sgn) =>
        fn(tx as unknown as YdbExecutor, sgn),
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
