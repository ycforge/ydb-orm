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

/** Migration plan: DDL for up/down plus warnings about manual edits. */
export interface PlannedMigration {
  up: string[];
  down: string[];
  warnings: string[];
  /**
   * Likely column renames (#23): NOT executed and not applied automatically —
   * they are rendered as comments inside up()/down() of the generated file.
   * For each pair the corresponding ADD/DROP in up/down is suppressed:
   * applying the rename is an explicit decision.
   */
  suggestions?: string[];
}

/** Reconstructs YdbTtlMetadata from the actual TTL settings in the DB. */
function ttlMetaFromActual(actual: YdbTableTtl): YdbTtlMetadata {
  return {
    // expire_after_seconds is whole seconds; conversion via microseconds
    // (the precision of the YDB Interval) is lossless
    interval: microsecondsToIsoDuration(
      actual.expireAfterSeconds * MICROSECONDS_PER_SECOND,
    ),
    column: actual.column,
    ...(actual.unit ? { unit: actual.unit } : {}),
  };
}

/**
 * Validates planMigration inputs (#102). Arrays are matched strictly by
 * index (expected[i] <-> existing[i]) — that is part of the public contract,
 * so a length mismatch must fail with a clear error rather than silently
 * producing wrong DDL.
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
 * Pure function: builds a migration plan from expected entity schemas and the
 * current DB state (null — the table does not exist).
 * Used by `migration:generate`.
 *
 * Safety policy (#88):
 *  - missing indexes and TTL are created in up and rolled back in down;
 *  - extra indexes and TTL are not removed — only a warning;
 *  - a divergence of an existing index (unique/columns) is only diagnosed —
 *    recreating an index silently is unsafe;
 *  - PK, column types and extra columns are not changed (as before).
 *
 * Likely renames (#23): if exactly one extra DB column and one new entity
 * column match by type and do not touch PK/indexes/TTL/blind-index, the plan
 * does NOT generate ADD/DROP for that pair, and instead puts
 * `ALTER TABLE ... RENAME COLUMN ... TO ...` into suggestions (a comment in
 * the migration file). YQL does not support RENAME COLUMN yet — applying is
 * always manual. At the slightest ambiguity (several candidates, key columns
 * involved, etc.) the previous behavior applies: ADD/DROP + warning.
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
      // #89: a reordering of PK columns is also a divergence (order matters),
      // but no DDL is generated: a PK cannot be altered in YDB, manual
      // migration required.
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

    // #23: likely rename — only a hint, ADD/DROP for the pair is suppressed.
    // The extra column is still not dropped automatically.
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
        // down — in reverse order via unshift, so that up/down stay symmetric
        for (const [column] of autoAdd) {
          down.unshift(
            `ALTER TABLE ${quoteIdentifier(schema.tableName)} DROP COLUMN ${quoteIdentifier(column)}`,
          );
        }
      }
    }

    // Missing indexes: create in up, drop in down (#88).
    for (const idx of check.missingIndexes) {
      up.push(generateAddIndexYql(schema.tableName, idx));
      down.unshift(generateDropIndexYql(schema.tableName, idx.name));
    }

    // Existing index diverges from metadata — diagnose only.
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
    // Extra indexes are never dropped automatically.
    for (const extra of check.extraIndexes) {
      warnings.push(
        `Table "${schema.tableName}" has extra index "${extra.name}" — not dropped automatically`,
      );
    }

    // TTL: a missing one is set, a changed one is replaced; down restores the
    // previous DB state (reset or the old settings).
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
    // TTL that has no metadata in the entity is not reset automatically.
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
 * Renders a comment block with rename hints (#23).
 * Hints never end up as executable statements: YQL has no RENAME COLUMN,
 * applying is done manually only after verification.
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
 * Renders a migration file from a plan. If the plan is empty, up/down stay
 * empty with a comment. Rename hints are rendered as comments inside
 * up()/down(), not as executable statements (#23).
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
