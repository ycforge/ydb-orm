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
import { createEntityFile, createMigrationFile } from './generators.js';
import { renderCompletionScript } from './completion.js';
import { renderSchemaDiff } from './diff.js';
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
  ydb-orm entity:create <name>        Создать сущность
  ydb-orm completion <bash|zsh|fish>  Скрипт shell-автодополнения (в stdout)

Опции:
  --config <path>   Путь к конфигу (ищется в CWD и выше:
                    ydb-orm.config.ts|mts|mjs|js, иначе env: YDB_ENDPOINT,
                    YDB_AUTH_TYPE, YDB_AUTHORIZED_KEY_PATH)
  --dir <path>      Директория миграций (по умолчанию ./migrations)
                    или сущностей для entity:create (по умолчанию ./src)
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

/** Команды проверки готовности: любые их сбои — exit 5 (#152). */
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
    // Exit-код может быть помечен источником (#152): у команд проверки
    // любая ошибка выполнения (конфиг, подключение, неожиданный сбой) —
    // отдельный код 5; остальные команды — прежний 1.
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
        // Полезная диагностика окружения при verbose (#103).
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
    const created = createEntityFile(dir, args.positional as string);
    console.log(`Entity created: ${created.filePath}`);
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
      const expected = config.entities.flatMap((entity) => {
        const meta = requireEntityMeta(entity);
        const schemas = [buildExpectedTableSchema(meta)];
        return schemas;
      });
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
      // Сводка расхождений, попавших в миграцию (и оставшихся warnings).
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
      // Проверяем декораторы заранее: syncer.verify молча пропускает
      // недекорированные классы
      for (const entity of config.entities) {
        requireEntityMeta(entity);
      }
      const syncer = new YdbSchemaSyncer(driver, executor);
      const issues = await syncer.verify(config.entities);
      if (issues.length === 0) {
        console.log('Schema OK — no issues found');
      } else {
        console.error(`Found ${issues.length} schema issue(s):`);
        // Расхождения пишутся в stderr — цвет решаем по stderr, а не по
        // stdout (#103): при `ydb-orm schema:verify 2>issues.txt` ANSI-коды
        // не должны уезжать в перенаправленный файл, а при
        // `... | cat` — теряться, если stderr остался TTY.
        console.error(renderSchemaDiff(issues, { stream: process.stderr }));
        process.exitCode = 1;
      }
    } finally {
      close();
    }
    return;
  }

  if (command === 'migration:repair') {
    // Восстановление после прерванной миграции (#101): запись в
    // ydb_migrations осталась в состоянии "started" и блокирует migration:run.
    requireName(command, args.positional);
    if (!args.asApplied && !args.asReverted) {
      throw new Error(
        'migration:repair requires --as-applied ' +
          '(schema changes were completed manually) or --as-reverted ' +
          '(schema changes were rolled back manually).',
      );
    }
    const { executor, close } = await connectCli(config);
    try {
      const runner = new YdbMigrationRunner(executor);
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
    const { executor, close } = await connectCli(config);
    try {
      const runner = new YdbMigrationRunner(executor);
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
    // Единый read-only workflow проверки (#152): состояния и exit-коды
    // см. migrations/migration-check.ts. Миграции и схема не меняются.
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
