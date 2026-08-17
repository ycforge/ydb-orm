import { Logger } from '@nestjs/common';
import { Driver } from '@ydbjs/core';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import {
  TableServiceDefinition,
  CreateSessionResultSchema,
  DescribeTableResultSchema,
} from '@ydbjs/api/table';
import { StatusIds_StatusCode, IssueMessage } from '@ydbjs/api/operation';
import { Type, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { YdbPrimitive } from '../core/types.js';
import { YdbExecutor } from '../core/interfaces.js';
import { quoteIdentifier } from '../core/sql-utils.js';
import {
  getYdbEntityMetadata,
  YdbEntityMetadata,
} from '../metadata/entity-metadata.js';
import {
  getManyToManyJoinTables,
  ManyToManyJoinTable,
} from '../decorators/relation.decorators.js';

/** Ожидаемая схема таблицы, построенная по метаданным сущности. */
export interface ExpectedTableSchema {
  tableName: string;
  columns: Record<string, YdbPrimitive>;
  primaryKey: string[];
}

/** Нормализованное описание существующей таблицы из DescribeTable. */
export interface YdbTableDescription {
  /** Колонка → примитивный typeId (Optional обёртка снята). */
  columns: Map<string, Type_PrimitiveTypeId>;
  primaryKey: string[];
}

/** Результат проверки существующей таблицы против ожидаемой схемы. */
export interface SchemaCheckResult {
  tableName: string;
  /** Колонки, которых нет в БД (можно добавить через ALTER TABLE). */
  missingColumns: [string, YdbPrimitive][];
  /** Колонки с несовпадающим типом (YDB не умеет менять тип — только ручная миграция). */
  typeMismatches: { column: string; expected: YdbPrimitive; actual: string }[];
  /** Лишние колонки в БД (не удаляются автоматически — потеря данных). */
  extraColumns: string[];
  primaryKeyMatches: boolean;
}

/** Проблема схемы, найденная при verify. */
export interface YdbSchemaIssue {
  tableName: string;
  kind:
    | 'missing-table'
    | 'missing-column'
    | 'type-mismatch'
    | 'primary-key-mismatch'
    | 'extra-column';
  message: string;
}

/** YdbPrimitive → PrimitiveTypeId (для сравнения с DescribeTable). */
const PRIMITIVE_TO_TYPE_ID: Record<YdbPrimitive, Type_PrimitiveTypeId> = {
  Uuid: Type_PrimitiveTypeId.UUID,
  Utf8: Type_PrimitiveTypeId.UTF8,
  Int32: Type_PrimitiveTypeId.INT32,
  Int64: Type_PrimitiveTypeId.INT64,
  Bool: Type_PrimitiveTypeId.BOOL,
  Double: Type_PrimitiveTypeId.DOUBLE,
  Float: Type_PrimitiveTypeId.FLOAT,
  Date: Type_PrimitiveTypeId.DATE,
  Datetime: Type_PrimitiveTypeId.DATETIME,
  Timestamp: Type_PrimitiveTypeId.TIMESTAMP,
};

const TYPE_ID_TO_PRIMITIVE = new Map<Type_PrimitiveTypeId, YdbPrimitive>(
  Object.entries(PRIMITIVE_TO_TYPE_ID).map(([k, v]) => [v, k as YdbPrimitive]),
);

/**
 * Строит ожидаемую схему таблицы по метаданным сущности:
 * колонки + synthetic {field}_bi колонки blind index.
 * PK — из @YdbPrimaryColumn, иначе fallback на `uuid`.
 */
export function buildExpectedTableSchema(
  meta: YdbEntityMetadata,
): ExpectedTableSchema {
  const columns: Record<string, YdbPrimitive> = { ...meta.schema };
  for (const ef of meta.encryptedFields) {
    if (ef.blindIndex) columns[`${ef.propertyKey}_bi`] = 'Utf8';
  }

  const primaryKey = meta.primaryKeys.length ? [...meta.primaryKeys] : ['uuid'];

  for (const pk of primaryKey) {
    if (!columns[pk]) {
      throw new Error(
        `Cannot build schema for entity ${meta.target.name}: ` +
          `primary key column "${pk}" is not declared via @YdbColumn. ` +
          `Declare it or mark another column with @YdbPrimaryColumn.`,
      );
    }
  }

  return { tableName: meta.tableName, columns, primaryKey };
}

/** Ожидаемая схема join-таблицы many-to-many. */
export function buildExpectedJoinTableSchema(
  joinTable: ManyToManyJoinTable,
): ExpectedTableSchema {
  return {
    tableName: joinTable.tableName,
    columns: {
      [joinTable.joinColumn]: 'Uuid',
      [joinTable.inverseJoinColumn]: 'Uuid',
    },
    primaryKey: [joinTable.joinColumn, joinTable.inverseJoinColumn],
  };
}

/** Собирает ожидаемые схемы всех таблиц сущностей и их many-to-many join-таблиц. */
export function buildExpectedSchemas(
  entities: (new (...args: any[]) => any)[],
): ExpectedTableSchema[] {
  const schemas: ExpectedTableSchema[] = [];

  for (const entity of entities) {
    const meta = getYdbEntityMetadata(entity);
    if (meta) {
      schemas.push(buildExpectedTableSchema(meta));
    }
  }

  for (const joinTable of getManyToManyJoinTables(entities)) {
    schemas.push(buildExpectedJoinTableSchema(joinTable));
  }

  return schemas;
}

/** Генерирует DDL создания таблицы. */
export function generateCreateTableYql(expected: ExpectedTableSchema): string {
  const columnDefs = Object.entries(expected.columns).map(
    ([name, type]) => `${quoteIdentifier(name)} ${type}`,
  );
  const pk = expected.primaryKey.map(quoteIdentifier).join(', ');
  return (
    `CREATE TABLE ${quoteIdentifier(expected.tableName)} (\n  ` +
    `${columnDefs.join(',\n  ')},\n  PRIMARY KEY (${pk})\n)`
  );
}

/** Генерирует DDL добавления недостающих колонок (один ALTER на таблицу). */
export function generateAddColumnsYql(
  tableName: string,
  columns: [string, YdbPrimitive][],
): string {
  const clauses = columns.map(
    ([name, type]) => `ADD COLUMN ${quoteIdentifier(name)} ${type}`,
  );
  return `ALTER TABLE ${quoteIdentifier(tableName)} ${clauses.join(', ')}`;
}

/**
 * Чистая проверка: сравнивает ожидаемую схему с описанием таблицы из БД.
 * Не ходит в сеть и ничего не меняет.
 */
export function checkTableSchema(
  expected: ExpectedTableSchema,
  existing: YdbTableDescription,
): SchemaCheckResult {
  const missingColumns: [string, YdbPrimitive][] = [];
  const typeMismatches: SchemaCheckResult['typeMismatches'] = [];

  for (const [name, type] of Object.entries(expected.columns)) {
    const actualTypeId = existing.columns.get(name);
    if (actualTypeId === undefined) {
      missingColumns.push([name, type]);
      continue;
    }
    if (actualTypeId !== PRIMITIVE_TO_TYPE_ID[type]) {
      typeMismatches.push({
        column: name,
        expected: type,
        actual:
          TYPE_ID_TO_PRIMITIVE.get(actualTypeId) ?? `typeId=${actualTypeId}`,
      });
    }
  }

  const expectedColumns = new Set(Object.keys(expected.columns));
  const extraColumns = [...existing.columns.keys()].filter(
    (name) => !expectedColumns.has(name),
  );

  const primaryKeyMatches =
    expected.primaryKey.length === existing.primaryKey.length &&
    expected.primaryKey.every((pk) => existing.primaryKey.includes(pk));

  return {
    tableName: expected.tableName,
    missingColumns,
    typeMismatches,
    extraColumns,
    primaryKeyMatches,
  };
}

/**
 * Синхронизатор схемы БД: создаёт недостающие таблицы и колонки
 * по метаданным сущностей. Изменение типа колонки и первичного ключа
 * в YDB невозможно — такие расхождения приводят к ошибке.
 */
export class YdbSchemaSyncer {
  private readonly logger = new Logger(YdbSchemaSyncer.name);

  constructor(
    private readonly driver: Driver,
    private readonly executor: YdbExecutor,
  ) {}

  /**
   * Проверяет схему БД против метаданных сущностей, ничего не меняя.
   * Возвращает список найденных расхождений.
   */
  async verify(
    entities: (new (...args: any[]) => any)[],
  ): Promise<YdbSchemaIssue[]> {
    const issues: YdbSchemaIssue[] = [];

    for (const expected of buildExpectedSchemas(entities)) {
      const existing = await this.describeTable(expected.tableName);
      if (!existing) {
        issues.push({
          tableName: expected.tableName,
          kind: 'missing-table',
          message: `Table "${expected.tableName}" does not exist`,
        });
        continue;
      }

      issues.push(...this.checkToIssues(checkTableSchema(expected, existing)));
    }

    return issues;
  }

  /**
   * Подстраивает БД под схему сущностей:
   *  - нет таблицы — CREATE TABLE;
   *  - нет колонок — ALTER TABLE ADD COLUMN;
   *  - лишние колонки — только предупреждение в лог (не удаляем данные);
   *  - расхождение типа/PK — ошибка (в YDB не меняется, нужна миграция).
   */
  async sync(entities: (new (...args: any[]) => any)[]): Promise<void> {
    for (const expected of buildExpectedSchemas(entities)) {
      const existing = await this.describeTable(expected.tableName);

      if (!existing) {
        const yql = generateCreateTableYql(expected);
        this.logger.log(`Creating table "${expected.tableName}"`);
        await this.executeDdl(yql);
        continue;
      }

      const check = checkTableSchema(expected, existing);

      if (!check.primaryKeyMatches) {
        throw new Error(
          `Schema sync failed for table "${expected.tableName}": ` +
            `primary key mismatch (expected [${expected.primaryKey.join(', ')}], ` +
            `actual [${existing.primaryKey.join(', ')}]). ` +
            `YDB cannot alter a primary key — migrate the table manually.`,
        );
      }

      if (check.typeMismatches.length) {
        const details = check.typeMismatches
          .map((m) => `${m.column}: expected ${m.expected}, actual ${m.actual}`)
          .join('; ');
        throw new Error(
          `Schema sync failed for table "${expected.tableName}": ` +
            `column type mismatch (${details}). ` +
            `YDB cannot alter a column type — migrate the table manually.`,
        );
      }

      for (const extra of check.extraColumns) {
        this.logger.warn(
          `Table "${expected.tableName}" has extra column "${extra}" ` +
            `not present in entity ${expected.tableName} — left as is`,
        );
      }

      if (check.missingColumns.length) {
        const yql = generateAddColumnsYql(
          expected.tableName,
          check.missingColumns,
        );
        this.logger.log(
          `Adding columns to "${expected.tableName}": ` +
            check.missingColumns.map(([name]) => name).join(', '),
        );
        await this.executeDdl(yql);
      }
    }
  }

  private checkToIssues(check: SchemaCheckResult): YdbSchemaIssue[] {
    const issues: YdbSchemaIssue[] = [];

    if (!check.primaryKeyMatches) {
      issues.push({
        tableName: check.tableName,
        kind: 'primary-key-mismatch',
        message: `Table "${check.tableName}" primary key does not match entity`,
      });
    }
    for (const [column] of check.missingColumns) {
      issues.push({
        tableName: check.tableName,
        kind: 'missing-column',
        message: `Table "${check.tableName}" is missing column "${column}"`,
      });
    }
    for (const m of check.typeMismatches) {
      issues.push({
        tableName: check.tableName,
        kind: 'type-mismatch',
        message:
          `Table "${check.tableName}" column "${m.column}" type mismatch: ` +
          `expected ${m.expected}, actual ${m.actual}`,
      });
    }
    for (const column of check.extraColumns) {
      issues.push({
        tableName: check.tableName,
        kind: 'extra-column',
        message: `Table "${check.tableName}" has extra column "${column}"`,
      });
    }

    return issues;
  }

  private async executeDdl(yql: string): Promise<void> {
    await this.executor([yql] as unknown as TemplateStringsArray);
  }

  /**
   * DescribeTable через Table service (query service не отдаёт метаданные
   * колонок). Сессия создаётся на один вызов и сразу закрывается.
   * Возвращает null, если таблицы не существует.
   * Публичный: используется также генератором миграций (migration:generate).
   */
  async describeTable(tableName: string): Promise<YdbTableDescription | null> {
    const client = this.driver.createClient(TableServiceDefinition);
    const path = `${this.driver.database.replace(/\/$/, '')}/${tableName}`;

    const session = await client.createSession({});
    const sessionResult = session.operation?.result
      ? anyUnpack(session.operation.result, CreateSessionResultSchema)
      : undefined;
    const sessionId = sessionResult?.sessionId;
    if (!sessionId) {
      throw new Error('Failed to create YDB table session for schema sync');
    }

    try {
      const response = await client.describeTable({ sessionId, path });
      const operation = response.operation;

      if (!operation || operation.status !== StatusIds_StatusCode.SUCCESS) {
        if (operation?.status === StatusIds_StatusCode.SCHEME_ERROR) {
          return null;
        }
        throw new Error(
          `DescribeTable failed for "${path}": ` +
            `status=${operation?.status ?? 'unknown'} ` +
            this.formatIssues(operation?.issues),
        );
      }

      const result = operation.result
        ? anyUnpack(operation.result, DescribeTableResultSchema)
        : undefined;
      if (!result) {
        throw new Error(`DescribeTable returned no result for "${path}"`);
      }

      const columns = new Map<string, Type_PrimitiveTypeId>();
      for (const column of result.columns) {
        columns.set(column.name, this.extractPrimitiveTypeId(column.type));
      }

      return { columns, primaryKey: [...result.primaryKey] };
    } finally {
      await client.deleteSession({ sessionId }).catch((error: unknown) => {
        this.logger.warn(
          `Failed to delete YDB table session: ${(error as Error).message}`,
        );
      });
    }
  }

  /** Снимает Optional-обёртки и возвращает примитивный typeId. */
  private extractPrimitiveTypeId(type?: Type): Type_PrimitiveTypeId {
    let current = type;
    while (current?.type.case === 'optionalType') {
      current = current.type.value.item;
    }
    if (current?.type.case === 'typeId') {
      return current.type.value;
    }
    return Type_PrimitiveTypeId.PRIMITIVE_TYPE_ID_UNSPECIFIED;
  }

  private formatIssues(issues?: IssueMessage[]): string {
    if (!issues?.length) return '';
    const flatten = (list: IssueMessage[]): string[] =>
      list.flatMap((i) => [i.message, ...flatten(i.issues)]);
    return flatten(issues).filter(Boolean).join('; ');
  }
}
