#!/usr/bin/env node
import { YdbMigrationRunner } from '../migrations/migration-runner.js';
import { loadMigrationsFromDir } from '../migrations/migration-loader.js';
import { planMigration } from '../migrations/migration-generator.js';
import {
  YdbSchemaSyncer,
  buildExpectedJoinTableSchema,
  buildExpectedTableSchema,
} from '../schema/schema-sync.js';
import { getManyToManyJoinTables } from '../decorators/relation.decorators.js';
import { getYdbEntityMetadata } from '../metadata/entity-metadata.js';
import { connectCli, loadCliConfig } from './config.js';
import { createEntityFile, createMigrationFile } from './generators.js';

const HELP = `ydb-orm — CLI для миграций и генерации кода

Использование:
  ydb-orm migration:create <name>     Создать пустую миграцию
  ydb-orm migration:generate <name>   Сгенерировать миграцию по diff сущностей и БД
  ydb-orm migration:run               Применить все новые миграции
  ydb-orm migration:revert            Откатить последнюю миграцию
  ydb-orm migration:show              Показать статус миграций
  ydb-orm entity:create <name>        Создать сущность

Опции:
  --config <path>   Путь к конфигу (по умолчанию ./ydb-orm.config.ts|mts|mjs|js,
                    иначе env: YDB_ENDPOINT, YDB_AUTH_TYPE,
                    YDB_AUTHORIZED_KEY_PATH)
  --dir <path>      Директория миграций (по умолчанию ./migrations)
                    или сущностей для entity:create (по умолчанию ./src)
`;

interface ParsedArgs {
  command?: string;
  positional?: string;
  config?: string;
  dir?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') result.config = argv[++i];
    else if (argv[i] === '--dir') result.dir = argv[++i];
    else rest.push(argv[i]);
  }
  [result.command, result.positional] = rest;
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
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
        const meta = getYdbEntityMetadata(entity);
        if (!meta) {
          throw new Error(
            `Class ${entity.name} is not decorated with @YdbEntity`,
          );
        }
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
      for (const warning of plan.warnings) {
        console.warn(`WARNING: ${warning}`);
      }
      console.log(`Migration generated: ${created.filePath}`);
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
        for (const s of statuses) {
          console.log(
            `${s.applied ? '[x]' : '[ ]'} ${s.name}` +
              (s.appliedAt ? ` (${s.appliedAt.toISOString()})` : ''),
          );
        }
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

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
