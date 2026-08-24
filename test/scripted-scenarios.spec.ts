import 'reflect-metadata';
import { create } from '@bufbuild/protobuf';
import { TypeSchema, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import {
  createScriptedExecutor,
  UnexpectedMockQueryError,
} from './helpers/ydb-mock.js';
import {
  describeTableResponse,
  tableServiceDriver,
  tableNotFoundResponse,
  dateTtlSettings,
  failedOperationResponse,
  unavailableError,
} from './helpers/ydb-responses.js';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import { YdbSchemaSyncer } from '../src/schema/schema-sync.js';
import {
  YdbEntity,
  YdbColumn,
  YdbPrimaryColumn,
  YdbBaseEntity,
} from '../src/index.js';
import { TtlDocumentEntity } from './fixtures/ttl_document/ttl-document.entity.js';
import { IndexedArticleEntity } from './fixtures/indexed_article/indexed-article.entity.js';

/**
 * Регрессионные сценарии #109 через новый программный мок.
 *
 * Каждый тест покрывает класс багов, который старый one-shot мок
 * (createMockExecutor) не мог поймать:
 *  - строгий порядок и содержание SQL многошаговых операций;
 *  - TTL-DDL: sync выполняет ровно нужный DDL (раньше невалидный TTL-DDL
 *    «прожил» бы без спеков на поток DescribeTable → CREATE TABLE);
 *  - парсинг реалистичных ответов DescribeTable для всех поддерживаемых
 *    примитивов (#88/#91 закрывали TTL и decimal по отдельности);
 *  - наблюдаемость AbortSignal (старый мок глотал signal/timeout);
 */

// ─────────────────────────────────────────────────────────────────────────────
// Сущность со всеми примитивами YdbPrimitive — для roundtrip DescribeTable
// ─────────────────────────────────────────────────────────────────────────────

@YdbEntity('fixture_all_primitives')
class AllPrimitivesEntity extends YdbBaseEntity {
  @YdbPrimaryColumn('Uuid')
  uuid: string;

  @YdbColumn('Utf8')
  text_col: string;

  @YdbColumn('Bytes')
  bytes_col: Uint8Array;

  @YdbColumn('Int32')
  int32_col: number;

  @YdbColumn('Int64')
  int64_col: bigint;

  @YdbColumn('Bool')
  bool_col: boolean;

  @YdbColumn('Double')
  double_col: number;

  @YdbColumn('Float')
  float_col: number;

  @YdbColumn('Date')
  date_col: string;

  @YdbColumn('Datetime')
  datetime_col: Date;

  @YdbColumn('Timestamp')
  timestamp_col: Date;

  @YdbColumn('Json')
  json_col: Record<string, unknown>;

  @YdbColumn('JsonDocument')
  jsondoc_col: unknown;
}

const ALL_PRIMITIVE_COLUMNS: Array<[string, string, Type_PrimitiveTypeId]> = [
  ['uuid', 'Uuid', Type_PrimitiveTypeId.UUID],
  ['text_col', 'Utf8', Type_PrimitiveTypeId.UTF8],
  ['bytes_col', 'Bytes', Type_PrimitiveTypeId.STRING],
  ['int32_col', 'Int32', Type_PrimitiveTypeId.INT32],
  ['int64_col', 'Int64', Type_PrimitiveTypeId.INT64],
  ['bool_col', 'Bool', Type_PrimitiveTypeId.BOOL],
  ['double_col', 'Double', Type_PrimitiveTypeId.DOUBLE],
  ['float_col', 'Float', Type_PrimitiveTypeId.FLOAT],
  ['date_col', 'Date', Type_PrimitiveTypeId.DATE],
  ['datetime_col', 'Datetime', Type_PrimitiveTypeId.DATETIME],
  ['timestamp_col', 'Timestamp', Type_PrimitiveTypeId.TIMESTAMP],
  ['json_col', 'Json', Type_PrimitiveTypeId.JSON],
  ['jsondoc_col', 'JsonDocument', Type_PrimitiveTypeId.JSON_DOCUMENT],
];

describe('#109: schema sync по сценарию с программным моком', () => {
  it('таблицы нет → ровно один CREATE TABLE c TTL в WITH-секции', async () => {
    const db = createScriptedExecutor({ label: 'ddl-db' });
    const { driver } = tableServiceDriver([
      tableNotFoundResponse('fixture_ttl_docs'),
    ]);
    const syncer = new YdbSchemaSyncer(driver, db.executor);

    db.expect('CREATE TABLE `fixture_ttl_docs`').returns([]);

    await syncer.sync([TtlDocumentEntity]);

    // Строгий матч шага уже гарантирует CREATE TABLE нужной таблицы;
    // здесь проверяем содержимое DDL: колонки, PK и TTL-секция в WITH.
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('`uuid` Uuid');
    expect(db.calls[0].sql).toContain('PRIMARY KEY (`uuid`)');
    expect(db.calls[0].sql).toContain(
      'WITH (\n  TTL = Interval("P7D") ON `expires_at`\n)',
    );
    // Тело таблицы закрыто до WITH
    expect(db.calls[0].sql.indexOf('\n)')).toBeLessThan(
      db.calls[0].sql.indexOf('WITH ('),
    );

    db.assertComplete();
  });

  it('схема и TTL совпадают → ни одного DDL', async () => {
    const db = createScriptedExecutor();
    const { driver } = tableServiceDriver([
      describeTableResponse({
        columns: [
          { name: 'uuid', type: 'Uuid' },
          { name: 'body', type: 'Utf8' },
          { name: 'expires_at', type: 'Datetime' },
        ],
        primaryKey: ['uuid'],
        ttl: dateTtlSettings('expires_at', 7 * 24 * 3600), // P7D
      }),
    ]);
    const syncer = new YdbSchemaSyncer(driver, db.executor);

    await syncer.sync([TtlDocumentEntity]);

    // Ни одного обращения к executor: схема совпала
    expect(db.calls).toHaveLength(0);
  });

  it('TTL расходится → ровно один ALTER TABLE SET (TTL = ...)', async () => {
    const db = createScriptedExecutor();
    const { driver } = tableServiceDriver([
      describeTableResponse({
        columns: [
          { name: 'uuid', type: 'Uuid' },
          { name: 'body', type: 'Utf8' },
          { name: 'expires_at', type: 'Datetime' },
        ],
        primaryKey: ['uuid'],
        ttl: dateTtlSettings('expires_at', 3600), // PT1H вместо P7D
      }),
    ]);
    const syncer = new YdbSchemaSyncer(driver, db.executor);

    db.expect('ALTER TABLE `fixture_ttl_docs` SET (').returns([]);

    await syncer.sync([TtlDocumentEntity]);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toBe(
      'ALTER TABLE `fixture_ttl_docs` SET (TTL = Interval("P7D") ON `expires_at`)',
    );
    db.assertComplete();
  });

  it('ошибка DescribeTable (не not-found) пробрасывается и не приводит к CREATE TABLE', async () => {
    const db = createScriptedExecutor();
    const { driver } = tableServiceDriver([
      failedOperationResponse(StatusIds_StatusCode.UNAUTHORIZED, [
        'access denied for path /local/fixture_ttl_docs',
      ]),
    ]);
    const syncer = new YdbSchemaSyncer(driver, db.executor);

    await expect(syncer.sync([TtlDocumentEntity])).rejects.toThrow(
      /DescribeTable failed.*UNAUTHORIZED.*access denied/s,
    );
    // Fail-fast: никаких записей в БД после неопределённости
    expect(db.calls).toHaveLength(0);
  });

  it('фикстура с индексами: CREATE TABLE содержит автоименованный и явный индексы (#109)', async () => {
    const db = createScriptedExecutor();
    const { driver } = tableServiceDriver([
      tableNotFoundResponse('fixture_articles'),
    ]);
    const syncer = new YdbSchemaSyncer(driver, db.executor);

    db.expect('CREATE TABLE `fixture_articles`').returns([]);

    await syncer.sync([IndexedArticleEntity]);

    // Автоимя по таблице и колонке + явно заданное имя составного индекса
    expect(db.calls[0].sql).toContain(
      'INDEX `fixture_articles__slug` GLOBAL SYNC ON (`slug`)',
    );
    expect(db.calls[0].sql).toContain(
      'INDEX `fixture_articles__author_date` GLOBAL SYNC ON (`author`, `created_at`)',
    );
    db.assertComplete();
  });

  it('индекс уже существует в БД → без DDL; расхождение колонок индекса — ошибка', async () => {
    const db = createScriptedExecutor({ label: 'idx-db' });
    const { driver } = tableServiceDriver([
      describeTableResponse({
        columns: [
          { name: 'uuid', type: 'Uuid' },
          { name: 'slug', type: 'Utf8' },
          { name: 'author', type: 'Utf8' },
          { name: 'created_at', type: 'Datetime' },
        ],
        primaryKey: ['uuid'],
        indexes: [
          {
            name: 'fixture_articles__slug',
            columns: ['created_at'], // другие колонки — менять нельзя
            unique: false,
          },
          {
            name: 'fixture_articles__author_date',
            columns: ['author', 'created_at'],
            unique: false,
          },
        ],
      }),
    ]);
    const syncer = new YdbSchemaSyncer(driver, db.executor);

    await expect(syncer.sync([IndexedArticleEntity])).rejects.toThrow(
      /index columns mismatch.*fixture_articles__slug/s,
    );
    expect(db.calls).toHaveLength(0);
  });
});

describe('#109: DescribeTable парсинг всех поддерживаемых примитивов', () => {
  it.each(ALL_PRIMITIVE_COLUMNS.map(([col, prim]) => [col, prim]))(
    '%s (%s) распознаётся из proto-ответа',
    async (name, primitiveName) => {
      const { driver } = tableServiceDriver([
        describeTableResponse({
          columns: [{ name, type: primitiveName }],
          primaryKey: [],
        }),
      ]);
      const syncer = new YdbSchemaSyncer(driver, {} as never);

      const desc = await syncer.describeTable('fixture_all_primitives');

      const expectedId = ALL_PRIMITIVE_COLUMNS.find(
        ([col]) => col === name,
      )![2];
      expect(desc?.columns.get(name)).toBe(expectedId);
    },
  );

  it('полное совпадение всех колонок — verify без issues', async () => {
    const { driver } = tableServiceDriver([
      describeTableResponse({
        columns: ALL_PRIMITIVE_COLUMNS.map(([name, type]) => ({
          name,
          type,
        })),
        primaryKey: ['uuid'],
      }),
    ]);
    const syncer = new YdbSchemaSyncer(driver, {} as never);

    const issues = await syncer.verify([AllPrimitivesEntity]);

    expect(issues).toEqual([]);
  });

  it('не-примитивный тип (pg) попадает в unsupportedColumns с честным описанием (#91)', async () => {
    const { driver } = tableServiceDriver([
      describeTableResponse({
        columns: [
          { name: 'uuid', type: 'Uuid' },
          {
            name: 'text_col',
            nonPrimitive: create(TypeSchema, {
              type: {
                case: 'pgType',
                value: { typeName: 'int4', oid: 23 },
              },
            }),
          },
        ],
        primaryKey: ['uuid'],
      }),
    ]);
    const syncer = new YdbSchemaSyncer(driver, {} as never);

    const desc = await syncer.describeTable('fixture_all_primitives');

    expect(desc?.unsupportedColumns?.get('text_col')).toBe('pg<int4>');
  });

  it('NOT_FOUND отдаёт null, а не бросает (#91)', async () => {
    const { driver } = tableServiceDriver([
      tableNotFoundResponse('fixture_all_primitives'),
    ]);
    const syncer = new YdbSchemaSyncer(driver, {} as never);

    await expect(
      syncer.describeTable('fixture_all_primitives'),
    ).resolves.toBeNull();
  });
});

describe('#109: строгость сценария ловит деградацию оркестрации', () => {
  it('лишний DDL между шагами роняет тест немедленно', async () => {
    const db = createScriptedExecutor();

    // Сценарий: сначала ALTER, потом CREATE — любой вызов вне порядка падает
    db.expect('ALTER TABLE').returns([]);
    db.expect('CREATE TABLE').returns([]);

    await expect(
      db.executor(['CREATE TABLE `x` (...)'] as any),
    ).rejects.toThrow(UnexpectedMockQueryError);
  });

  it('неожиданная ошибка транспорта видна как сбой шага, а не тихое «пусто»', async () => {
    const db = createScriptedExecutor();
    db.expect('SELECT').throws(unavailableError());

    await expect(db.executor(['SELECT 1'] as any)).rejects.toThrow(
      /session unavailable/,
    );
    // Шаг потреблён: повторный вызов того же SQL уже неожиданен
    await expect(db.executor(['SELECT 1'] as any)).rejects.toThrow(
      /\(queue is empty\)/,
    );
  });
});
