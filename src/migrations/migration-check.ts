/**
 * Core of the database schema readiness check (#152): a pure function over
 * migration statuses (`YdbMigrationRunner.status`) and, optionally, schema
 * drift (`YdbSchemaSyncer.verify`). No I/O — the CLI merely renders the
 * result and chooses the exit code.
 *
 * Distinguishable states:
 *  - `ok`           — everything is applied (and the schema matches, if checked);
 *  - `pending`      — there are unapplied migrations;
 *  - `interrupted`  — there are `state='started'` records (#101): a previous
 *    run broke off mid-migration, the DB may be partially changed;
 *  - `modified`     — the content of an applied migration changed (#101);
 *  - `schema-drift` — the DB schema diverges from the entity metadata
 *    (checked only when entities are configured in the CLI config).
 *
 * Interrupted and modified migrations are NOT considered successfully
 * applied — such statuses have `applied=false` (the "reason" flag is kept,
 * #212). Orphan records (file deleted after application) are informational:
 * on their own they do not break readiness, but are always shown in the report.
 */
import type { YdbSchemaIssue } from '../schema/schema-sync.js';
import type { YdbMigrationStatus } from './migration-runner.js';

/** Database schema readiness state for migration:check / migration:status. */
export type MigrationCheckState =
  'ok' | 'pending' | 'interrupted' | 'modified' | 'schema-drift';

/** The "not ready" states, in priority order. */
export const MIGRATION_CHECK_STATES: readonly Exclude<
  MigrationCheckState,
  'ok'
>[] = ['interrupted', 'modified', 'pending', 'schema-drift'];

/** Verdict of a readiness evaluation combining migration statuses and optional schema drift. */
export interface MigrationCheckVerdict {
  /** true — only when there is no "not ready" state at all. */
  ready: boolean;
  /**
   * The decisive state: the first by priority among the detected ones
   * (or 'ok'). The command's exit code is selected from it.
   */
  state: MigrationCheckState;
  /** All detected "not ready" states in priority order. */
  states: Array<Exclude<MigrationCheckState, 'ok'>>;
  /** Total migrations in the directory (excluding orphan records). */
  totalMigrations: number;
  /**
   * Successfully applied (excluding interrupted/modified/orphan) — for
   * reports; readiness is determined by the `ready` field, not this number.
   */
  appliedCount: number;
  pending: string[];
  interrupted: string[];
  modified: string[];
  /** Informational records without a migration file (do not affect the exit code). */
  orphaned: string[];
}

/**
 * Exit codes for `migration:check` / `migration:status` (#152).
 * Determined by the state; help/success — 0. A command execution error
 * (connection, I/O, unexpected exception) is a separate code 5, so CI does
 * not confuse it with the expected "not ready".
 */
export const MIGRATION_STATE_EXIT_CODES: Record<MigrationCheckState, number> =
  Object.freeze({
    ok: 0,
    pending: 1,
    interrupted: 2,
    'schema-drift': 3,
    modified: 4,
  });

/** Exit code for the verdict's decisive state. */
export function migrationStateExitCode(state: MigrationCheckState): number {
  return MIGRATION_STATE_EXIT_CODES[state];
}

/**
 * A healthy "applied" migration (#212): the single source of truth that
 * "applied=true does not mean a problem". Migrations modified after being
 * applied and interrupted migrations never pass here in any input shape —
 * neither new (applied=false + flag) nor legacy/manual (applied=true + flag).
 */
function isHealthilyApplied(status: YdbMigrationStatus): boolean {
  return status.applied && !status.interrupted && !status.contentChanged;
}

/**
 * Reduces migration statuses (+ optional schema issues) to a verdict.
 * Priority with multiple states: interrupted > modified > pending >
 * schema-drift — first what blocks re-running migrations, then the plain
 * "not applied", then the informational drift.
 */
export function evaluateMigrationCheck(
  statuses: YdbMigrationStatus[],
  options?: { schemaIssues?: YdbSchemaIssue[] },
): MigrationCheckVerdict {
  const pending: string[] = [];
  const interrupted: string[] = [];
  const modified: string[] = [];
  const orphaned: string[] = [];
  let appliedCount = 0;

  for (const status of statuses) {
    if (status.orphan) {
      orphaned.push(status.name);
      // An orphan record in the `started` state or with a changed hash still
      // blocks: it lands in the corresponding problem list too.
      // A clean applied orphan is informational only.
      if (!status.interrupted && !status.contentChanged) continue;
    }
    if (status.interrupted) interrupted.push(status.name);
    else if (status.contentChanged) modified.push(status.name);
    else if (isHealthilyApplied(status)) appliedCount++;
    else pending.push(status.name);
  }

  const found = new Set<Exclude<MigrationCheckState, 'ok'>>();
  if (interrupted.length) found.add('interrupted');
  if (modified.length) found.add('modified');
  if (pending.length) found.add('pending');
  if (options?.schemaIssues?.length) found.add('schema-drift');

  const states = MIGRATION_CHECK_STATES.filter((s) => found.has(s));

  return {
    ready: states.length === 0,
    state: states[0] ?? 'ok',
    states,
    totalMigrations: statuses.length - orphaned.length,
    appliedCount,
    pending,
    interrupted,
    modified,
    orphaned,
  };
}
