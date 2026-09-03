/**
 * CLI command-line argument parsing (#103).
 *
 * Unknown flags used to be silently treated as positional arguments
 * (`migration:create --nme foo` created a migration named "--nme"), and a
 * `--config`/`--dir` without a value quietly fell back to defaults/env.
 * Parsing is now strict: an unknown flag or an empty value is an error.
 */

/** Argument-parsing error — printed without a stack trace but with a hint. */
export class CliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgsError';
  }
}

/** Parsed CLI arguments. */
export interface CliArgs {
  command?: string;
  positional?: string;
  config?: string;
  dir?: string;
  output?: string;
  json?: boolean;
  asApplied?: boolean;
  asReverted?: boolean;
  verbose?: boolean;
  help?: boolean;
}

/** Flags that take a value (arity 1). */
const VALUE_FLAGS = new Set(['--config', '--dir', '--output']);

/** Boolean flags (arity 0). */
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--as-applied',
  '--as-reverted',
  '--verbose',
  '--help',
  '-h',
]);

function isFlagLike(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

function requireValue(flag: string, value?: string): string {
  if (value === undefined || value.trim() === '') {
    throw new CliArgsError(
      `Option ${flag} requires a non-empty value ` +
        `(example: ydb-orm migration:run ${flag} ./migrations).`,
    );
  }
  return value;
}

function valueFlagKey(flag: string): 'config' | 'dir' | 'output' {
  switch (flag) {
    case '--config':
      return 'config';
    case '--output':
      return 'output';
    default:
      return 'dir';
  }
}

/**
 * Strictly parses argv:
 *  - an unknown flag (`--nme`, `-x`) is an error, not a positional argument;
 *  - `--config`/`--dir`/`--output` with no value, an empty string, or the next
 *    flag in place of a value is an error, not a silent default;
 *  - `--flag=value` syntax is supported;
 *  - more than one positional argument after the command is an error —
 *    extra arguments are no longer silently ignored.
 */
export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!isFlagLike(token)) {
      rest.push(token);
      continue;
    }

    let flag = token;
    let inlineValue: string | undefined;
    const eqIndex = token.indexOf('=');
    if (eqIndex > 0) {
      flag = token.slice(0, eqIndex);
      inlineValue = token.slice(eqIndex + 1);
    }

    if (VALUE_FLAGS.has(flag)) {
      const key = valueFlagKey(flag);
      if (inlineValue === undefined) {
        const next = argv[i + 1];
        // A following flag instead of a value is almost certainly a typo:
        // `--config --dir x` must not turn into config="--dir".
        if (next === undefined || isFlagLike(next)) {
          throw new CliArgsError(
            `Option ${flag} requires a non-empty value ` +
              `(example: ydb-orm migration:run ${flag} ./migrations).`,
          );
        }
        result[key] = requireValue(flag, next);
        i++;
        continue;
      }
      result[key] = requireValue(flag, inlineValue);
      continue;
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      switch (flag) {
        case '--json':
          result.json = true;
          break;
        case '--as-applied':
          result.asApplied = true;
          break;
        case '--as-reverted':
          result.asReverted = true;
          break;
        case '--verbose':
          result.verbose = true;
          break;
        case '--help':
        case '-h':
          result.help = true;
          break;
      }
      continue;
    }

    throw new CliArgsError(
      `Unknown option: ${flag}. ` +
        "Run 'ydb-orm --help' to list available options.",
    );
  }

  if (rest.length > 2) {
    throw new CliArgsError(
      `Unexpected extra argument(s): ${rest.slice(2).join(', ')}.`,
    );
  }
  [result.command, result.positional] = rest;
  return result;
}

interface ErrorWithCause {
  message: string;
  stack?: string;
  cause?: unknown;
}

function errorChain(error: unknown): ErrorWithCause[] {
  const chain: ErrorWithCause[] = [];
  let current = error;
  while (current instanceof Error && chain.length < 10) {
    chain.push(current);
    current = (current as ErrorWithCause).cause;
  }
  return chain;
}

/**
 * Formats an error for stderr output (#103):
 *  - by default — the message and the cause chain ("Caused by: ...");
 *  - with verbose — context lines first, then the full stack of every link
 *    in the chain.
 * Previously only error.message was printed — the stack and the cause were lost.
 */
export function formatError(
  error: unknown,
  options?: { verbose?: boolean; context?: string[] },
): string {
  const lines: string[] = [];

  if (options?.verbose && options.context?.length) {
    lines.push(...options.context.map((line) => `[ydb-orm] ${line}`), '');
  }

  if (!(error instanceof Error)) {
    lines.push(`Unexpected error: ${String(error)}`);
    return lines.join('\n');
  }

  const chain = errorChain(error);
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    const prefix = i === 0 ? '' : 'Caused by: ';
    if (options?.verbose && entry.stack) {
      lines.push(prefix + entry.stack);
    } else if (i === 0) {
      lines.push(entry.message);
    } else {
      lines.push(`${prefix}${entry.message}`);
    }
  }

  return lines.join('\n');
}
