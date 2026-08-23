/**
 * Read-only доступ к таблице учёта миграций (#152).
 *
 * Проверка готовности (migration:check/status/show) обязана не менять БД,
 * поэтому путь YdbMigrationRunner.status → ensureMigrationsTable()
 * (CREATE TABLE IF NOT EXISTS + возможный ALTER для легаси-таблиц)
 * ей недоступен. Вместо этого:
 *  1. существование `ydb_migrations` определяется метаданными —
 *     DescribeTable через Table service (`YdbSchemaSyncer.describeTable`,
 *     #91: null только если таблицы действительно нет; остальные ошибки
 *     пробрасываются, ничего не «глотается»);
 *  2. записи читаются голым SELECT только тех колонок, что реально есть:
 *     у легаси-таблиц (созданных до #101) колонок `hash`/`state` может не
 *     быть — вместо ALTER их отсутствие просто учитывается при чтении;
 *  3. никакого DDL и записей здесь нет в принципе.
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

/** Снимок таблицы учёта миграций без каких-либо изменений схемы. */
export interface MigrationBookkeepingSnapshot {
  /** Таблица учёта существует. */
  exists: boolean;
  /**
   * Легаси-формат (до #101): колонок `hash`/`state` нет — сопоставление
   * по имени, все записи подразумеваются применёнными.
   */
  legacy: boolean;
  /** Записи учёта в порядке применения. */
  records: AppliedMigration[];
}

/** Зависимости чтения снимка: драйвер (метаданные) + executor (SELECT). */
export interface MigrationBookkeepingDeps {
  driver: Driver;
  executor: YdbExecutor;
}

/**
 * Считывает состояние таблицы учёта БЕЗ создания/изменения.
 * Отсутствие таблицы — нормальный результат ({ exists: false }), а не
 * ошибка: свежая база ещё не инициализирована миграциями.
 */
export async function readBookkeepingSnapshot(
  deps: MigrationBookkeepingDeps,
  options?: {
    /** Шов для тестов (по умолчанию DescribeTable через YdbSchemaSyncer). */
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
