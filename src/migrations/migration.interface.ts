import { YdbExecutor } from '../core/interfaces.js';

/**
 * A database migration (analogous to TypeORM's MigrationInterface).
 * The migration name comes from the file name: `<timestamp>-<Name>` (e.g.,
 * `1755000000000-CreateUsers`). Migrations run in file-name order.
 */
export interface YdbMigration {
  /** Migration name. If not set, the runner falls back to the file name. */
  name?: string;

  /**
   * Stable content-based identity (#101). Populated by the loader as the
   * SHA-256 of the file content, so renaming the file does not re-apply
   * an applied migration.
   */
  hash?: string;

  /** Apply the migration. */
  up(executor: YdbExecutor): Promise<void>;

  /** Roll the migration back. */
  down(executor: YdbExecutor): Promise<void>;
}

/** A migration class (what a migration file exports). */
export type YdbMigrationClass = new () => YdbMigration;

/**
 * Runs arbitrary YQL (DDL/DML) through the executor.
 * Helper function for migrations.
 */
export async function executeSql(
  executor: YdbExecutor,
  sql: string,
): Promise<unknown> {
  return executor([sql] as unknown as TemplateStringsArray);
}
