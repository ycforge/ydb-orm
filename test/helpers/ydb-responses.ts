import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { jest } from '@jest/globals';
import { Type, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import {
  CreateSessionResultSchema,
  DescribeTableResultSchema,
  TtlSettingsSchema,
  ValueSinceUnixEpochModeSettings_Unit,
} from '@ydbjs/api/table';
import type { TtlSettings } from '@ydbjs/api/table';
import { IssueMessageSchema, StatusIds_StatusCode } from '@ydbjs/api/operation';
import { YDBError, CommitError } from '@ydbjs/error';
import type { Driver } from '@ydbjs/core';

/**
 * Фабрики типовых ответов и ошибок YDB для тестов (#109).
 *
 * Заменяют ad-hoc моки: вместо того чтобы в каждом спеке заново собирать
 * proto-ответ DescribeTable или выдумывать форму ошибки SDK, тесты
 * используют эти фабрики. Формы соответствуют реальным ответам
 * @ydbjs/* (см. schema-sync.ts) — мок не эмулирует того, чего нет в SDK.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Ошибки SDK/YDB
// ─────────────────────────────────────────────────────────────────────────────

/** Транзитная ошибка YDB со статус-кодом (классифицируется по code). */
export function ydbStatusError(
  code: StatusIds_StatusCode,
  message = 'transport failure',
): YDBError {
  const issue = create(IssueMessageSchema, { message });
  return new YDBError(code, [issue]);
}

export const unavailableError = () =>
  ydbStatusError(StatusIds_StatusCode.UNAVAILABLE, 'session unavailable');

export const overloadedError = () =>
  ydbStatusError(StatusIds_StatusCode.OVERLOADED, 'overloaded');

export const abortedTransactionError = () =>
  ydbStatusError(StatusIds_StatusCode.ABORTED, 'transaction aborted');

/** Детерминированная ошибка схемы (политикой ORM не ретраится). */
export const schemeError = (message = 'scheme error') =>
  ydbStatusError(StatusIds_StatusCode.SCHEME_ERROR, message);

/** Ошибка коммита с причиной — как у @ydbjs/query. */
export function commitError(cause: unknown): CommitError {
  return new CommitError('Transaction failed.', cause);
}

// ─────────────────────────────────────────────────────────────────────────────
// DescribeTable (Table service)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Колонка для describeTableResponse(): примитивный typeId снимается
 * как есть; строка трактуется как имя YdbPrimitive.
 */
export interface DescribeColumnSpec {
  name: string;
  /**
   * PrimitiveTypeId либо YdbPrimitive-имя ('Utf8', 'Int32', …).
   * Обязательно, если не задан nonPrimitive.
   */
  type?: Type_PrimitiveTypeId | string;
  /**
   * Не-примитивный тип (#91): объект Type (decimal/list/pg/…). При задании
   * перекрывает `type`.
   */
  nonPrimitive?: Type;
}

const PRIMITIVE_NAME_TO_ID: Record<string, Type_PrimitiveTypeId> = {
  Uuid: Type_PrimitiveTypeId.UUID,
  Utf8: Type_PrimitiveTypeId.UTF8,
  Bytes: Type_PrimitiveTypeId.STRING,
  Int32: Type_PrimitiveTypeId.INT32,
  Int64: Type_PrimitiveTypeId.INT64,
  Bool: Type_PrimitiveTypeId.BOOL,
  Double: Type_PrimitiveTypeId.DOUBLE,
  Float: Type_PrimitiveTypeId.FLOAT,
  Date: Type_PrimitiveTypeId.DATE,
  Datetime: Type_PrimitiveTypeId.DATETIME,
  Timestamp: Type_PrimitiveTypeId.TIMESTAMP,
  Json: Type_PrimitiveTypeId.JSON,
  JsonDocument: Type_PrimitiveTypeId.JSON_DOCUMENT,
};

function columnType(
  spec: DescribeColumnSpec,
): { type: { case: 'typeId'; value: number } } | Type | undefined {
  if (spec.nonPrimitive) return spec.nonPrimitive;
  if (typeof spec.type === 'string') {
    const id = PRIMITIVE_NAME_TO_ID[spec.type];
    if (id === undefined) {
      throw new Error(`Unknown primitive name in test fixture: ${spec.type}`);
    }
    return { type: { case: 'typeId', value: id } };
  }
  if (spec.type !== undefined) {
    return { type: { case: 'typeId', value: spec.type } };
  }
  return undefined;
}

export interface DescribeTableOptions {
  columns?: DescribeColumnSpec[];
  primaryKey?: string[];
  indexes?: Array<{ name: string; columns: string[]; unique?: boolean }>;
  ttl?: TtlSettings;
}

/**
 * Реалистичный ответ Table service `DescribeTable` (SUCCESS):
 * структура совпадает с тем, что распаковывает anyUnpack в schema-sync.
 */
export function describeTableResponse(options: DescribeTableOptions): unknown {
  const result = create(DescribeTableResultSchema, {
    columns: (options.columns ?? []).map((spec) => ({
      name: spec.name,
      type: columnType(spec),
    })),
    primaryKey: options.primaryKey ?? [],
    indexes: (options.indexes ?? []).map((idx) => ({
      name: idx.name,
      indexColumns: [...idx.columns],
      ...(idx.unique
        ? { type: { case: 'globalUniqueIndex' as const, value: {} } }
        : {}),
    })),
    ...(options.ttl ? { ttlSettings: options.ttl } : {}),
  });

  return {
    operation: {
      status: StatusIds_StatusCode.SUCCESS,
      result: anyPack(DescribeTableResultSchema, result),
    },
  };
}

/** Ответ операции с ошибкой (не SUCCESS) и списком issue-сообщений. */
export function failedOperationResponse(
  status: StatusIds_StatusCode,
  messages: string[],
): unknown {
  return {
    operation: {
      status,
      issues: messages.map((message) =>
        create(IssueMessageSchema, { message }),
      ),
    },
  };
}

/** Ответ «таблица не существует»: SCHEME_ERROR с текстом not-found (#91). */
export const tableNotFoundResponse = (table: string) =>
  failedOperationResponse(StatusIds_StatusCode.SCHEME_ERROR, [
    `path '/local/${table}' does not exist`,
  ]);

/** TTL по дате/датавремени (dateTypeColumn). */
export function dateTtlSettings(column: string, expireAfterSeconds: number) {
  return create(TtlSettingsSchema, {
    mode: {
      case: 'dateTypeColumn',
      value: { columnName: column, expireAfterSeconds },
    },
  });
}

/** TTL по числовой колонке (valueSinceUnixEpoch). */
export function numericTtlSettings(
  column: string,
  expireAfterSeconds: number,
  unit: ValueSinceUnixEpochModeSettings_Unit,
) {
  return create(TtlSettingsSchema, {
    mode: {
      case: 'valueSinceUnixEpoch',
      value: { columnName: column, columnUnit: unit, expireAfterSeconds },
    },
  });
}

export interface TableServiceClientMock {
  createSession: ReturnType<typeof jest.fn>;
  describeTable: ReturnType<typeof jest.fn>;
  deleteSession: ReturnType<typeof jest.fn>;
}

/**
 * Мок драйвера, отдающего Table service клиент с заготовленными ответами:
 * каждый вызов describeTable потребляет следующий элемент очереди
 * (последний повторяется). Сессии создаются/удаляются детерминированно.
 */
export function tableServiceDriver(describeResponses: unknown[]): {
  driver: Driver;
  client: TableServiceClientMock;
} {
  let sessionCounter = 0;
  let describeIndex = 0;
  const client: TableServiceClientMock = {
    createSession: jest.fn(() =>
      Promise.resolve({
        operation: {
          result: anyPack(
            CreateSessionResultSchema,
            create(CreateSessionResultSchema, {
              sessionId: `session-${++sessionCounter}`,
            }),
          ),
        },
      }),
    ) as TableServiceClientMock['createSession'],
    describeTable: jest.fn(() => {
      // Каждый вызов потребляет следующий ответ; последний повторяется.
      const response =
        describeResponses[
          Math.min(describeIndex++, describeResponses.length - 1)
        ];
      return Promise.resolve(response);
    }) as TableServiceClientMock['describeTable'],
    deleteSession: jest.fn(() =>
      Promise.resolve({}),
    ) as TableServiceClientMock['deleteSession'],
  };

  const driver = {
    database: '/local',
    createClient: jest.fn(() => client),
  } as unknown as Driver;

  return { driver, client };
}
