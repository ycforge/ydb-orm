/**
 * CLI exit codes (#152).
 *
 * For `migration:check` / `migration:status` the code is determined
 * by the verification state (see migrations/migration-check.ts), so CI
 * can distinguish different "not ready" reasons from an actual command failure:
 *
 *  0 — ready: all migrations applied; schema matches if checked;
 *  1 — pending migrations exist;
 *  2 — interrupted migrations exist (`state='started'`, #101);
 *  3 — DB schema diverges from entity metadata (requires entities in config);
 *  4 — applied migration content changed (#101);
 *  5 — command execution error (connection, config, unexpected crash).
 *
 * Other commands: 0 — success/help, 1 — any error (as before).
 */

/** Ready (success or help). */
export const EXIT_OK = 0;
/** Pending migrations exist. */
export const EXIT_PENDING_MIGRATIONS = 1;
/** Interrupted migrations exist (#101). */
export const EXIT_INTERRUPTED_MIGRATIONS = 2;
/** DB schema diverges from entity metadata. */
export const EXIT_SCHEMA_DRIFT = 3;
/** Applied migration content changed (#101). */
export const EXIT_MODIFIED_MIGRATION = 4;
/** Command execution error (check/status); other commands — 1. */
export const EXIT_COMMAND_ERROR = 5;

/** Default exit code for errors outside check/status. */
export const DEFAULT_EXIT_CODE = 1;

const EXIT_CODE_TAG = Symbol('ydb-orm.cli.exitCode');

/**
 * Tags the original error with an exit code, without wrapping it: the cause
 * chain, stack, and message remain intact (formatError prints as before).
 */
export function tagExitCode<T>(error: T, exitCode: number): T {
  if (error instanceof Error) {
    Object.assign(error, { [EXIT_CODE_TAG]: exitCode });
  }
  return error;
}

/**
 * Extracts the exit code from a tagged error (or from its cause chain);
 * unknown errors — DEFAULT_EXIT_CODE.
 */
export function exitCodeOf(error: unknown): number {
  let current: unknown = error;
  while (current instanceof Error) {
    const tagged = (current as unknown as Record<symbol, unknown>)[
      EXIT_CODE_TAG
    ];
    if (typeof tagged === 'number' && Number.isInteger(tagged) && tagged >= 0) {
      return tagged;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return DEFAULT_EXIT_CODE;
}
