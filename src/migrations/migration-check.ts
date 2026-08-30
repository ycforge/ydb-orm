/**
 * Ядро проверки готовности схемы БД (#152): чистая функция над статусами
 * миграций (`YdbMigrationRunner.status`) и, опционально, расхождениями
 * схемы (`YdbSchemaSyncer.verify`). Никакого I/O — CLI лишь рендерит
 * результат и выбирает exit-код.
 *
 * Различимые состояния:
 *  - `ok`           — всё применено (и схема совпадает, если проверялась);
 *  - `pending`      — есть неприменённые миграции;
 *  - `interrupted`  — есть записи `state='started'` (#101): прошлый запуск
 *    оборвался посреди миграции, БД может быть частично изменена;
 *  - `modified`     — содержимое применённой миграции изменилось (#101);
 *  - `schema-drift` — схема БД расходится с метаданными сущностей
 *    (проверяется только если в конфиге CLI заданы entities).
 *
 * Прерванные и изменённые миграции НЕ считаются успешно применёнными —
 * у таких статусов `applied=false` (флаг «причина» сохранён, #212).
 * Orphan-записи (файл удалён после применения) — информационные: сами по
 * себе готовность не ломают, но всегда выводятся в отчёте.
 */
import type { YdbSchemaIssue } from '../schema/schema-sync.js';
import type { YdbMigrationStatus } from './migration-runner.js';

/** Состояние готовности схемы БД для migration:check / migration:status. */
export type MigrationCheckState =
  'ok' | 'pending' | 'interrupted' | 'modified' | 'schema-drift';

/** Состояния, означающие «не готово», в порядке приоритета. */
export const MIGRATION_CHECK_STATES: readonly Exclude<
  MigrationCheckState,
  'ok'
>[] = ['interrupted', 'modified', 'pending', 'schema-drift'];

export interface MigrationCheckVerdict {
  /** true — только когда нет ни одного состояния «не готово». */
  ready: boolean;
  /**
   * Определяющее состояние: первое по приоритету из обнаруженных
   * (или 'ok'). По нему выбирается exit-код команды.
   */
  state: MigrationCheckState;
  /** Все обнаруженные состояния «не готово» в порядке приоритета. */
  states: Array<Exclude<MigrationCheckState, 'ok'>>;
  /** Всего миграций в директории (без orphan-записей). */
  totalMigrations: number;
  /**
   * Успешно применённых (без interrupted/modified/orphan) — для отчётов;
   * готовность определяется полем ready, а не этим числом.
   */
  appliedCount: number;
  pending: string[];
  interrupted: string[];
  modified: string[];
  /** Информационные записи без файла миграции (на exit-код не влияют). */
  orphaned: string[];
}

/**
 * Exit-коды `migration:check` / `migration:status` (#152).
 * Детерминированы состоянием; help/успех — 0. Ошибка выполнения
 * команды (подключение, I/O, неожиданное исключение) — отдельный код 5,
 * чтобы CI не путал её с ожидаемым «не готово».
 */
export const MIGRATION_STATE_EXIT_CODES: Record<MigrationCheckState, number> =
  Object.freeze({
    ok: 0,
    pending: 1,
    interrupted: 2,
    'schema-drift': 3,
    modified: 4,
  });

/** Exit-код по определяющему состоянию вердикта. */
export function migrationStateExitCode(state: MigrationCheckState): number {
  return MIGRATION_STATE_EXIT_CODES[state];
}

/**
 * Здоровая «применённая» миграция (#212): единственная точка истины для
 * «applied=true не означает проблему». Изменённая после применения и
 * прерванная миграции сюда не проходят в любой форме входных данных —
 * и новые (applied=false + флаг), и legacy/ручные (applied=true + флаг).
 */
function isHealthilyApplied(status: YdbMigrationStatus): boolean {
  return status.applied && !status.interrupted && !status.contentChanged;
}

/**
 * Сводит статусы миграций (+ опциональные issues схемы) к вердикту.
 * Приоритет при нескольких состояниях: interrupted > modified >
 * pending > schema-drift — сначала то, что блокирует повторный запуск
 * миграций, потом обычное «не применено», затем информационный drift.
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
      // Orphan-запись в состоянии `started`/с изменённым хешем всё равно
      // блокирует: она попадает и в соответствующий список проблем.
      // Чистый applied-orphan — только информационный.
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
