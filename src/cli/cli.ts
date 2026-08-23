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
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { connectCli, loadCliConfig } from './config.js';
import { createMigrationFile } from './generators.js';
import { runEntityCreateCommand } from './entity-wizard.js';
import { renderCompletionScript } from './completion.js';
import { renderSchemaDiff } from './diff.js';
import { CliArgsError, formatError, parseArgs, CliArgs } from './args.js';

const HELP = `ydb-orm — CLI для миграций и генерации кода

Использование:
  ydb-orm migration:create <name>     Создать пустую миграцию
  ydb-orm migration:generate <name>   Сгенерировать миграцию по diff сущностей и БД
  ydb-orm migration:run               Применить все новые миграции
  ydb-orm migration:revert            Откатить последнюю миграцию
  ydb-orm migration:show              Показать статус миграций
  ydb-orm migration:check             Проверить, все ли миграции применены (exit 1 если нет)
  ydb-orm migration:repair <name>     Разрешить прерванную миграцию вручную (--as-applied | --as-reverted)
  ydb-orm schema:verify               Проверить схему БД против метаданных сущностей
  ydb-orm entity:create <name>        Создать сущность (в TTY — интерактивный мастер колонок:
                                      имя → тип YDB → PK/encrypted/enum/date/TTL; вне TTY — шаблон
                                      по умолчанию без чтения stdin; существующие файлы не перезаписываются)
  ydb-orm completion <bash|zsh|fish>  Скрипт shell-автодополнения (в stdout)

Опции:
  --config <path>   Путь к конфигу (ищется в CWD и выше:
                    ydb-orm.config.ts|mts|mjs|js, иначе env: YDB_ENDPOINT,
                    YDB_AUTH_TYPE, YDB_AUTHORIZED_KEY_PATH)
  --dir <path>      Директория миграций (по умолчанию ./migrations)
                    или сущностей для entity:create (по умолчанию ./src)
  --json            JSON-вывод (для migration:show и migration:check)
  --verbose         Полный стек ошибки и цепочка cause при сбое
  -h, --help        Эта справка

Неизвестные флаги и пустые значения опций считаются ошибкой (#103).
`;

async function main(): Promise<void> {
  let args: CliArgs = {};
  try {
    args = parseArgs(process.argv.slice(2));
    await runCommand(args);
  } catch (error) {
    process.exitCode = 1;
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
    try {
      await runEntityCreateCommand(args.positional as string, { dir });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'PromptCancelledError' &&
        process.exitCode === 130
      ) {
        // Отмена ввода (EOF/Ctrl+C/Ctrl+D) — чистый выход без записи файла:
        // сообщение уже напечатано, стек не нужен.
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

  if (
    command === 'migration:run' ||
    command === 'migration:revert' ||
    command === 'migration:show'
  ) {
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
      } else if (command === 'migration:revert') {
        const reverted = await runner.revert(migrations);
        console.log(reverted ? `Reverted: ${reverted}` : 'Nothing to revert');
      } else {
        const statuses = await runner.status(migrations);
        if (args.json) {
          const json = statuses.map((s) => ({
            name: s.name,
            applied: s.applied,
            appliedAt: s.appliedAt ? s.appliedAt.toISOString() : null,
            ...(s.interrupted ? { interrupted: true } : {}),
            ...(s.orphan ? { orphan: true } : {}),
          }));
          console.log(JSON.stringify(json, null, 2));
        } else {
          for (const s of statuses) {
            if (s.orphan) {
              // Применена, но файла миграции больше нет (#101)
              console.log(
                `[!] ${s.name} — orphan record (no matching migration file)` +
                  (s.interrupted ? ' [interrupted]' : ''),
              );
              continue;
            }
            if (s.applied && s.interrupted) {
              // Прервана посреди применения/отката (#101)
              console.log(
                `[~] ${s.name} — interrupted, resolve via migration:repair`,
              );
              continue;
            }
            console.log(
              `${s.applied ? '[x]' : '[ ]'} ${s.name}` +
                (s.appliedAt ? ` (${s.appliedAt.toISOString()})` : ''),
            );
          }
        }
      }
    } finally {
      close();
    }
    return;
  }

  if (command === 'migration:check') {
    const { executor, close } = await connectCli(config);
    try {
      const runner = new YdbMigrationRunner(executor);
      const migrations = await loadMigrationsFromDir(migrationsDir);
      const statuses = await runner.status(migrations);
      const pending = statuses.filter((s) => !s.applied);

      if (args.json) {
        const result = {
          applied: pending.length === 0,
          pending: pending.map((s) => s.name),
          total: statuses.length,
        };
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (pending.length === 0) {
          console.log('All migrations applied');
        } else {
          console.error(
            `Pending migrations (${pending.length}/${statuses.length}):`,
          );
          for (const s of pending) {
            console.error(`  - ${s.name}`);
          }
        }
      }

      if (pending.length > 0) {
        process.exitCode = 1;
      }
    } finally {
      close();
    }
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

/**
 * Возвращает метаданные сущности или падает, если класс
 * не декорирован @YdbEntity (иначе он молча пропускается).
 */
function requireEntityMeta(entity: any) {
  const meta = getYdbEntityMetadata(entity);
  if (!meta) {
    throw new Error(`Class ${entity.name} is not decorated with @YdbEntity`);
  }
  return meta;
}

main();
