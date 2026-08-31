/**
 * Unified migration verification workflow for `migration:check` and
 * `migration:status` (#152).
 *
 * Command only READS state and performs NO DDL:
 *  - existence of the `ydb_migrations` bookkeeping table is determined via
 *    DescribeTable (readBookkeepingSnapshot); if absent — database is
 *    considered uninitialized ("nothing applied"), table is NOT created;
 *  - records are read with a raw SELECT (no CREATE/ALTER, legacy table
 *    columns accounted for without modification);
 *  - for entities from config — DescribeTable via YdbSchemaSyncer.verify.
 *
 * Distinct states and exit codes see in
 * migrations/migration-check.ts and cli/exit-codes.ts.
 *
 * Output:
 *  - text mode: summary/list — to stdout, issues — to stderr,
 *    final line `Up to date: ...` / `Not ready: ...` per result stream;
 *    schema diff color determined by actual output stream (stderr), not
 *    stdout (#103);
 *  - `--json`: entire machine-readable report — only in stdout, stable
 *    schema (no color or human wording).
 */
import type { Driver } from '@ydbjs/core';
import { YdbExecutor } from '../core/interfaces.js';
import {
  computeMigrationStatuses,
  migrationName,
  type YdbMigrationStatus,
} from '../migrations/migration-runner.js';
import { loadMigrationsFromDir } from '../migrations/migration-loader.js';
import type { YdbMigration } from '../migrations/migration.interface.js';
import {
  readBookkeepingSnapshot,
  type MigrationBookkeepingSnapshot,
} from '../migrations/migration-bookkeeping.js';
import {
  evaluateMigrationCheck,
  migrationStateExitCode,
  type MigrationCheckState,
  type MigrationCheckVerdict,
} from '../migrations/migration-check.js';
import { YdbSchemaSyncer, type YdbSchemaIssue } from '../schema/schema-sync.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { renderSchemaDiff, shouldUseColor } from './diff.js';
import { EXIT_COMMAND_ERROR, tagExitCode } from './exit-codes.js';

/** Commands that use this workflow. */
export type MigrationVerifyCommand =
  'migration:check' | 'migration:show' | 'migration:status';

/** Command output streams: summaries to stdout, issues to stderr. */
export interface MigrationVerifyIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

/**
 * Streams for color decision (#103): by default the real
 * process.stdout/process.stderr; in tests, fakes are substituted.
 */
export interface MigrationVerifyStreams {
  stdout?: { isTTY?: boolean | undefined };
  stderr?: { isTTY?: boolean | undefined };
}

export interface RunMigrationVerificationOptions {
  command: MigrationVerifyCommand;
  /** Migrations directory (--dir or from config). */
  migrationsDir: string;
  /**
   * Entities from the CLI config: if provided, DB schema is additionally
   * checked (read-only DescribeTable) — otherwise the schema-drift state
   * is unavailable and marked as unchecked in the report.
   */
  entities?: (new (...args: any[]) => any)[] | undefined;
  /** Machine-readable output: everything in stdout, no color. */
  json?: boolean | undefined;
  io: MigrationVerifyIo;
  streams?: MigrationVerifyStreams | undefined;
  connect: () => Promise<{
    driver: Driver;
    executor: YdbExecutor;
    close: () => void;
  }>;
  /** Test seam (default — load from directory). */
  loadMigrations?: ((dir: string) => Promise<YdbMigration[]>) | undefined;
  /**
   * Read-only inspection of the migration bookkeeping table (#152): DescribeTable
   * + bare SELECT, no CREATE/ALTER. Test seam.
   */
  inspectBookkeeping?:
    | ((deps: {
        driver: Driver;
        executor: YdbExecutor;
      }) => Promise<MigrationBookkeepingSnapshot>)
    | undefined;
  /** Test seam (default — YdbSchemaSyncer.verify). */
  verifySchema?:
    | ((
        driver: Driver,
        executor: YdbExecutor,
        entities: (new (...args: any[]) => any)[],
      ) => Promise<YdbSchemaIssue[]>)
    | undefined;
}

/**
 * Returns entity metadata or throws if class is not decorated
 * with @YdbEntity (otherwise syncer.verify silently skips such a class).
 */
export function requireEntityMeta(entity: any): any {
  const meta = getYdbEntityMetadata(entity);
  if (!meta) {
    throw new Error(`Class ${entity.name} is not decorated with @YdbEntity`);
  }
  return meta;
}

async function defaultVerifySchema(
  driver: Driver,
  executor: YdbExecutor,
  entities: (new (...args: any[]) => any)[],
): Promise<YdbSchemaIssue[]> {
  for (const entity of entities) {
    requireEntityMeta(entity);
  }
  const syncer = new YdbSchemaSyncer(driver, executor);
  return syncer.verify(entities);
}

function isoOrNull(date?: Date): string | null {
  return date ? date.toISOString() : null;
}

/** `migration:status` line for a single migration (markers #101). */
export function renderStatusLine(status: YdbMigrationStatus): string {
  if (status.orphan) {
    // Applied, but migration file no longer exists (#101).
    const flags: string[] = [];
    if (status.interrupted) flags.push('interrupted');
    if (status.contentChanged) flags.push('content changed');
    return (
      `[!] ${status.name} — orphan record (no matching migration file)` +
      (flags.length ? ` [${flags.join(', ')}]` : '')
    );
  }
  if (status.interrupted && status.contentChanged) {
    return (
      `[~] ${status.name} — interrupted and content changed after apply, ` +
      `resolve via migration:repair`
    );
  }
  if (status.interrupted) {
    // Interrupted mid-apply/revert (#101).
    return `[~] ${status.name} — interrupted, resolve via migration:repair`;
  }
  if (status.contentChanged) {
    return (
      `[#] ${status.name} — content changed after apply, restore the original ` +
      `file or reconcile via removeMigrationRecord(...)`
    );
  }
  return (
    `${status.applied ? '[x]' : '[ ]'} ${status.name}` +
    (status.appliedAt ? ` (${isoOrNull(status.appliedAt)})` : '')
  );
}

/**
 * Runs verification and renders the report. Throws the original error
 * tagged with EXIT_COMMAND_ERROR (5): cause chain preserved.
 * Returns verdict — caller sets process.exitCode.
 *
 * Read-only contract (#152): bookkeeping table state read via
 * readBookkeepingSnapshot (DescribeTable + raw SELECT, no DDL);
 * YdbMigrationRunner.status with its ensureMigrationsTable() never
 * called here.
 */
export async function runMigrationVerification(
  options: RunMigrationVerificationOptions,
): Promise<MigrationCheckVerdict> {
  const {
    command,
    migrationsDir,
    entities,
    json = false,
    io,
    streams,
    connect,
    loadMigrations = loadMigrationsFromDir,
    inspectBookkeeping = readBookkeepingSnapshot,
    verifySchema = defaultVerifySchema,
  } = options;

  try {
    const { driver, executor, close } = await connect();
    let statuses: YdbMigrationStatus[];
    let snapshot: MigrationBookkeepingSnapshot;
    let schemaIssues: YdbSchemaIssue[] | undefined;

    try {
      const migrations = await loadMigrations(migrationsDir);
      snapshot = await inspectBookkeeping({ driver, executor });
      statuses = snapshot.exists
        ? computeMigrationStatuses(migrations, snapshot.records)
        : // Bookkeeping table doesn't exist yet: nothing was applied — all
          // migrations from files are considered pending; table is NOT created.
          migrations.map((migration) => ({
            name: migrationName(migration),
            applied: false,
          }));
      if (entities?.length) {
        schemaIssues = await verifySchema(driver, executor, entities);
      }
    } finally {
      close();
    }

    const verdict = evaluateMigrationCheck(statuses, { schemaIssues });

    if (json) {
      renderJson(io, command, verdict, statuses, schemaIssues, snapshot);
    } else {
      renderText(
        io,
        streams,
        command,
        verdict,
        statuses,
        schemaIssues,
        snapshot,
      );
    }

    return verdict;
  } catch (error) {
    throw tagExitCode(error, EXIT_COMMAND_ERROR);
  }
}

/** Fully applied without blocking states (legacy field semantics). */
function isBookkeepingApplied(verdict: MigrationCheckVerdict): boolean {
  return (
    verdict.pending.length === 0 &&
    verdict.interrupted.length === 0 &&
    verdict.modified.length === 0
  );
}

interface JsonMigrationEntry {
  name: string;
  applied: boolean;
  appliedAt: string | null;
  interrupted: boolean;
  orphan: boolean;
  contentChanged: boolean;
}

/**
 * Machine-readable report (#152): stable schema, deterministic order
 * of keys and rows, ISO dates, boolean flags always explicit. Parse this,
 * not color/wording of text mode. The `bookkeeping` block distinguishes
 * an "uninitialized" database (bookkeeping table doesn't exist yet) from
 * a fully applied one.
 */
export function buildJsonReport(
  command: MigrationVerifyCommand,
  verdict: MigrationCheckVerdict,
  statuses: YdbMigrationStatus[],
  schemaIssues: YdbSchemaIssue[] | undefined,
  bookkeeping: Pick<MigrationBookkeepingSnapshot, 'exists' | 'legacy'>,
): Record<string, unknown> {
  const migrations: JsonMigrationEntry[] = statuses.map((s) => ({
    name: s.name,
    // `applied` in report — only cleanly applied (#212): modified
    // after apply and interrupted migrations are not considered applied
    // regardless of status field value (producer already gives false).
    applied: s.applied && !s.interrupted && !s.contentChanged,
    appliedAt: isoOrNull(s.appliedAt),
    interrupted: s.interrupted === true,
    orphan: s.orphan === true,
    contentChanged: s.contentChanged === true,
  }));

  return {
    command,
    ready: verdict.ready,
    state: verdict.state,
    states: verdict.states,
    exitCode: migrationStateExitCode(verdict.state),
    total: verdict.totalMigrations,
    appliedCount: verdict.appliedCount,
    applied: isBookkeepingApplied(verdict),
    pending: [...verdict.pending],
    interrupted: [...verdict.interrupted],
    modified: [...verdict.modified],
    orphaned: [...verdict.orphaned],
    migrations,
    bookkeeping: {
      exists: bookkeeping.exists,
      legacy: bookkeeping.legacy,
    },
    schema:
      schemaIssues === undefined
        ? { checked: false }
        : {
            checked: true,
            issueCount: schemaIssues.length,
            issues: schemaIssues.map((i) => ({
              tableName: i.tableName,
              kind: i.kind,
              message: i.message,
            })),
          },
  };
}

function renderJson(
  io: MigrationVerifyIo,
  command: MigrationVerifyCommand,
  verdict: MigrationCheckVerdict,
  statuses: YdbMigrationStatus[],
  schemaIssues: YdbSchemaIssue[] | undefined,
  bookkeeping: Pick<MigrationBookkeepingSnapshot, 'exists' | 'legacy'>,
): void {
  io.stdout(
    JSON.stringify(
      buildJsonReport(command, verdict, statuses, schemaIssues, bookkeeping),
      null,
      2,
    ),
  );
}

function renderText(
  io: MigrationVerifyIo,
  streams: MigrationVerifyStreams | undefined,
  command: MigrationVerifyCommand,
  verdict: MigrationCheckVerdict,
  statuses: YdbMigrationStatus[],
  schemaIssues: YdbSchemaIssue[] | undefined,
  bookkeeping: Pick<MigrationBookkeepingSnapshot, 'exists' | 'legacy'>,
): void {
  // Arrow wrappers: do not detach io methods from the object (#103-style lint).
  const out = (line: string) => io.stdout(line);
  const err = (line: string) => io.stderr(line);

  if (!bookkeeping.exists) {
    // Fresh database: bookkeeping table doesn't exist yet. Information — in
    // stdout; table is NOT created, state is considered "nothing applied".
    out(
      `Bookkeeping table ydb_migrations does not exist yet — ` +
        `no migrations have been applied (nothing was created).`,
    );
  }

  if (command === 'migration:check') {
    // Summary instead of a full list: the full list is in migration:status.
    out(
      `Migrations: ${verdict.appliedCount}/${verdict.totalMigrations} applied` +
        (verdict.orphaned.length
          ? `, ${verdict.orphaned.length} orphan record(s)`
          : ''),
    );
  } else {
    out(`Migration status (${statuses.length} record(s)):`);
    for (const status of statuses) {
      out(renderStatusLine(status));
    }
  }

  if (verdict.pending.length) {
    err(
      `Pending migrations (${verdict.pending.length}/${verdict.totalMigrations}):`,
    );
    for (const name of verdict.pending) {
      err(`  - ${name}`);
    }
  }

  if (verdict.interrupted.length) {
    err(
      `Interrupted migrations (${verdict.interrupted.length}) — the previous run did not finish:`,
    );
    for (const name of verdict.interrupted) {
      err(`  - ${name} (state='started'; resolve via migration:repair)`);
    }
  }

  if (verdict.modified.length) {
    err(`Modified after apply (${verdict.modified.length}):`);
    for (const name of verdict.modified) {
      err(
        `  - ${name} — restore the original file or reconcile via removeMigrationRecord(...)`,
      );
    }
  }

  // Orphans are already visible in the migration:status list — a separate
  // section only for the compact migration:check.
  if (command === 'migration:check' && verdict.orphaned.length) {
    err(
      `Orphan records (${verdict.orphaned.length}) — applied but no matching migration file:`,
    );
    for (const name of verdict.orphaned) {
      err(`  - ${name}`);
    }
  }

  if (schemaIssues !== undefined && schemaIssues.length) {
    err(
      `Schema differs from entity metadata (${schemaIssues.length} issue(s)):`,
    );
    // Color is decided by stderr — where the diff actually lands (#103).
    err(
      renderSchemaDiff(schemaIssues, {
        color: shouldUseColor(
          (streams?.stderr ?? process.stderr) as NodeJS.WriteStream,
        ),
      }),
    );
  }

  if (verdict.ready) {
    const schemaNote =
      schemaIssues === undefined ? '' : '; schema matches entity metadata';
    out(
      `Up to date: ${verdict.appliedCount} migration(s) applied${schemaNote}`,
    );
  } else {
    err(`Not ready: ${formatStates(verdict.states)}`);
  }
}

const STATE_LABELS: Record<Exclude<MigrationCheckState, 'ok'>, string> = {
  pending: 'pending migrations',
  interrupted: 'interrupted migrations',
  modified: 'modified migrations',
  'schema-drift': 'schema drift',
};

function formatStates(
  states: Array<Exclude<MigrationCheckState, 'ok'>>,
): string {
  return states.map((s) => STATE_LABELS[s]).join(', ');
}
