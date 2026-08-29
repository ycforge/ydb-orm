/**
 * Миграция 01: создание таблицы `demo_items`.
 *
 * Имя файла `<timestamp>-<Name>` задаёт порядок выполнения. Программный
 * runner (main.ts) применяет миграции в порядке имён; идентичность —
 * SHA-256 содержимого файла, поэтому переименование файла не вызывает
 * повторного применения.
 */
import { executeSql } from '../../../src/index.js';
import type { YdbMigration, YdbExecutor } from '../../../src/index.js';

export default class CreateDemoItems implements YdbMigration {
  async up(executor: YdbExecutor): Promise<void> {
    await executeSql(
      executor,
      `CREATE TABLE demo_items (
        \`id\` Int64,
        \`title\` Utf8,
        PRIMARY KEY (\`id\`)
      )`,
    );
  }

  async down(executor: YdbExecutor): Promise<void> {
    await executeSql(executor, 'DROP TABLE demo_items');
  }
}
