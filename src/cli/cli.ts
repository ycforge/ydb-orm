#!/usr/bin/env node
import { YdbMigrationRunner } from '../migrations/migration-runner.js';
import { loadMigrationsFromDir } from '../migrations/migration-loader.js';
import { planMigration } from '../migrations/migration-generator.js';
import {
  YdbSchemaSyncer,
  buildExpectedJoinTableSchema,
  buildExpectedTableSchema,
  diffSchemas,
} from '../schema/schema-sync.js';
import { getManyToManyJoinTables } from '../decorators/relation.decorators.js';
import { migrationStateExitCode } from '../migrations/migration-check.js';
import {
  runMigrationVerification,
  requireEntityMeta,
} from './migration-verify.js';
import {
  exitCodeOf,
  DEFAULT_EXIT_CODE,
  EXIT_COMMAND_ERROR,
} from './exit-codes.js';
import { connectCli, loadCliConfig } from './config.js';
import { createMigrationFile } from './generators.js';
import { runEntityCreateCommand } from './entity-wizard.js';
import { renderCompletionScript } from './completion.js';
import { renderSchemaDiff } from './diff.js';
import { buildMetadataDump } from './metadata-dump.js';
import { buildEntityDiagram, writeDiagramFile } from './entity-diagram.js';
import { CliArgsError, formatError, parseArgs, CliArgs } from './args.js';

const HELP = `ydb-orm — CLI для миграций и генерации кода

Использование:
  ydb-orm migration:create <name>     Создать пустую миграцию
  ydb-orm migration:generate <name>   Сгенерировать миграцию по diff сущностей и БД
  ydb-orm migration:run               Применить все новые миграции
  ydb-orm migration:revert            Откатить последнюю миграцию
  ydb-orm migration:show              Показать статус миграций (алиас migration:status)
  ydb-orm migration:status            То же, что migration:show (#152)
  ydb-orm migration:check             Проверка готовности схемы для CI (exit != 0, если не готово)
  ydb-orm migration:repair <name>     Разрешить прерванную миграцию вручную (--as-applied | --as-reverted)
  ydb-orm schema:verify               Проверить схему БД против метаданных сущностей
  ydb-orm metadata:dump               Экспортировать метаданные сущностей в JSON (stdout;
                                      без БД: детерминированный, версионированный формат)
  ydb-orm entity:diagram              Mermaid ER-диаграмма по метаданным сущностей
                                      (stdout или --output <file>; без БД; существующие
                                      файлы не перезаписываются)
  ydb-orm entity:create <name>        Создать сущность (в TTY — интерактивный мастер колонок:
                                      имя → тип YDB → PK/encrypted/enum/date/TTL; вне TTY — шаблон
                                      по умолчанию без чтения stdin; существующие файлы не перезаписываются)
  ydb-orm completion <bash|zsh|fish>  Скрипт shell-автодополнения (в stdout)

Опции:
  --config <path>   Путь к конфигу (ищется в CWD и выше:
                    ydb-orm.config.ts|mts|mjs|js, иначе env: YDB_ENDPOINT)
  --dir <path>      Директория миграций (по умолчанию ./migrations)
                    или сущностей для entity:create (по умолчанию ./src)
  --output <file>   Файл вывода для entity:diagram (существующий файл —
                    ошибка, перезапись запрещена); без флага — stdout
  --json            JSON-вывод (для migration:show/status/check) — весь отчёт в stdout
  --verbose         Полный стек ошибки и цепочка cause при сбое
  -h, --help        Эта справка

Exit-коды migration:check / migration:status / migration:show (#152):
  0  готово: все миграции применены; схема совпадает, если проверялась
     (проверяется, когда в конфиге задан массив entities)
  1  есть неприменённые миграции (pending)
  2  есть прерванные миграции (state='started', #101)
  3  схема БД расходится с метаданными сущностей
  4  содержимое применённой миграции изменилось (#101)
  5  ошибка выполнения команды (подключение, конфиг, неожиданный сбой)
Команда только читает состояние БД — миграции и схему она не меняет:
никакого CREATE/ALTER таблицы учёта. Если ydb_migrations ещё нет,
считается, что не применено ничего (файлы есть → pending/1, файлов нет → 0);
в --json это различается полем bookkeeping.exists.
Для машинного разбора используйте --json (поля ready/state/states/exitCode),
а не цвет или формулировки текстового вывода.

Остальные команды: 0 — успех/help, 1 — ошибка.
Неизвестные флаги и пустые значения опций считаются ошибкой (#103).
`;

/** Readiness-check commands: any of their failures is exit 5 (#152). */
const MIGRATION_VERIFY_COMMANDS = new Set([
  'migration:check',
  'migration:show',
  'migration:status',
]);

async function main(): Promise<void> {
  let args: CliArgs = {};
  try {
    args = parseArgs(process.argv.slice(2));
    await runCommand(args);
  } catch (error) {
    // The exit code may carry a source marker (#152): for the verification
    // commands any execution failure (config, connection, unexpected crash)
    // is the dedicated code 5; the other commands keep the old 1.
    const code = exitCodeOf(error);
    process.exitCode =
      code === DEFAULT_EXIT_CODE &&
      args.command !== undefined &&
      MIGRATION_VERIFY_COMMANDS.has(args.command)
        ? EXIT_COMMAND_ERROR
        : code;
    const verbose = args.verbose === true;
    console.error(
      formatError(error, {
        verbose,
        // Useful environment diagnostics when verbose (#103).
        context: [
          `cwd: ${process.cwd()}`,
          `argv: ${JSON.stringify(process.argv.slice(2))}`,
          `node: ${process.version}`,
        ],
      }),
    );
    if (!verbose && !(error instanceof CliArgsError)) {
      console.error('\nRun with --verbose for the full stack trace.');
    }
  }
}

async function runCommand(args: CliArgs): Promise<void> {
  const command = args.command;

  if (!command || args.help) {
    console.log(HELP);
    return;
  }

  if (command === 'completion') {
    try {
      console.log(renderCompletionScript(args.positional ?? ''));
    } catch (error) {
      console.error(formatError(error));
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'entity:create') {
    requireName(command, args.positional);
    const dir = args.dir ?? './src';
    try {
      await runEntityCreateCommand(args.positional as string, { dir });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'PromptCancelledError' &&
        process.exitCode === 130
      ) {
        // Input cancelled (EOF/Ctrl+C/Ctrl+D) — clean exit without writing a
        // file: the message is already printed, no stack trace needed.
        return;
      }
      throw error;
    }
    return;
  }

  if (command === 'migration:create') {
    requireName(command, args.positional);
    const dir = args.dir ?? './migrations';
    const created = createMigrationFile(dir, args.positional as string);
    console.log(`Migration created: ${created.filePath}`);
    return;
  }

  const config = await loadCliConfig(args.config);
  const migrationsDir = args.dir ?? config.migrationsDir ?? './migrations';

  if (command === 'migration:generate') {
    requireName(command, args.positional);
    if (!config.entities?.length) {
      throw new Error(
        'migration:generate requires "entities" in the CLI config ' +
          '(ydb-orm.config.ts).',
      );
    }
    const { driver, executor, close } = await connectCli(config);
    try {
      const syncer = new YdbSchemaSyncer(driver, executor);
      const expected = config.entities.map((entity) =>
        buildExpectedTableSchema(requireEntityMeta(entity)),
      );
      for (const joinTable of getManyToManyJoinTables(config.entities)) {
        expected.push(buildExpectedJoinTableSchema(joinTable));
      }
      const existing = await Promise.all(
        expected.map((schema) => syncer.describeTable(schema.tableName)),
      );
      const plan = planMigration(expected, existing);
      if (!plan.up.length && !plan.warnings.length) {
        console.log('No schema changes detected');
        return;
      }
      const created = createMigrationFile(
        migrationsDir,
        args.positional as string,
        plan,
      );
      // Summary of the discrepancies that landed in the migration (plus the
      // remaining warnings).
      const issues = diffSchemas(expected, existing);
      if (issues.length) {
        console.log('Schema diff (entity vs database):');
        console.log(renderSchemaDiff(issues));
      }
      for (const warning of plan.warnings) {
        console.warn(`WARNING: ${warning}`);
      }
      console.log(`Migration generated: ${created.filePath}`);
    } finally {
      close();
    }
    return;
  }

  if (command === 'schema:verify') {
    if (!config.entities?.length) {
      throw new Error(
        'schema:verify requires "entities" in the CLI config (ydb-orm.config.ts).',
      );
    }
    const { driver, executor, close } = await connectCli(config);
    try {
      // Check decorators up front: syncer.verify silently skips
      // undecorated classes
      for (const entity of config.entities) {
        requireEntityMeta(entity);
      }
      const syncer = new YdbSchemaSyncer(driver, executor);
      const issues = await syncer.verify(config.entities);
      if (issues.length === 0) {
        console.log('Schema OK — no issues found');
      } else {
        console.error(`Found ${issues.length} schema issue(s):`);
        // Discrepancies are written to stderr — color is decided by stderr,
        // not by stdout (#103): with `ydb-orm schema:verify 2>issues.txt`
        // ANSI codes must not leak into the redirected file, and with
        // `... | cat` they must not be lost if stderr stays a TTY.
        console.error(renderSchemaDiff(issues, { stream: process.stderr }));
        process.exitCode = 1;
      }
    } finally {
      close();
    }
    return;
  }

  if (command === 'metadata:dump') {
    // Read-only metadata export (#37): the DB is not touched at all — no
    // driver, no executor; the config is needed only for the entities list.
    if (!config.entities?.length) {
      throw new Error(
        'metadata:dump requires "entities" in the CLI config ' +
          '(ydb-orm.config.ts).',
      );
    }
    const dump = buildMetadataDump(config.entities);
    // The command is JSON-only by nature: the single output mode is the whole
    // dump to stdout, deterministic (stable order and structure).
    console.log(JSON.stringify(dump, null, 2));
    return;
  }

  if (command === 'entity:diagram') {
    // Read-only Mermaid ER diagram (#36): the same canonical source as
    // metadata:dump (#37); the DB is not touched at all. All validation
    // and building happen before the first byte of output/file write.
    if (!config.entities?.length) {
      throw new Error(
        'entity:diagram requires "entities" in the CLI config ' +
          '(ydb-orm.config.ts).',
      );
    }
    const diagram = buildEntityDiagram(config.entities);
    if (args.output !== undefined) {
      writeDiagramFile(args.output, diagram);
      console.log(`Diagram written: ${args.output}`);
    } else {
      console.log(diagram);
    }
    return;
  }

  if (command === 'migration:repair') {
    // Recovery after an interrupted migration (#101): the ydb_migrations
    // record is stuck in "started" state and blocks migration:run.
    requireName(command, args.positional);
    if (!args.asApplied && !args.asReverted) {
      throw new Error(
        'migration:repair requires --as-applied ' +
          '(schema changes were completed manually) or --as-reverted ' +
          '(schema changes were rolled back manually).',
      );
    }
    const { driver, executor, close } = await connectCli(config);
    try {
      const runner = new YdbMigrationRunner(executor, driver);
      const target = args.positional as string;
      if (args.asApplied) {
        await runner.markMigrationApplied(target);
        console.log(`Marked as applied: ${target}`);
      } else {
        await runner.removeMigrationRecord(target);
        console.log(`Removed bookkeeping record: ${target}`);
      }
    } finally {
      close();
    }
    return;
  }

  if (command === 'migration:run' || command === 'migration:revert') {
    const { driver, executor, close } = await connectCli(config);
    try {
      const runner = new YdbMigrationRunner(executor, driver);
      const migrations = await loadMigrationsFromDir(migrationsDir);

      if (command === 'migration:run') {
        const executed = await runner.run(migrations);
        if (!executed.length) {
          console.log('No pending migrations');
        }
        for (const name of executed) {
          console.log(`Applied: ${name}`);
        }
      } else {
        const reverted = await runner.revert(migrations);
        console.log(reverted ? `Reverted: ${reverted}` : 'Nothing to revert');
      }
    } finally {
      close();
    }
    return;
  }

  if (
    command === 'migration:check' ||
    command === 'migration:show' ||
    command === 'migration:status'
  ) {
    // A single read-only verification workflow (#152): states and exit codes
    // are documented in migrations/migration-check.ts. Migrations and the
    // schema are never modified.
    const verdict = await runMigrationVerification({
      command,
      migrationsDir,
      entities: config.entities,
      json: args.json === true,
      io: { stdout: console.log, stderr: console.error },
      connect: () => connectCli(config),
    });
    process.exitCode = migrationStateExitCode(verdict.state);
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(HELP);
  process.exitCode = 1;
}

function requireName(command: string, name?: string): void {
  if (!name) {
    throw new Error(`${command} requires a name argument`);
  }
}

main();
