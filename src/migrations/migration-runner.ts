import { createHash } from 'node:crypto';
import { YdbExecutor } from '../core/interfaces.js';
import { mapToYdb } from '../core/mapper.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import { YdbMigration, executeSql } from './migration.interface.js';

/** Таблица учёта применённых миграций. */
export const MIGRATIONS_TABLE = 'ydb_migrations';

/** Состояние записи учёта миграции (#101). */
export type MigrationRecordState = 'applied' | 'started';

export interface AppliedMigration {
  id: number;
  timestamp: number;
  name: string;
  /**
   * Стабильный идентификатор содержимого (SHA-256, #101).
   * Отсутствует у записей старого формата (до появления колонки `hash`).
   */
  hash?: string;
  /**
   * `started` — миграция начата, но не завершена: маркер частичного
   * применения после сбоя (DDL в YDB не транзакционен).
   * У записей старого формата подразумевается `applied`.
   */
  state: MigrationRecordState;
}

export interface YdbMigrationStatus {
  name: string;
  applied: boolean;
  appliedAt?: Date;
  /** Запись есть в БД, но среди переданных миграций её нет (файл удалён). */
  orphan?: boolean;
  /** Миграция помечена начатой (`state = 'started'`), но не завершена. */
  interrupted?: boolean;
}

/** Имя миграции или понятная ошибка. */
function migrationName(migration: YdbMigration): string {
  if (!migration.name) {
    throw new Error(
      `Migration ${migration.constructor.name} has no name. ` +
        `Set the "name" property or load migrations via loadMigrationsFromDir().`,
    );
  }
  return migration.name;
}

/**
 * Стабильная идентичность миграции (#101): хеш содержимого, а при его
 * отсутствии — имя. Переименование файла идентичность не меняет, поэтому
 * применённая миграция не выполняется повторно под новым именем.
 */
export function migrationIdentity(migration: YdbMigration): string {
  return migration.hash ?? migrationName(migration);
}

/**
 * Детерминированный id строки учёта из идентичности миграции (#101):
 * первые 13 hex-символов SHA-256 (52 бита — диапазон безопасных целых,
 * значение не искажается при переводе в number).
 *
 * Два параллельных процесса претендуют на одну и ту же миграцию →
 * вычисляют один и тот же id → конфликт PRIMARY KEY на INSERT-claim.
 * Так защита от гонки обеспечивается атомарно на уровне БД, а не
 * внутрипроцессным локом.
 */
export function deriveMigrationRowId(identity: string): number {
  const hex = createHash('sha256').update(identity, 'utf8').digest('hex');
  return Number.parseInt(hex.slice(0, 13), 16);
}

/** Порядок применения: по timestamp, затем по id (id больше не хронологичен). */
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
 * Дубликаты во входном массиве — ошибка (#101): раньше второй дубликат
 * молча skip-ался (или применялся повторно).
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
 * Сопоставляет миграцию с записью учёта (#101):
 *  1. по стабильному хешу содержимого — переименование файла не страшно;
 *  2. по имени, если у записи нет хеша (legacy-записи старого формата);
 *  3. имя совпадает, а хеши различаются → содержимое изменили после
 *     применения — выполнение такой миграции опасно, нужен явный reconcile.
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

/** Ищет класс миграции для записи учёта (приоритет — точное совпадение хеша). */
function findMigrationForRecord(
  migrations: YdbMigration[],
  record: AppliedMigration,
): YdbMigration | undefined {
  if (record.hash) {
    return migrations.find((m) => m.hash === record.hash);
  }
  // Legacy-записи без хеша сопоставляем только по имени.
  return migrations.find((m) => migrationName(m) === record.name);
}

/** Есть ли у записи учёта соответствие среди переданных миграций. */
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

const RECOVERY_HINT =
  `Do not re-run it blindly: finish or roll back the database changes manually, ` +
  `then resolve the bookkeeping row explicitly via ` +
  `markMigrationApplied(...) or removeMigrationRecord(...).`;

/**
 * Исполнитель миграций: ведёт таблицу `ydb_migrations`,
 * применяет новые миграции по порядку и откатывает последнюю.
 *
 * DDL в YDB не транзакционен, поэтому миграции выполняются последовательно
 * без обёртки в транзакцию (#101):
 *  - перед `up()`/`down()` в таблицу учёта пишется маркер `state='started'`;
 *  - сбой посреди миграции оставляет этот маркер — повторный `run()` не
 *    начнёт миграцию заново вслепую, пока состояние не разрешат явно через
 *    `markMigrationApplied()` / `removeMigrationRecord()`;
 *  - claim на применение — INSERT с детерминированным id (из хеша
 *    содержимого): параллельные процессы сталкиваются на PRIMARY KEY,
 *    двойное применение невозможно.
 */
export class YdbMigrationRunner {
  /** Кеш ensure: один round-trip на инстанс вместо каждого чтения (#101). */
  private ensurePromise?: Promise<void>;

  constructor(private readonly executor: YdbExecutor) {}

  /** Создаёт таблицу учёта миграций, если её ещё нет (один раз на инстанс). */
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
    // Апгрейд таблицы старого формата (созданной до #101): колонок `hash`
    // и `state` может не быть — SELECT несуществующей колонки падает,
    // добавляем колонки. На уже обновлённых таблицах это лишний дешёвый
    // SELECT один раз на инстанс раннера.
    try {
      await executeSql(
        this.executor,
        `SELECT \`hash\`, \`state\` FROM ${quoteIdentifier(MIGRATIONS_TABLE)} LIMIT 1`,
      );
    } catch {
      await executeSql(
        this.executor,
        `ALTER TABLE ${quoteIdentifier(MIGRATIONS_TABLE)} ADD COLUMN \`hash\` Utf8`,
      );
      await executeSql(
        this.executor,
        `ALTER TABLE ${quoteIdentifier(MIGRATIONS_TABLE)} ADD COLUMN \`state\` Utf8`,
      );
    }
  }

  /** Список применённых миграций в порядке применения. */
  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    await this.ensureMigrationsTable();
    const sets = (await this.executor([
      `SELECT \`id\`, \`timestamp\`, \`name\`, \`hash\`, \`state\` FROM ${quoteIdentifier(MIGRATIONS_TABLE)}`,
    ] as unknown as TemplateStringsArray)) as Record<string, any>[][];

    return (sets[0] ?? []).map(appliedFromRow).sort(byChronology);
  }

  /**
   * Применяет все неприменённые миграции по порядку.
   * Возвращает имена выполненных миграций.
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
        // Маркер `started` остаётся: следующему запуску запрещено
        // выполнять up() заново вслепую (#101).
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
   * Откатывает последнюю применённую миграцию.
   * Возвращает её имя или null, если откатывать нечего.
   * Отказывается работать, если последняя запись в состоянии `started`
   * (прерванный up()/упавший down()) — сначала разрешите её явно через
   * markMigrationApplied()/removeMigrationRecord().
   */
  async revert(migrations: YdbMigration[]): Promise<string | null> {
    assertNoDuplicates(migrations);
    const applied = await this.getAppliedMigrations();
    if (!applied.length) return null;

    const last = applied[applied.length - 1];
    if (last.state === 'started') {
      // Прерванный up()/упавший down(): схема в неизвестном состоянии,
      // слепой повторный down() запрещён (#101).
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

    // Маркер намерения до down(): падение между down() и DELETE записи
    // оставит запись в "started" — состояние придётся разрешить явно (#101).
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

  /** Статус по всем переданным миграциям (+ orphan/interrupted записи). */
  async status(migrations: YdbMigration[]): Promise<YdbMigrationStatus[]> {
    assertNoDuplicates(migrations);
    const applied = await this.getAppliedMigrations();
    const index = buildAppliedIndex(applied);

    const statuses: YdbMigrationStatus[] = migrations.map((migration) => {
      const name = migrationName(migration);
      const match = matchAppliedRecord(index, migration);
      if (match.kind === 'pending') {
        return { name, applied: false };
      }
      return {
        name,
        applied: true,
        appliedAt: new Date(match.record.timestamp),
        interrupted: match.record.state === 'started',
      };
    });

    // Orphan-записи (#101): применены, но файла миграции уже нет.
    for (const record of applied) {
      if (recordMatchesMigration(record, migrations)) continue;
      statuses.push({
        name: record.name,
        applied: true,
        appliedAt: new Date(record.timestamp),
        orphan: true,
        interrupted: record.state === 'started',
      });
    }

    return statuses;
  }

  /**
   * Механизм восстановления (#101): явно помечает миграцию применённой.
   * Вызывается, когда схема БД приведена в целевое состояние вручную
   * после прерванного запуска.
   * Принимает объект миграции или строку (хеш либо имя).
   */
  async markMigrationApplied(target: YdbMigration | string): Promise<void> {
    const record = await this.resolveRecord(target);
    await this.finishRecord(record.id);
  }

  /**
   * Механизм восстановления (#101): удаляет запись учёта — миграция
   * считается полностью откаченной вручную. Осторожно: удаление записи
   * применённой миграции приведёт к повторному выполнению up().
   * Принимает объект миграции или строку (хеш либо имя).
   */
  async removeMigrationRecord(target: YdbMigration | string): Promise<void> {
    const record = await this.resolveRecord(target);
    await this.deleteRecord(record.id);
  }

  /** Резервирует применение миграции: INSERT с state='started'. */
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
    query.parameter('id', mapToYdb('Int64', id));
    query.parameter('timestamp', mapToYdb('Int64', Date.now()));
    query.parameter('name', mapToYdb('Utf8', name));
    query.parameter('hash', mapToYdb('Utf8', hash ?? null));
    query.parameter('state', mapToYdb('Utf8', state));
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
    query.parameter('state', mapToYdb('Utf8', state));
    query.parameter('timestamp', mapToYdb('Int64', Date.now()));
    query.parameter('id', mapToYdb('Int64', id));
    await query;
  }

  private async deleteRecord(id: number): Promise<void> {
    const query = this.executor([
      `DELETE FROM ${quoteIdentifier(MIGRATIONS_TABLE)} WHERE \`id\` = $id`,
    ] as unknown as TemplateStringsArray);
    query.parameter('id', mapToYdb('Int64', id));
    await query;
  }

  /** Находит запись учёта по объекту миграции или строке (хеш либо имя). */
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
