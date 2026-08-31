import { createHash } from 'node:crypto';
import type { Driver } from '@ydbjs/core';
import { YdbExecutor } from '../core/interfaces.js';
import { mapToYdb } from '../core/mapper.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import {
  YdbSchemaSyncer,
  type YdbTableDescription,
} from '../schema/schema-sync.js';
import { YdbMigration, executeSql } from './migration.interface.js';

/** Bookkeeping table recording applied migrations. */
export const MIGRATIONS_TABLE = 'ydb_migrations';

/** State of a migration's bookkeeping record (#101). */
export type MigrationRecordState = 'applied' | 'started';

/** One bookkeeping record of an applied migration. */
export interface AppliedMigration {
  id: number;
  timestamp: number;
  name: string;
  /**
   * Stable content-based identity (SHA-256, #101).
   * Absent for old-format records (created before the `hash` column existed).
   */
  hash?: string;
  /**
   * `started` — the migration was begun but not finished: a marker of a
   * partially applied migration after a failure (DDL in YDB is
   * non-transactional). For old-format records `applied` is implied.
   */
  state: MigrationRecordState;
}

/** Status of one migration relative to the bookkeeping table. */
export interface YdbMigrationStatus {
  name: string;
  /**
   * True only for a "healthily applied" migration (#212): a bookkeeping
   * record exists, the state is not `started`, and the content is unchanged.
   * Migrations modified after being applied (`contentChanged`) and
   * interrupted (`interrupted`) ones are NOT counted as applied — the flag
   * carries the true reason so consumers that check only `applied` do not
   * mistake them for healthy ones.
   */
  applied: boolean;
  appliedAt?: Date;
  /** A record exists in the DB, but no matching migration was passed (file deleted). */
  orphan?: boolean;
  /** The migration was marked started (`state = 'started'`) but never finished. */
  interrupted?: boolean;
  /**
   * The file content changed after the migration was applied (#101): the
   * bookkeeping record was matched by name, but the hashes differ. For
   * readiness checks this is NOT a successfully applied migration
   * (applied=false) — an explicit reconcile is required (restore the
   * content or call removeMigrationRecord).
   */
  contentChanged?: boolean;
}

/** Returns the migration name, or a descriptive error if it has none. */
export function migrationName(migration: YdbMigration): string {
  if (!migration.name) {
    throw new Error(
      `Migration ${migration.constructor.name} has no name. ` +
        `Set the "name" property or load migrations via loadMigrationsFromDir().`,
    );
  }
  return migration.name;
}

/**
 * Stable migration identity (#101): the content hash, or the name if no
 * hash is set. Renaming a file does not change the identity, so an applied
 * migration is not re-run under a new name.
 */
export function migrationIdentity(migration: YdbMigration): string {
  return migration.hash ?? migrationName(migration);
}

/**
 * Deterministic bookkeeping row id derived from the migration identity (#101):
 * the first 13 hex characters of the SHA-256 (52 bits — within the
 * safe-integer range, so the value survives conversion to number).
 *
 * Two concurrent processes claiming the same migration compute the same id ->
 * PRIMARY KEY conflict on the INSERT claim. The race guard is thus enforced
 * atomically at the DB level rather than by an in-process lock.
 */
export function deriveMigrationRowId(identity: string): number {
  const hex = createHash('sha256').update(identity, 'utf8').digest('hex');
  return Number.parseInt(hex.slice(0, 13), 16);
}

/** Application order: by timestamp, then by id (ids are no longer chronological). */
function byChronology(a: AppliedMigration, b: AppliedMigration): number {
  return a.timestamp - b.timestamp || a.id - b.id;
}

function appliedFromRow(row: Record<string, any>): AppliedMigration {
  return {
    id: Number(row.id),
    timestamp: Number(row.timestamp),
    name: String(row.name),
    hash: row.hash == null ? undefined : String(row.hash),
    state: row.state === 'started' ? 'started' : 'applied',
  };
}

/**
 * Maps a bookkeeping table row into a record; exported for the read-only
 * snapshot (migration-bookkeeping.ts). Missing hash/state is the legacy
 * pre-#101 format: `applied` is implied and matching is by name.
 */
export const appliedRecordFromRow = appliedFromRow;

/**
 * Duplicates in the input array are an error (#101): previously the second
 * duplicate was silently skipped (or applied again).
 */
function assertNoDuplicates(migrations: YdbMigration[]): void {
  const byName = new Map<string, YdbMigration>();
  const byIdentity = new Map<string, YdbMigration>();
  for (const migration of migrations) {
    const name = migrationName(migration);
    if (byName.has(name)) {
      throw new Error(
        `Duplicate migration name in runner input: "${name}". ` +
          `Each migration must be passed exactly once.`,
      );
    }
    byName.set(name, migration);

    const identity = migrationIdentity(migration);
    const prev = byIdentity.get(identity);
    if (prev) {
      throw new Error(
        `Duplicate migration identity in runner input: ` +
          `"${migrationName(prev)}" and "${name}" have identical content (hash "${identity}").`,
      );
    }
    byIdentity.set(identity, migration);
  }
}

interface AppliedIndex {
  byHash: Map<string, AppliedMigration>;
  byName: Map<string, AppliedMigration[]>;
}

function buildAppliedIndex(applied: AppliedMigration[]): AppliedIndex {
  const byHash = new Map<string, AppliedMigration>();
  const byName = new Map<string, AppliedMigration[]>();
  for (const record of applied) {
    if (record.hash) byHash.set(record.hash, record);
    const bucket = byName.get(record.name) ?? [];
    bucket.push(record);
    byName.set(record.name, bucket);
  }
  return { byHash, byName };
}

type MatchResult =
  | { kind: 'matched'; record: AppliedMigration }
  | { kind: 'changed'; record: AppliedMigration }
  | { kind: 'pending' };

/**
 * Matches a migration against a bookkeeping record (#101):
 *  1. by the stable content hash — file renames are harmless;
 *  2. by name, when the record has no hash (legacy old-format records);
 *  3. names match but hashes differ -> content was modified after being
 *     applied — running such a migration is unsafe, an explicit reconcile
 *     is required.
 */
function matchAppliedRecord(
  index: AppliedIndex,
  migration: YdbMigration,
): MatchResult {
  if (migration.hash) {
    const byHash = index.byHash.get(migration.hash);
    if (byHash) return { kind: 'matched', record: byHash };
  }
  for (const record of index.byName.get(migrationName(migration)) ?? []) {
    if (!record.hash || !migration.hash) {
      return { kind: 'matched', record };
    }
    if (record.hash !== migration.hash) {
      return { kind: 'changed', record };
    }
    return { kind: 'matched', record };
  }
  return { kind: 'pending' };
}

/** Finds the migration class for a bookkeeping record (prefers an exact hash match). */
function findMigrationForRecord(
  migrations: YdbMigration[],
  record: AppliedMigration,
): YdbMigration | undefined {
  if (record.hash) {
    return migrations.find((m) => m.hash === record.hash);
  }
  // Legacy records without a hash are matched by name only.
  return migrations.find((m) => migrationName(m) === record.name);
}

/** Whether the record has a matching migration among the passed ones. */
function recordMatchesMigration(
  record: AppliedMigration,
  migrations: YdbMigration[],
): boolean {
  return migrations.some(
    (m) =>
      (record.hash != null && m.hash != null && record.hash === m.hash) ||
      record.name === migrationName(m),
  );
}

/**
 * Pure matching of "migration files <-> bookkeeping records" without touching
 * the DB: used both by YdbMigrationRunner.status (the serving path with
 * ensure) and by the read-only readiness check (#152, snapshot from
 * readBookkeepingSnapshot).
 */
export function computeMigrationStatuses(
  migrations: YdbMigration[],
  applied: AppliedMigration[],
): YdbMigrationStatus[] {
  assertNoDuplicates(migrations);
  const index = buildAppliedIndex(applied);

  const statuses: YdbMigrationStatus[] = migrations.map((migration) => {
    const name = migrationName(migration);
    const match = matchAppliedRecord(index, migration);
    if (match.kind === 'pending') {
      return { name, applied: false };
    }
    return {
      name,
      // `applied` — only healthily applied (#212): a modified-after-application
      // or interrupted migration is not considered applied.
      applied: match.kind === 'matched' && match.record.state !== 'started',
      appliedAt: new Date(match.record.timestamp),
      interrupted: match.record.state === 'started',
      // The name matches but the content hash differs (#101): the file was
      // modified after being applied. For the readiness check this is not a
      // successfully applied migration — the state is flagged explicitly.
      contentChanged: match.kind === 'changed' || undefined,
    };
  });

  // Orphan records (#101): applied, but the migration file no longer exists.
  // A clean orphan is informational (applied=true); an orphan in the
  // `started` state is interrupted, applied=false (#212).
  for (const record of applied) {
    if (recordMatchesMigration(record, migrations)) continue;
    statuses.push({
      name: record.name,
      applied: record.state !== 'started',
      appliedAt: new Date(record.timestamp),
      orphan: true,
      interrupted: record.state === 'started',
    });
  }

  return statuses;
}

const RECOVERY_HINT =
  `Do not re-run it blindly: finish or roll back the database changes manually, ` +
  `then resolve the bookkeeping row explicitly via ` +
  `markMigrationApplied(...) or removeMigrationRecord(...).`;

/**
 * Migration executor: maintains the `ydb_migrations` bookkeeping table,
 * applies new migrations in order, and reverts the latest one.
 *
 * DDL in YDB is non-transactional, so migrations run sequentially without a
 * wrapping transaction (#101):
 *  - a `state='started'` marker is written to the bookkeeping table before
 *    `up()`/`down()`;
 *  - a failure mid-migration leaves that marker — a subsequent `run()` will
 *    not blindly re-start the migration until the state is explicitly resolved
 *    via `markMigrationApplied()` / `removeMigrationRecord()`;
 *  - claiming an application is an INSERT with a deterministic id (derived
 *    from the content hash): concurrent processes collide on PRIMARY KEY,
 *    so double application is impossible.
 */
export class YdbMigrationRunner {
  /** Ensure cache: one round-trip per instance instead of per read (#101). */
  private ensurePromise?: Promise<void>;

  constructor(
    private readonly executor: YdbExecutor,
    /**
     * The driver is required for a guaranteed upgrade of the legacy
     * bookkeeping table (#176): DescribeTable through the Table service
     * distinguishes "column missing" from a transient error, which a
     * SELECT probe could not.
     */
    private readonly driver?: Driver,
    /**
     * Test seam over the DescribeTable path.
     * Returns null when the table does not exist (or the schema is unreadable).
     */
    private readonly describeTable?: (
      tableName: string,
    ) => Promise<YdbTableDescription | null>,
  ) {}

  /** Creates the migration bookkeeping table if it is missing (once per instance). */
  async ensureMigrationsTable(): Promise<void> {
    this.ensurePromise ??= this.doEnsureMigrationsTable().catch((error) => {
      this.ensurePromise = undefined;
      throw error;
    });
    return this.ensurePromise;
  }

  private async doEnsureMigrationsTable(): Promise<void> {
    await executeSql(
      this.executor,
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(MIGRATIONS_TABLE)} (` +
        '`id` Int64, `timestamp` Int64, `name` Utf8, `hash` Utf8, `state` Utf8, ' +
        'PRIMARY KEY (`id`)' +
        ')',
    );

    // Upgrade of an old-format table (created before #101): the `hash`/`state`
    // columns may be absent. Columns are added ONLY based on real DescribeTable
    // metadata (#176): a SELECT probe could not tell a missing column from a
    // transient/authorization error, and an unconditional ALTER pair could not
    // survive a partial upgrade (a failure between the ALTERs left the table so
    // that a re-run crashed on the duplicate column and never reached the
    // second one).
    let description: YdbTableDescription | null = null;
    if (this.driver || this.describeTable) {
      description = await this.describeMigrationsTable();
    }
    if (description) {
      const missing = (['hash', 'state'] as const).filter(
        (column) => !description.columns.has(column),
      );
      for (const column of missing) {
        await this.addColumnIfMissing(column);
      }
      return;
    }

    // Legacy path for runners created without a driver (programmatic use):
    // DescribeTable is unavailable, so a SELECT probe cannot tell a missing
    // column from a transient/authorization error. Running ALTER after an
    // arbitrary probe failure is unsafe (#186): without a reliably confirmed
    // absence of the column, the error is rethrown without any DDL.
    // The CLI and NestJS paths always pass a driver — there the upgrade runs
    // on real DescribeTable metadata.
    try {
      await executeSql(
        this.executor,
        `SELECT \`hash\`, \`state\` FROM ${quoteIdentifier(MIGRATIONS_TABLE)} LIMIT 1`,
      );
    } catch (error) {
      throw new Error(
        `Legacy bookkeeping upgrade of ${quoteIdentifier(MIGRATIONS_TABLE)} ` +
          `cannot run without a driver: SELECT probe failed ` +
          `(${(error as Error)?.message ?? error}), so the absence of the ` +
          `hash/state columns is not reliably confirmed. No ALTER was ` +
          `attempted. Rerun through a driver-backed runner (CLI or NestJS) ` +
          `which decides DDL from DescribeTable metadata.`,
        { cause: error },
      );
    }
  }

  /**
   * Adds a missing column with an idempotent outcome under a race (#186):
   * if the ALTER failed but the column actually exists already (added by a
   * concurrent process or a previous attempt), the result is read from the
   * real DescribeTable metadata rather than from the error text. Any other
   * error (missing privileges, transient) is rethrown unchanged — the table
   * stays in its original state and a re-run restores the upgrade.
   */
  private async addColumnIfMissing(column: string): Promise<void> {
    try {
      await executeSql(
        this.executor,
        `ALTER TABLE ${quoteIdentifier(MIGRATIONS_TABLE)} ` +
          `ADD COLUMN \`${column}\` Utf8`,
      );
    } catch (error) {
      const now = await this.describeMigrationsTable().catch(() => null);
      if (now && now.columns.has(column)) {
        return; // a concurrent process already brought the table to the target state
      }
      throw error;
    }
  }

  /**
   * Metadata of the bookkeeping table via the existing DescribeTable path.
   * DescribeTable errors (missing privileges, transient) propagate without
   * any ALTER — only a clearly missing column leads to ALTER (#176).
   */
  private async describeMigrationsTable(): Promise<YdbTableDescription | null> {
    if (this.describeTable) {
      return this.describeTable(MIGRATIONS_TABLE);
    }
    if (this.driver) {
      return new YdbSchemaSyncer(this.driver, this.executor).describeTable(
        MIGRATIONS_TABLE,
      );
    }
    return null;
  }

  /** Applied migrations in application order. */
  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.ensureMigrationsTable();
    const sets = (await this.executor([
      `SELECT \`id\`, \`timestamp\`, \`name\`, \`hash\`, \`state\` FROM ${quoteIdentifier(MIGRATIONS_TABLE)}`,
    ] as unknown as TemplateStringsArray)) as Record<string, any>[][];

    return (sets[0] ?? []).map(appliedFromRow).sort(byChronology);
  }

  /**
   * Applies all unapplied migrations in order.
   * Returns the names of the executed migrations.
   */
  async run(migrations: YdbMigration[]): Promise<string[]> {
    assertNoDuplicates(migrations);
    const applied = await this.getAppliedMigrations();

    const interrupted = applied.filter((r) => r.state === 'started');
    if (interrupted.length) {
      throw new Error(
        `Previous migration run did not finish: ` +
          `${interrupted.map((r) => `"${r.name}"`).join(', ')} left in "started" state. ` +
          `DDL in YDB is non-transactional, so the database may be partially migrated. ` +
          `${RECOVERY_HINT}`,
      );
    }

    const index = buildAppliedIndex(applied);
    const executed: string[] = [];

    for (const migration of migrations) {
      const name = migrationName(migration);
      const match = matchAppliedRecord(index, migration);

      if (match.kind === 'changed') {
        throw new Error(
          `Migration "${name}" was modified after it was applied ` +
            `(content hash changed from "${match.record.hash}" to "${migration.hash}"). ` +
            `Restore the original content, or reconcile explicitly via ` +
            `removeMigrationRecord(...) after fixing the database schema manually.`,
        );
      }
      if (match.kind === 'matched') continue;

      const rowId = deriveMigrationRowId(migrationIdentity(migration));
      await this.claim(rowId, migration);
      try {
        await migration.up(this.executor);
      } catch (error) {
        // The `started` marker remains: the next run is forbidden from
        // executing up() again blindly (#101).
        throw new Error(
          `Migration "${name}" failed mid-way and was left in "started" state — ` +
            `the database may be partially migrated. ${RECOVERY_HINT}`,
          { cause: error },
        );
      }
      await this.finishRecord(rowId);
      executed.push(name);
    }
    return executed;
  }

  /**
   * Reverts the most recently applied migration.
   * Returns its name, or null when there is nothing to revert.
   * Refuses to run if the latest record is in the `started` state
   * (an interrupted up()/a failed down()) — resolve it explicitly first via
   * markMigrationApplied()/removeMigrationRecord().
   */
  async revert(migrations: YdbMigration[]): Promise<string | null> {
    assertNoDuplicates(migrations);
    const applied = await this.getAppliedMigrations();
    if (!applied.length) return null;

    const last = applied[applied.length - 1];
    if (last.state === 'started') {
      // Interrupted up()/failed down(): the schema is in an unknown state,
      // a blind re-run of down() is forbidden (#101).
      throw new Error(
        `Cannot revert "${last.name}": its bookkeeping record is in "started" state — ` +
          `a previous run was interrupted mid-way, so the database state is unknown. ` +
          `${RECOVERY_HINT}`,
      );
    }
    const migration = findMigrationForRecord(migrations, last);
    if (!migration) {
      throw new Error(
        `Migration file for "${last.name}" not found — cannot revert. ` +
          `If the rollback was performed manually, remove the stale record via ` +
          `removeMigrationRecord("${last.name}").`,
      );
    }

    // Intent marker before down(): a failure between down() and the record
    // DELETE leaves the record in "started" — the state then has to be
    // resolved explicitly (#101).
    await this.startRecord(last.id);
    try {
      await migration.down(this.executor);
    } catch (error) {
      throw new Error(
        `Revert of "${last.name}" failed mid-way and was left in "started" state — ` +
          `the database may be partially rolled back. ${RECOVERY_HINT}`,
        { cause: error },
      );
    }
    await this.deleteRecord(last.id);

    return last.name;
  }

  /**
   * Status across all passed migrations (plus orphan/interrupted records).
   *
   * NOTE: this is a "serving" path — it creates the bookkeeping table if it
   * is missing (ensureMigrationsTable). Read-only consumers (readiness check
   * #152) should use computeMigrationStatuses over a snapshot from
   * readBookkeepingSnapshot — without DDL.
   */
  async status(migrations: YdbMigration[]): Promise<YdbMigrationStatus[]> {
    const applied = await this.getAppliedMigrations();
    return computeMigrationStatuses(migrations, applied);
  }

  /**
   * Recovery mechanism (#101): explicitly marks a migration as applied.
   * Use it when the database schema has been brought to the target state
   * manually after an interrupted run.
   * Accepts a migration object or a string (hash or name).
   */
  async markMigrationApplied(target: YdbMigration | string): Promise<void> {
    const record = await this.resolveRecord(target);
    await this.finishRecord(record.id);
  }

  /**
   * Recovery mechanism (#101): deletes a bookkeeping record — the migration
   * is considered fully rolled back manually. Caution: deleting the record
   * of an applied migration will cause up() to run again.
   * Accepts a migration object or a string (hash or name).
   */
  async removeMigrationRecord(target: YdbMigration | string): Promise<void> {
    const record = await this.resolveRecord(target);
    await this.deleteRecord(record.id);
  }

  /** Claims the migration for application: INSERT with state='started'. */
  private async claim(id: number, migration: YdbMigration): Promise<void> {
    const name = migrationName(migration);
    try {
      await this.insertRecord(id, name, migration.hash, 'started');
    } catch (error) {
      throw new Error(
        `Failed to start migration "${name}": its bookkeeping row already exists ` +
          `(id ${id} is derived from the migration identity), so another migration ` +
          `process is likely running concurrently. Original error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async insertRecord(
    id: number,
    name: string,
    hash: string | undefined,
    state: MigrationRecordState,
  ): Promise<void> {
    const query = this.executor([
      `INSERT INTO ${quoteIdentifier(MIGRATIONS_TABLE)} ` +
        '(`id`, `timestamp`, `name`, `hash`, `state`) ' +
        'VALUES ($id, $timestamp, $name, $hash, $state)',
    ] as unknown as TemplateStringsArray);
    query.parameter('id', mapToYdb('Int64', id, 'id'));
    query.parameter('timestamp', mapToYdb('Int64', Date.now(), 'timestamp'));
    query.parameter('name', mapToYdb('Utf8', name, 'name'));
    query.parameter('hash', mapToYdb('Utf8', hash ?? null, 'hash'));
    query.parameter('state', mapToYdb('Utf8', state, 'state'));
    await query;
  }

  private async startRecord(id: number): Promise<void> {
    await this.updateState(id, 'started');
  }

  private async finishRecord(id: number): Promise<void> {
    await this.updateState(id, 'applied');
  }

  private async updateState(
    id: number,
    state: MigrationRecordState,
  ): Promise<void> {
    const query = this.executor([
      `UPDATE ${quoteIdentifier(MIGRATIONS_TABLE)} SET \`state\` = $state, \`timestamp\` = $timestamp WHERE \`id\` = $id`,
    ] as unknown as TemplateStringsArray);
    query.parameter('state', mapToYdb('Utf8', state, 'state'));
    query.parameter('timestamp', mapToYdb('Int64', Date.now(), 'timestamp'));
    query.parameter('id', mapToYdb('Int64', id, 'id'));
    await query;
  }

  private async deleteRecord(id: number): Promise<void> {
    const query = this.executor([
      `DELETE FROM ${quoteIdentifier(MIGRATIONS_TABLE)} WHERE \`id\` = $id`,
    ] as unknown as TemplateStringsArray);
    query.parameter('id', mapToYdb('Int64', id, 'id'));
    await query;
  }

  /** Finds a bookkeeping record by a migration object or a string (hash or name). */
  private async resolveRecord(
    target: YdbMigration | string,
  ): Promise<AppliedMigration> {
    const hash = typeof target === 'string' ? target : target.hash;
    const name = typeof target === 'string' ? target : target.name;
    if (!hash && !name) {
      throw new Error(
        `Cannot resolve migration record: target has neither "hash" nor "name".`,
      );
    }

    const applied = await this.getAppliedMigrations();
    const found =
      (hash ? applied.find((r) => r.hash === hash) : undefined) ??
      (name ? applied.find((r) => r.name === name) : undefined);
    if (!found) {
      throw new Error(
        `No migration record found in ${MIGRATIONS_TABLE} for ` +
          `${typeof target === 'string' ? `"${target}"` : `"${name}"`}.`,
      );
    }
    return found;
  }
}
