import {
  ExpectedTableSchema,
  YdbTableDescription,
  checkTableSchema,
  generateAddColumnsYql,
  generateCreateTableYql,
} from '../schema/schema-sync.js';
import { quoteIdentifier } from '../core/sql-utils.js';

/** План миграции: DDL для up/down и предупреждения о ручных правках. */
export interface PlannedMigration {
  up: string[];
  down: string[];
  warnings: string[];
}

/**
 * Чистая функция: строит план миграции по ожидаемым схемам сущностей
 * и текущему состоянию БД (null — таблицы нет).
 * Используется `migration:generate`.
 */
export function planMigration(
  expected: ExpectedTableSchema[],
  existing: (YdbTableDescription | null)[],
): PlannedMigration {
  const up: string[] = [];
  const down: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < expected.length; i++) {
    const schema = expected[i];
    const current = existing[i];

    if (!current) {
      up.push(generateCreateTableYql(schema));
      down.unshift(`DROP TABLE ${quoteIdentifier(schema.tableName)}`);
      continue;
    }

    const check = checkTableSchema(schema, current);

    if (!check.primaryKeyMatches) {
      warnings.push(
        `Table "${schema.tableName}": primary key mismatch — YDB cannot alter it, manual migration required`,
      );
    }
    for (const mismatch of check.typeMismatches) {
      warnings.push(
        `Table "${schema.tableName}" column "${mismatch.column}": ` +
          `type mismatch (expected ${mismatch.expected}, actual ${mismatch.actual}) — ` +
          `YDB cannot alter a column type, manual migration required`,
      );
    }
    for (const extra of check.extraColumns) {
      warnings.push(
        `Table "${schema.tableName}" has extra column "${extra}" — not dropped automatically`,
      );
    }

    if (check.missingColumns.length) {
      up.push(generateAddColumnsYql(schema.tableName, check.missingColumns));
      // down — в обратном порядке через unshift, чтобы up/down были симметричны
      for (const [column] of check.missingColumns) {
        down.unshift(
          `ALTER TABLE ${quoteIdentifier(schema.tableName)} DROP COLUMN ${quoteIdentifier(column)}`,
        );
      }
    }
  }

  return { up, down, warnings };
}

/**
 * Рендерит файл миграции по плану. Если план пуст — up/down остаются
 * пустыми с комментарием.
 */
export function renderMigrationFile(
  className: string,
  migrationName: string,
  plan: PlannedMigration,
): string {
  const statements = (list: string[], indent: string) =>
    list
      .map(
        (sql) => `${indent}await executeSql(executor, ${JSON.stringify(sql)});`,
      )
      .join('\n');

  const warnings =
    plan.warnings.length === 0
      ? ''
      : plan.warnings.map((w) => ` * WARNING: ${w}`).join('\n') + '\n';

  return `import type { YdbMigration, YdbExecutor } from '@ycforge/ydb-orm';
import { executeSql } from '@ycforge/ydb-orm';

/**
 * Migration: ${migrationName}
${warnings} */
export class ${className} implements YdbMigration {
  readonly name = ${JSON.stringify(migrationName)};

  async up(executor: YdbExecutor): Promise<void> {
${
  plan.up.length
    ? statements(plan.up, '    ')
    : '    // no statements — fill in manually'
}
  }

  async down(executor: YdbExecutor): Promise<void> {
${
  plan.down.length
    ? statements(plan.down, '    ')
    : '    // no statements — fill in manually'
}
  }
}
`;
}
