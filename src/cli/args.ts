/**
 * Разбор аргументов командной строки CLI (#103).
 *
 * Раньше неизвестные флаги молча становились позиционными аргументами
 * (`migration:create --nme foo` создавал миграцию с именем «--nme»),
 * а `--config`/`--dir` без значения тихо откатывались к дефолтам/env.
 * Теперь разбор строгий: неизвестный флаг или пустое значение — ошибка.
 */

/** Ошибка разбора аргументов — печатается без стека, но с подсказкой. */
export class CliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgsError';
  }
}

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

/** Флаги, принимающие значение (арность 1). */
const VALUE_FLAGS = new Set(['--config', '--dir', '--output']);

/** Булевы флаги (арность 0). */
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
        `(example: yorm migration:run ${flag} ./migrations).`,
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
 * Строго разбирает argv:
 *  - неизвестный флаг (`--nme`, `-x`) — ошибка, а не позиционный аргумент;
 *  - `--config`/`--dir`/`--output` без значения, с пустой строкой или со следующим
 *    флагом вместо значения — ошибка, а не тихий дефолт;
 *  - поддерживается синтаксис `--flag=value`;
 *  - больше одного позиционного аргумента после команды — ошибка,
 *    лишние аргументы больше не игнорируются молча.
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
        // Следующий флаг вместо значения — почти наверняка опечатка:
        // `--config --dir x` не должен превращаться в config="--dir".
        if (next === undefined || isFlagLike(next)) {
          throw new CliArgsError(
            `Option ${flag} requires a non-empty value ` +
              `(example: yorm migration:run ${flag} ./migrations).`,
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
        "Run 'yorm --help' to list available options.",
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
 * Форматирует ошибку для вывода в stderr (#103):
 *  - по умолчанию — сообщение и цепочка cause («Caused by: ...»);
 *  - при verbose — строки context, затем полный стек каждого звена цепочки.
 * Раньше печатался только error.message — стек и причина терялись.
 */
export function formatError(
  error: unknown,
  options?: { verbose?: boolean; context?: string[] },
): string {
  const lines: string[] = [];

  if (options?.verbose && options.context?.length) {
    lines.push(...options.context.map((line) => `[yorm] ${line}`), '');
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
