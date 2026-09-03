/**
 * Read-only access to the migration bookkeeping table (#152).
 *
 * The readiness check (migration:check/status/show) must not modify the DB,
 * so the YdbMigrationRunner.status path (ensureMigrationsTable ->
 * CREATE TABLE IF NOT EXISTS + possible ALTER for legacy tables) is off
 * limits. Instead:
 *  1. the existence of `ydb_migrations` is determined via metadata —
 *     DescribeTable through the Table service (`YdbSchemaSyncer.describeTable`,
 *     #91: null only when the table is truly absent; any other error
 *     propagates, nothing is swallowed);
 *  2. records are read via a bare SELECT of only the columns that actually
 *     exist: legacy tables (created before #101) may lack `hash`/`state` —
 *     instead of ALTER, their absence is merely accounted for on read;
 *  3. no DDL or writes happen here at all.
 */
import type { Driver } from '@ydbjs/core';
import { quoteIdentifier } from '../core/sql-utils.js';
import type { YdbExecutor } from '../core/interfaces.js';
import {
  YdbSchemaSyncer,
  type YdbTableDescription,
} from '../schema/schema-sync.js';
import {
  MIGRATIONS_TABLE,
  appliedRecordFromRow,
  type AppliedMigration,
} from './migration-runner.js';

/** Snapshot of the migration bookkeeping table without any schema change. */
export interface MigrationBookkeepingSnapshot {
  /** The bookkeeping table exists. */
  exists: boolean;
  /**
   * Legacy format (pre-#101): the `hash`/`state` columns are absent —
   * matching is by name and every record is implied applied.
   */
  legacy: boolean;
  /** Bookkeeping records in application order. */
  records: AppliedMigration[];
}

/** Snapshot-read dependencies: driver (metadata) + executor (SELECT). */
export interface MigrationBookkeepingDeps {
  driver: Driver;
  executor: YdbExecutor;
}

/**
 * Reads the state of the bookkeeping table WITHOUT creating or modifying
 * anything. A missing table is a normal result ({ exists: false }), not an
 * error: a fresh database has not been initialized with migrations yet.
 */
export async function readBookkeepingSnapshot(
  deps: MigrationBookkeepingDeps,
  options?: {
    /** Test seam (defaults to DescribeTable via YdbSchemaSyncer). */
    describeTable?: (tableName: string) => Promise<YdbTableDescription | null>;
  },
): Promise<MigrationBookkeepingSnapshot> {
  const describeTable =
    options?.describeTable ??
    ((tableName: string) =>
      new YdbSchemaSyncer(deps.driver, deps.executor).describeTable(tableName));

  const description = await describeTable(MIGRATIONS_TABLE);
  if (!description) {
    return { exists: false, legacy: false, records: [] };
  }

  const legacy =
    !description.columns.has('hash') || !description.columns.has('state');
  const columns = legacy
    ? '`id`, `timestamp`, `name`'
    : '`id`, `timestamp`, `name`, `hash`, `state`';

  const sets = (await deps.executor([
    `SELECT ${columns} FROM ${quoteIdentifier(MIGRATIONS_TABLE)}`,
  ] as unknown as TemplateStringsArray)) as Record<string, any>[][];

  return {
    exists: true,
    legacy,
    records: (sets[0] ?? [])
      .map(appliedRecordFromRow)
      .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
  };
}
