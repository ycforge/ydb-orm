import { YdbExecutor } from '../core/interfaces.js';
import { mapToYdb } from '../core/mapper.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import { YdbMigration, executeSql } from './migration.interface.js';

/** Таблица учёта применённых миграций. */
export const MIGRATIONS_TABLE = 'ydb_migrations';

export interface AppliedMigration {
  id: number;
  timestamp: number;
  name: string;
}

export interface YdbMigrationStatus {
  name: string;
  applied: boolean;
  appliedAt?: Date;
}

/**
 * Исполнитель миграций: ведёт таблицу `ydb_migrations`,
 * применяет новые миграции по порядку и откатывает последнюю.
 *
 * DDL в YDB не транзакционен, поэтому миграции выполняются
 * последовательно без обёртки в транзакцию.
 */
export class YdbMigrationRunner {
  constructor(private readonly executor: YdbExecutor) {}

  /** Создаёт таблицу учёта миграций, если её ещё нет. */
  async ensureMigrationsTable(): Promise<void> {
    await executeSql(
      this.executor,
      `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(MIGRATIONS_TABLE)} (` +
        '`id` Int64, `timestamp` Int64, `name` Utf8, ' +
        'PRIMARY KEY (`id`)' +
        ')',
    );
  }

  /** Список применённых миграций в порядке применения. */
  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.ensureMigrationsTable();
    const sets = (await this.executor([
      `SELECT \`id\`, \`timestamp\`, \`name\` FROM ${quoteIdentifier(MIGRATIONS_TABLE)} ORDER BY \`id\``,
    ] as unknown as TemplateStringsArray)) as Record<string, any>[][];

    return (sets[0] ?? [])
      .map((row) => ({
        id: Number(row.id),
        timestamp: Number(row.timestamp),
        name: String(row.name),
      }))
      .sort((a, b) => a.id - b.id);
  }

  /**
   * Применяет все неприменённые миграции по порядку.
   * Возвращает имена выполненных миграций.
   */
  async run(migrations: YdbMigration[]): Promise<string[]> {
    const applied = await this.getAppliedMigrations();
    const appliedNames = new Set(applied.map((m) => m.name));
    let nextId = applied.length ? Math.max(...applied.map((m) => m.id)) + 1 : 1;

    const executed: string[] = [];
    for (const migration of migrations) {
      const name = this.nameOf(migration);
      if (appliedNames.has(name)) continue;

      await migration.up(this.executor);
      await this.record(nextId++, name);
      executed.push(name);
    }
    return executed;
  }

  /**
   * Откатывает последнюю применённую миграцию.
   * Возвращает её имя или null, если откатывать нечего.
   */
  async revert(migrations: YdbMigration[]): Promise<string | null> {
    const applied = await this.getAppliedMigrations();
    if (!applied.length) return null;

    const last = applied[applied.length - 1];
    const migration = migrations.find((m) => this.nameOf(m) === last.name);
    if (!migration) {
      throw new Error(
        `Migration file for "${last.name}" not found — cannot revert`,
      );
    }

    await migration.down(this.executor);
    const query = this.executor([
      `DELETE FROM ${quoteIdentifier(MIGRATIONS_TABLE)} WHERE \`id\` = $id`,
    ] as unknown as TemplateStringsArray);
    query.parameter('id', mapToYdb('Int64', last.id));
    await query;

    return last.name;
  }

  /** Статус по всем переданным миграциям (применена/нет). */
  async status(migrations: YdbMigration[]): Promise<YdbMigrationStatus[]> {
    const applied = await this.getAppliedMigrations();
    const byName = new Map(applied.map((m) => [m.name, m]));

    return migrations.map((migration) => {
      const name = this.nameOf(migration);
      const record = byName.get(name);
      return {
        name,
        applied: Boolean(record),
        appliedAt: record ? new Date(record.timestamp) : undefined,
      };
    });
  }

  private nameOf(migration: YdbMigration): string {
    if (!migration.name) {
      throw new Error(
        `Migration ${migration.constructor.name} has no name. ` +
          `Set the "name" property or load migrations via loadMigrationsFromDir().`,
      );
    }
    return migration.name;
  }

  private async record(id: number, name: string): Promise<void> {
    const query = this.executor([
      `INSERT INTO ${quoteIdentifier(MIGRATIONS_TABLE)} (\`id\`, \`timestamp\`, \`name\`) VALUES ($id, $timestamp, $name)`,
    ] as unknown as TemplateStringsArray);
    query.parameter('id', mapToYdb('Int64', id));
    query.parameter('timestamp', mapToYdb('Int64', Date.now()));
    query.parameter('name', mapToYdb('Utf8', name));
    await query;
  }
}
