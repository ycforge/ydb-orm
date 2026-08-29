/**
 * Миграция 02: добавляет колонку `note` в таблицу `demo_items`.
 * Демонстрирует ALTER TABLE ADD COLUMN. YDB не умеет менять тип колонки
 * или ключ — такие изменения делаются новой миграцией с пересозданием
 * таблицы и копированием данных.
 */
import { executeSql } from '../../../src/index.js';
import type { YdbMigration, YdbExecutor } from '../../../src/index.js';

export default class AddNoteToDemoItems implements YdbMigration {
  async up(executor: YdbExecutor): Promise<void> {
    await executeSql(executor, 'ALTER TABLE demo_items ADD COLUMN `note` Utf8');
  }

  async down(executor: YdbExecutor): Promise<void> {
    await executeSql(executor, 'ALTER TABLE demo_items DROP COLUMN `note`');
  }
}
