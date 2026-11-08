import type { YdbModuleOptions } from './interfaces.js';

/** Conservative starting point; callers must tune limits to concurrency and RU budget. */
export function serverlessYdbOptions(
  options: YdbModuleOptions,
): YdbModuleOptions {
  return {
    ...options,
    sync: options.sync ?? false,
    poolOptions: {
      minSize: 0,
      maxSize: 4,
      waitQueueFactor: 2,
      ...options.poolOptions,
    },
    driverOptions: {
      'ydb.sdk.ready_timeout_ms': 10_000,
      'ydb.sdk.discovery_timeout_ms': 5_000,
      ...options.driverOptions,
    },
  };
}
