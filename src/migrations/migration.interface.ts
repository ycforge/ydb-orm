import { YdbExecutor } from '../core/interfaces.js';

/**
 * Миграция БД (аналог MigrationInterface в TypeORM).
 * Имя миграции — из имени файла: `<timestamp>-<Name>` (например,
 * `1755000000000-CreateUsers`). Порядок выполнения — по имени файла.
 */
export interface YdbMigration {
  /** Имя миграции. Если не задано, runner возьмёт имя файла. */
  name?: string;

  /**
   * Стабильный идентификатор содержимого (#101). Заполняется загрузчиком
   * (SHA-256 содержимого файла), поэтому переименование файла не приводит
   * к повторному применению миграции.
   */
  hash?: string;

  /** Применить миграцию. */
  up(executor: YdbExecutor): Promise<void>;

  /** Откатить миграцию. */
  down(executor: YdbExecutor): Promise<void>;
}

/** Класс миграции (то, что экспортируется из файла миграции). */
export type YdbMigrationClass = new () => YdbMigration;

/**
 * Выполняет произвольный YQL (DDL/DML) через executor.
 * Вспомогательная функция для миграций.
 */
export async function executeSql(
  executor: YdbExecutor,
  sql: string,
): Promise<unknown> {
  return executor([sql] as unknown as TemplateStringsArray);
}
