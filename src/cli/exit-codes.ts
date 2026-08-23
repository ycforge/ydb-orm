/**
 * Exit-коды CLI (#152).
 *
 * Для `migration:check` / `migration:status` код детерминирован
 * состоянием проверки (см. migrations/migration-check.ts), чтобы CI
 * различал «не готово» разных причин и реальный сбой команды:
 *
 *  0 — готово: все миграции применены; схема совпадает, если проверялась;
 *  1 — есть неприменённые миграции (pending);
 *  2 — есть прерванные миграции (`state='started'`, #101);
 *  3 — схема БД расходится с метаданными сущностей (нужен entities в конфиге);
 *  4 — содержимое применённой миграции изменилось (#101);
 *  5 — ошибка выполнения команды (подключение, конфиг, неожиданный сбой).
 *
 * Остальные команды: 0 — успех/help, 1 — любая ошибка (как раньше).
 */

/** Готово (успех или help). */
export const EXIT_OK = 0;
/** Есть неприменённые миграции. */
export const EXIT_PENDING_MIGRATIONS = 1;
/** Есть прерванные миграции (#101). */
export const EXIT_INTERRUPTED_MIGRATIONS = 2;
/** Схема БД расходится с метаданными сущностей. */
export const EXIT_SCHEMA_DRIFT = 3;
/** Содержимое применённой миграции изменилось (#101). */
export const EXIT_MODIFIED_MIGRATION = 4;
/** Ошибка выполнения команды (check/status); остальные команды — 1. */
export const EXIT_COMMAND_ERROR = 5;

/** Exit-код по умолчанию для ошибок вне check/status. */
export const DEFAULT_EXIT_CODE = 1;

const EXIT_CODE_TAG = Symbol('ydb-orm.cli.exitCode');

/**
 * Помечает исходную ошибку exit-кодом, не заворачивая её: цепочка cause,
 * стек и сообщение остаются нетронутыми (formatError печатает как раньше).
 */
export function tagExitCode<T>(error: T, exitCode: number): T {
  if (error instanceof Error) {
    Object.assign(error, { [EXIT_CODE_TAG]: exitCode });
  }
  return error;
}

/**
 * Достаёт exit-код из помеченной ошибки (или из её цепочки cause);
 * неизвестные ошибки — DEFAULT_EXIT_CODE.
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
