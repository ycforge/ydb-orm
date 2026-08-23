/**
 * Единый workflow проверки миграций для `migration:check` и
 * `migration:status` (#24).
 *
 * Команда только ЧИТАЕТ состояние и не выполняет НИКАКОГО DDL:
 *  - существование таблицы учёта `ydb_migrations` определяется через
 *    DescribeTable (readBookkeepingSnapshot); если её нет — база считается
 *    не инициализированной («не применено ничего»), таблица НЕ создаётся;
 *  - записи читаются голым SELECT (без CREATE/ALTER, колонки легаси-таблиц
 *    учитываются без их изменения);
 *  - для сущностей из конфига — DescribeTable через YdbSchemaSyncer.verify.
 *
 * Различимые состояния и exit-коды см. в
 * migrations/migration-check.ts и cli/exit-codes.ts.
 *
 * Вывод:
 *  - текстовый режим: сводка/список — в stdout, проблемы — в stderr,
 *    итоговая строка `Up to date: ...` / `Not ready: ...` по потоку
 *    результата; цвет diff-а схемы определяется по реальному потоку
 *    вывода (stderr), не по stdout (#103);
 *  - `--json`: весь машинночитаемый отчёт — только в stdout, стабильная
 *    схема (без цвета и человеческих формулировок).
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

/** Команды, использующие этот workflow. */
export type MigrationVerifyCommand =
  'migration:check' | 'migration:show' | 'migration:status';

/** Потоки вывода команды: сводки — в stdout, проблемы — в stderr. */
export interface MigrationVerifyIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

/**
 * Потоки для решения о цвете (#103): по умолчанию реальные
 * process.stdout/process.stderr; в тестах подставляются фейки.
 */
export interface MigrationVerifyStreams {
  stdout?: { isTTY?: boolean | undefined };
  stderr?: { isTTY?: boolean | undefined };
}

export interface RunMigrationVerificationOptions {
  command: MigrationVerifyCommand;
  /** Директория миграций (--dir или из конфига). */
  migrationsDir: string;
  /**
   * Сущности из конфига CLI: если заданы, дополнительно проверяется
   * схема БД (read-only DescribeTable) — иначе состояние schema-drift
   * недоступно и в отчёте помечается как не проверявшееся.
   */
  entities?: (new (...args: any[]) => any)[] | undefined;
  /** Машинночитаемый вывод: всё в stdout, без цвета. */
  json?: boolean | undefined;
  io: MigrationVerifyIo;
  streams?: MigrationVerifyStreams | undefined;
  connect: () => Promise<{
    driver: Driver;
    executor: YdbExecutor;
    close: () => void;
  }>;
  /** Шов для тестов (по умолчанию — загрузка из директории). */
  loadMigrations?: ((dir: string) => Promise<YdbMigration[]>) | undefined;
  /**
   * Read-only чтение таблицы учёта миграций (#24): DescribeTable + голый
   * SELECT, без CREATE/ALTER. Шов для тестов.
   */
  inspectBookkeeping?:
    | ((deps: {
        driver: Driver;
        executor: YdbExecutor;
      }) => Promise<MigrationBookkeepingSnapshot>)
    | undefined;
  /** Шов для тестов (по умолчанию — YdbSchemaSyncer.verify). */
  verifySchema?:
    | ((
        driver: Driver,
        executor: YdbExecutor,
        entities: (new (...args: any[]) => any)[],
      ) => Promise<YdbSchemaIssue[]>)
    | undefined;
}

/**
 * Возвращает метаданные сущности или падает, если класс не декорирован
 * @YdbEntity (иначе syncer.verify молча пропускает такой класс).
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

/** Строка списка `migration:status` для одной миграции (маркеры #101). */
export function renderStatusLine(status: YdbMigrationStatus): string {
  if (status.orphan) {
    // Применена, но файла миграции больше нет (#101).
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
    // Прервана посреди применения/отката (#101).
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
 * Выполняет проверку и рендерит отчёт. Бросает исходную ошибку,
 * помеченную exit-кодом EXIT_COMMAND_ERROR (5): цепочка cause сохраняется.
 * Возвращает вердикт — вызывающий код ставит process.exitCode.
 *
 * Read-only контракт (#24): состояние таблицы учёта читается через
 * readBookkeepingSnapshot (DescribeTable + голый SELECT, без DDL);
 * YdbMigrationRunner.status с его ensureMigrationsTable() здесь
 * не вызывается никогда.
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
        : // Таблицы учёта ещё нет: применено не было ничего — все
          // миграции из файлов считаются ожидающими; таблица НЕ создаётся.
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

/** Полностью применённые без блокирующих состояний (legacy-семантика поля). */
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
 * Машинночитаемый отчёт (#24): стабильная схема, детерминированный порядок
 * ключей и строк, ISO-даты, булевы флаги всегда явные. Парсить нужно это,
 * а не цвет/формулировки текстового режима. Блок `bookkeeping` различает
 * «не инициализированную» базу (таблицы учёта ещё нет) от полностью
 * применённой.
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
  // Обёртки-стрелки: не отвязываем методы io от объекта (#103-стиль lint).
  const out = (line: string) => io.stdout(line);
  const err = (line: string) => io.stderr(line);

  if (!bookkeeping.exists) {
    // Свежая база: таблицы учёта ещё нет. Информация — в stdout; таблица
    // НЕ создаётся, состояние считается «не применено ничего».
    out(
      `Bookkeeping table ydb_migrations does not exist yet — ` +
        `no migrations have been applied (nothing was created).`,
    );
  }

  if (command === 'migration:check') {
    // Сводка вместо полного списка: полный список — migration:status.
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

  // Orphans уже видны в списке migration:status — отдельная секция только
  // для компактного migration:check.
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
    // Цвет решаем по stderr — куда реально уезжает diff (#103).
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
