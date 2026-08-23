import {
  ExpectedTableSchema,
  YdbTableDescription,
  YdbTableTtl,
  checkTableSchema,
  describePrimaryKeyMismatch,
  generateAddColumnsYql,
  generateAddIndexYql,
  generateCreateTableYql,
  generateDropIndexYql,
  generateResetTtlYql,
  generateSetTtlYql,
} from '../schema/schema-sync.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import {
  microsecondsToIsoDuration,
  MICROSECONDS_PER_SECOND,
  YdbTtlMetadata,
} from '../decorators/ttl.decorator.js';

/** План миграции: DDL для up/down и предупреждения о ручных правках. */
export interface PlannedMigration {
  up: string[];
  down: string[];
  warnings: string[];
  /**
   * Предположения о переименовании колонок (#23): НЕ выполняются и не
   * применяются автоматически — рендерятся комментариями внутри up()/down()
   * сгенерированного файла. Для каждой пары соответствующие ADD/DROP
   * в up/down подавляются: применение переименования — явное решение.
   */
  suggestions?: string[];
}

/** Восстанавливает YdbTtlMetadata из фактических настроек TTL в БД. */
function ttlMetaFromActual(actual: YdbTableTtl): YdbTtlMetadata {
  return {
    // expire_after_seconds — целые секунды; конвертация через микросекунды
    // (точность YDB Interval) без потерь
    interval: microsecondsToIsoDuration(
      actual.expireAfterSeconds * MICROSECONDS_PER_SECOND,
    ),
    column: actual.column,
    ...(actual.unit ? { unit: actual.unit } : {}),
  };
}

/**
 * Валидирует входы planMigration (#102). Массивы сопоставляются строго
 * по индексу (expected[i] ↔ existing[i]) — это часть публичного контракта,
 * поэтому расхождение длин должно падать с понятной ошибкой, а не молча
 * порождать неверный DDL.
 */
function validatePlanInputs(
  expected: ExpectedTableSchema[],
  existing: (YdbTableDescription | null)[],
): void {
  if (!Array.isArray(expected)) {
    throw new TypeError(
      'planMigration: "expected" must be an array of ExpectedTableSchema',
    );
  }
  if (!Array.isArray(existing)) {
    throw new TypeError(
      'planMigration: "existing" must be an array of YdbTableDescription or null',
    );
  }
  if (expected.length !== existing.length) {
    const expectedTables = expected
      .map((schema) => schema?.tableName)
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `planMigration: "expected" (${expected.length}) and "existing" ` +
        `(${existing.length}) must have the same length — entries are matched ` +
        `positionally (expected[i] <-> existing[i])` +
        (expectedTables ? `; expected tables: ${expectedTables}` : ''),
    );
  }
}

/**
 * Чистая функция: строит план миграции по ожидаемым схемам сущностей
 * и текущему состоянию БД (null — таблицы нет).
 * Используется `migration:generate`.
 *
 * Политика безопасности (#88):
 *  - отсутствующие индексы и TTL создаются в up и откатываются в down;
 *  - лишние индексы и TTL не удаляются — только предупреждение;
 *  - расхождение существующего индекса (unique/колонки) только
 *    диагностируется — пересоздание индекса небезопасно делать молча;
 *  - PK, типы колонок и лишние колонки не меняются (как раньше).
 *
 * Вероятные переименования (#23): если ровно одна лишняя колонка БД и одна
 * новая колонка сущности совпадают по типу и не затрагивают PK/индексы/TTL/
 * blind-index, план НЕ генерирует для этой пары ADD/DROP, а кладёт
 * `ALTER TABLE ... RENAME COLUMN ... TO ...` в suggestions (комментарий
 * в файле миграции). YQL пока не поддерживает RENAME COLUMN — применение
 * всегда ручное. При малейшей неоднозначности (несколько кандидатов,
 * участие ключевых колонок и т.п.) поведение прежнее: ADD/DROP + warning.
 */
export function planMigration(
  expected: ExpectedTableSchema[],
  existing: (YdbTableDescription | null)[],
): PlannedMigration {
  validatePlanInputs(expected, existing);

  const up: string[] = [];
  const down: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

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
      // #89: перестановка PK-колонок — тоже расхождение (порядок значим),
      // но DDL не генерируем: PK в YDB не меняется, только ручная миграция.
      warnings.push(
        `Table "${schema.tableName}": ${describePrimaryKeyMismatch(check)} — ` +
          `YDB cannot alter a primary key, manual migration required`,
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

    // #23: вероятное переименование — только подсказка, ADD/DROP для пары
    // подавляются. Лишняя колонка по-прежнему не удаляется автоматически.
    const renamedTargets = new Set(
      check.likelyRenames.map((rename) => rename.to),
    );
    for (const rename of check.likelyRenames) {
      suggestions.push(
        `ALTER TABLE ${quoteIdentifier(schema.tableName)} RENAME COLUMN ` +
          `${quoteIdentifier(rename.from)} TO ${quoteIdentifier(rename.to)}`,
      );
      warnings.push(
        `Table "${schema.tableName}" column "${rename.from}" may have been renamed ` +
          `to "${rename.to}" — ADD/DROP suppressed for this pair, ` +
          `see SUGGESTION in the generated migration`,
      );
    }

    if (check.missingColumns.length) {
      const autoAdd = check.missingColumns.filter(
        ([column]) => !renamedTargets.has(column),
      );
      if (autoAdd.length) {
        up.push(generateAddColumnsYql(schema.tableName, autoAdd));
        // down — в обратном порядке через unshift, чтобы up/down были симметричны
        for (const [column] of autoAdd) {
          down.unshift(
            `ALTER TABLE ${quoteIdentifier(schema.tableName)} DROP COLUMN ${quoteIdentifier(column)}`,
          );
        }
      }
    }

    // Отсутствующие индексы: создаём в up, удаляем в down (#88).
    for (const idx of check.missingIndexes) {
      up.push(generateAddIndexYql(schema.tableName, idx));
      down.unshift(generateDropIndexYql(schema.tableName, idx.name));
    }

    // Существующий индекс расходится с метаданными — только диагностируем.
    for (const mismatch of check.uniqueMismatches) {
      warnings.push(
        `Table "${schema.tableName}" index "${mismatch.name}": ` +
          `unique flag mismatch (expected ${mismatch.expected}, actual ${mismatch.actual}) — ` +
          `recreate the index manually if needed`,
      );
    }
    for (const mismatch of check.indexColumnsMismatches) {
      warnings.push(
        `Table "${schema.tableName}" index "${mismatch.name}": ` +
          `columns mismatch (expected [${mismatch.expected.join(', ')}], ` +
          `actual [${mismatch.actual.join(', ')}]) — ` +
          `recreate the index manually if needed`,
      );
    }
    // Лишние индексы никогда не удаляем автоматически.
    for (const extra of check.extraIndexes) {
      warnings.push(
        `Table "${schema.tableName}" has extra index "${extra.name}" — not dropped automatically`,
      );
    }

    // TTL: отсутствующий ставим, изменённый заменяем; down восстанавливает
    // прежнее состояние БД (сброс или старые настройки).
    if (check.missingTtl.length && check.missingTtl[0].expected) {
      up.push(
        generateSetTtlYql(schema.tableName, check.missingTtl[0].expected),
      );
      down.unshift(generateResetTtlYql(schema.tableName));
    }
    if (check.ttlMismatches.length && check.ttlMismatches[0].expected) {
      up.push(
        generateSetTtlYql(schema.tableName, check.ttlMismatches[0].expected),
      );
      down.unshift(
        generateSetTtlYql(
          schema.tableName,
          ttlMetaFromActual(check.ttlMismatches[0].actual),
        ),
      );
    }
    // TTL без метаданных в сущности не сбрасываем автоматически.
    for (const extra of check.extraTtl) {
      warnings.push(
        `Table "${schema.tableName}" has extra TTL on column "${extra.actual.column}" ` +
          `— not reset automatically`,
      );
    }
  }

  return { up, down, warnings, suggestions };
}

/**
 * Рендерит блок комментариев с подсказками о переименовании (#23).
 * Подсказки никогда не попадают в исполняемые statements: YQL не
 * поддерживает RENAME COLUMN, применение — только вручную после проверки.
 */
function renderSuggestionsBlock(
  suggestions: string[] | undefined,
  indent: string,
): string | null {
  if (!suggestions?.length) return null;
  return [
    `${indent}// SUGGESTION (not applied automatically): possible column rename detected.`,
    `${indent}// YQL has no ALTER TABLE RENAME COLUMN yet — verify the data and migrate manually:`,
    ...suggestions.map((sql) => `${indent}//   ${sql};`),
  ].join('\n');
}

/**
 * Рендерит файл миграции по плану. Если план пуст — up/down остаются
 * пустыми с комментарием. Подсказки о переименовании рендерятся
 * комментариями внутри up()/down(), а не исполняемыми statements (#23).
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

  const body = (stmts: string[], indent: string): string => {
    const suggestionComment = renderSuggestionsBlock(plan.suggestions, indent);
    const parts: string[] = [];
    if (suggestionComment) {
      parts.push(suggestionComment);
    } else if (stmts.length === 0) {
      parts.push(`${indent}// no statements — fill in manually`);
    }
    if (stmts.length) parts.push(statements(stmts, indent));
    return parts.join('\n');
  };

  return `import type { YdbMigration, YdbExecutor } from '@ycforge/ydb-orm';
import { executeSql } from '@ycforge/ydb-orm';

/**
 * Migration: ${migrationName}
${warnings} */
export class ${className} implements YdbMigration {
  readonly name = ${JSON.stringify(migrationName)};

  async up(executor: YdbExecutor): Promise<void> {
${body(plan.up, '    ')}
  }

  async down(executor: YdbExecutor): Promise<void> {
${body(plan.down, '    ')}
  }
}
`;
}
