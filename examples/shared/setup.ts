/**
 * Общая обвязка запуска примера: создание driver/executor, привязка сущностей
 * и (по умолчанию) создание схемы БД (schema sync) — как `synchronize` в
 * TypeORM. Для продакт-кода вместо sync используйте миграции (пример 09).
 */
import type { Driver } from '@ydbjs/core';
import {
  createDriver,
  createExecutor,
  configureEntities,
  YdbSchemaSyncer,
  YdbEncryptionProvider,
  YdbBlindIndexProvider,
} from '../../src/index.js';
import { buildYdbOptions } from './options.js';
import { createEncryptionProvider } from './providers/aes-gcm-encryption.provider.js';

export interface SetupOptions {
  /** Создать недостающие таблицы/колонки при старте (по умолчанию true). */
  sync?: boolean;
  /**
   * Поднять провайдеры шифрования из env-ключей
   * (YDB_ORM_ENC_KEY / YDB_ORM_BI_KEY) — см. shared/providers.
   */
  encryption?: boolean;
  encryptionProvider?: YdbEncryptionProvider;
  blindIndexProvider?: YdbBlindIndexProvider;
}

export interface YdbSetup {
  driver: Driver;
  executor: ReturnType<typeof createExecutor>;
}

/** Подключение к YDB + configureEntities + (опционально) schema sync. */
export async function connectToYdb(
  entities: (new (...args: any[]) => any)[],
  options: SetupOptions = {},
): Promise<YdbSetup> {
  const dbOptions = buildYdbOptions();
  const driver = await createDriver(dbOptions);
  try {
    const executor = createExecutor(driver, dbOptions);
    const providers = options.encryption
      ? createEncryptionProvider()
      : undefined;

    configureEntities(entities, {
      executor,
      encryptionProvider: options.encryptionProvider ?? providers,
      blindIndexProvider: options.blindIndexProvider ?? providers,
    });

    // В DEV-режиме создаём недостающие таблицы и колонки автоматически.
    if (options.sync !== false) {
      const syncer = new YdbSchemaSyncer(driver, executor);
      await syncer.sync(entities);
    }

    return { driver, executor };
  } catch (error) {
    driver.close();
    throw error;
  }
}
