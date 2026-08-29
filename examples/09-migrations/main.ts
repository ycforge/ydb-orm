/**
 * Пример 09: миграции.
 *
 * Два способа:
 *  1) CLI: `yarn build && yarn ydb-orm migration:run` — использует
 *     ydb-orm.config.ts из этого каталога (см. README);
 *  2) Программный API (показан ниже): loadMigrationsFromDir + runner.
 *
 * Программный сценарий:
 *  - run() применяет пока ещё не применённые миграции по порядку имён;
 *  - выполнение учитывается в таблице `ydb_migrations`;
 *  - повторный run() ничего не делает (миграции уже применены);
 *  - revert() откатывает последнюю применённую;
 *  - статус: pending/applied/interrupted.
 */
import { fileURLToPath } from 'node:url';
import {
  createDriver,
  createExecutor,
  loadMigrationsFromDir,
  mapToYdb,
  YdbMigrationRunner,
} from '../../src/index.js';
import { buildYdbOptions } from '../shared/options.js';

async function main(): Promise<void> {
  const dbOptions = buildYdbOptions();
  const driver = await createDriver(dbOptions);
  try {
    const executor = createExecutor(driver, dbOptions);
    const runner = new YdbMigrationRunner(executor, driver);

    // Миграции лежат рядом с этим файлом: <timestamp>-<Name>.ts
    const migrationsDir = fileURLToPath(
      new URL('./migrations/', import.meta.url),
    );
    const migrations = await loadMigrationsFromDir(migrationsDir);
    console.log(
      'Загружены миграции:',
      migrations.map((m) => m.name),
    );

    // --- Статус до применения ---
    const statusBefore = await runner.status(migrations);
    console.log(
      'Статус до run:',
      statusBefore.map(
        (s) => `${s.name} -> ${s.applied ? 'applied' : 'pending'}`,
      ),
    );

    // --- Применяем всё ---
    const executed = await runner.run(migrations);
    console.log('Применены:', executed);

    // --- Доказательство: таблица создана, колонка note на месте ---
    await executor`
      INSERT INTO demo_items (\`id\`, \`title\`, \`note\`)
      VALUES ($id, $title, $note)
    `
      .parameter('id', mapToYdb('Int64', 1n, 'id'))
      .parameter('title', mapToYdb('Utf8', 'демо-запись', 'title'))
      .parameter(
        'note',
        mapToYdb('Utf8', 'добавлено второй миграцией', 'note'),
      );
    const rows = (await executor`
      SELECT \`title\`, \`note\` FROM demo_items WHERE \`id\` = $id
    `.parameter('id', mapToYdb('Int64', 1n, 'id'))) as Record<string, any>[][];
    console.log('Строка в таблице:', rows[0]?.[0]);

    // --- Повторный run ничего не применяет ---
    const second = await runner.run(migrations);
    console.log(
      'Повторный run применил:',
      second.length === 0 ? 'ничего' : second,
    );

    // --- Статус после ---
    const statusAfter = await runner.status(migrations);
    console.log(
      'Статус после run:',
      statusAfter.map(
        (s) => `${s.name} -> ${s.applied ? 'applied' : 'pending'}`,
      ),
    );

    // --- Откат последней миграции ---
    const reverted = await runner.revert(migrations);
    console.log('Откачена:', reverted);

    // --- И восстанавливаем схему снова (для повторных запусков примера) ---
    await runner.run(migrations);
    console.log('Схема восстановлена повторным run()');
  } finally {
    driver.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
