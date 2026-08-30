/**
 * Интеграционные регресс-тесты read-only контракта (#152).
 *
 * В отличие от юнит-спеков с швом inspectBookkeeping, здесь вызывается
 * РЕАЛЬНЫЙ runMigrationVerification() с РЕАЛЬНЫМ дефолтным путём чтения
 * таблицы учёта (readBookkeepingSnapshot → YdbSchemaSyncer.describeTable
 * через Table service). Подменяются только транспортные границы:
 *  - driver.createClient(TableServiceDefinition) → фейковый Table client
 *    (DescribeTable отдаёт управляемые метаданные);
 *  - executor — строгий мок: ЛЮБОЙ не-SELECT бросает исключение, поэтому
 *    попытка CREATE/ALTER/INSERT/... из verification-пути роняет тест,
 *    а не проходит незамеченным; все выполненные SQL записываются и
 *    сверяются построчно.
 *
 * loadMigrations инжектируется только чтобы не зависеть от ФС — таблица
 * учёта в этих тестах читается настоящим кодом.
 */
import { jest } from '@jest/globals';
import { create } from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import {
  CreateSessionResultSchema,
  DescribeTableResultSchema,
} from '@ydbjs/api/table';
import {
  IssueMessageSchema,
  StatusIds_StatusCode,
  type IssueMessage,
} from '@ydbjs/api/operation';
import type { Driver } from '@ydbjs/core';
import {
  runMigrationVerification,
  type MigrationVerifyIo,
} from './migration-verify.js';

type AnyRecord = Record<string, unknown>;

/** Строгий executor: SELECT — ок (пишем SQL, отдаём строки), остальное — падение. */
function makeStrictExecutor(resultRows: AnyRecord[] = []) {
  const executedSql: string[] = [];

  const executor: any = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings[0];
    const query: any = {
      parameter() {
        return query;
      },
      timeout() {
        return query;
      },
      signal() {
        return query;
      },
      cancel() {
        return query;
      },
      then(
        onFulfilled?: ((value: unknown[][]) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) {
        return Promise.resolve()
          .then(() => {
            if (!sql.trimStart().startsWith('SELECT')) {
              // Попытка DDL/DML из read-only пути — громкое падение теста.
              throw new Error(
                `READ-ONLY VIOLATION: non-SELECT executed in verification path: ${sql}`,
              );
            }
            executedSql.push(sql);
            return [resultRows];
          })
          .then(onFulfilled ?? undefined, onRejected ?? undefined);
      },
    };
    return query;
  });

  return {
    executor: executor as unknown,
    executedSql,
    /** Ни одного запроса к БД вообще. */
    expectNoSqlAtAll: () => expect(executor).not.toHaveBeenCalled(),
    /** Ровно ожидаемый список SQL (без лишних probe/probe-like запросов). */
    expectExactly(expected: string[]) {
      expect(executedSql).toEqual(expected);
    },
  };
}

function bookkeepingDescribeResponse(columnNames: string[]): unknown {
  const column = (name: string, typeId: Type_PrimitiveTypeId) => ({
    name,
    type: { type: { case: 'typeId' as const, value: typeId } },
  });
  const byName: Record<string, ReturnType<typeof column>> = {
    id: column('id', Type_PrimitiveTypeId.INT64),
    timestamp: column('timestamp', Type_PrimitiveTypeId.INT64),
    name: column('name', Type_PrimitiveTypeId.UTF8),
    hash: column('hash', Type_PrimitiveTypeId.UTF8),
    state: column('state', Type_PrimitiveTypeId.UTF8),
  };

  return {
    operation: {
      status: StatusIds_StatusCode.SUCCESS,
      result: anyPack(
        DescribeTableResultSchema,
        create(DescribeTableResultSchema, {
          columns: columnNames.map((n) => byName[n]),
          primaryKey: ['id'],
          indexes: [],
        }),
      ),
    },
  };
}

function notFoundDescribeResponse(): unknown {
  const issueMsg = (message: string, children?: IssueMessage[]): IssueMessage =>
    create(IssueMessageSchema, {
      message,
      severity: 1,
      ...(children?.length ? { issues: children } : {}),
    });

  return {
    operation: {
      status: StatusIds_StatusCode.SCHEME_ERROR,
      issues: [issueMsg("path '/local/ydb_migrations' does not exist")],
    },
  };
}

interface FakeDriverOptions {
  describeTable: () => Promise<unknown>;
}

function makeFakeDriver({ describeTable }: FakeDriverOptions): Driver {
  const sessionResult = anyPack(
    CreateSessionResultSchema,
    create(CreateSessionResultSchema, { sessionId: 'session-verify-1' }),
  );
  const tableClient = {
    createSession: jest.fn(() =>
      Promise.resolve({ operation: { result: sessionResult } }),
    ),
    describeTable,
    deleteSession: jest.fn(() => Promise.resolve({})),
  };
  return {
    database: '/local',
    createClient: () => tableClient,
  } as unknown as Driver;
}

function makeIo(): MigrationVerifyIo & {
  stdoutLines: string[];
  stderrLines: string[];
} {
  const io = {
    stdoutLines: [] as string[],
    stderrLines: [] as string[],
    stdout: (line: string) => {
      io.stdoutLines.push(line);
    },
    stderr: (line: string) => {
      io.stderrLines.push(line);
    },
  };
  return io;
}

type VerifyCommand = 'migration:check' | 'migration:show' | 'migration:status';

async function runReal(options: {
  command: VerifyCommand;
  json?: boolean;
  driver: Driver;
  executor: unknown;
  migrations: Array<{ name: string; hash?: string }>;
}) {
  const io = makeIo();
  const verdict = await runMigrationVerification({
    command: options.command,
    migrationsDir: './migrations',
    ...(options.json ? { json: true } : {}),
    connect: () =>
      Promise.resolve({
        driver: options.driver,
        executor: options.executor as any,
        close: () => {},
      }),
    loadMigrations: () =>
      Promise.resolve(
        options.migrations.map((m) => ({
          name: m.name,
          ...(m.hash ? { hash: m.hash } : {}),
          up: async () => {},
          down: async () => {},
        })),
      ),
    io,
  });
  return { verdict, io };
}

describe('runMigrationVerification: real path emits no DDL/DML (#152)', () => {
  const commands: VerifyCommand[] = [
    'migration:check',
    'migration:show',
    'migration:status',
  ];

  describe('initialized modern bookkeeping (hash/state present)', () => {
    // В таблице нет записей для '2-Pending' и '4-Missing' — они и есть
    // pending; запись '3-Started' осталась от оборванного запуска.
    const rows: AnyRecord[] = [
      {
        id: 1,
        timestamp: 1000,
        name: '1-Applied',
        hash: 'ha',
        state: 'applied',
      },
      {
        id: 3,
        timestamp: 3000,
        name: '3-Started',
        hash: 'hs',
        state: 'started',
      },
      // Имя совпадает с файлом, хеш различается — modified после apply.
      {
        id: 5,
        timestamp: 5000,
        name: '5-Tampered',
        hash: 'h5-old',
        state: 'applied',
      },
      // Запись без файла — orphan.
      {
        id: 9,
        timestamp: 9000,
        name: '900-Gone',
        hash: 'hg',
        state: 'applied',
      },
    ];
    const files = [
      { name: '1-Applied', hash: 'ha' },
      { name: '2-Pending' },
      { name: '3-Started', hash: 'hs' },
      { name: '4-Missing', hash: 'hm' },
      { name: '5-Tampered', hash: 'h5-new' },
    ];

    for (const command of commands) {
      for (const json of [false, true]) {
        it(`${command}${json ? ' --json' : ''}: only a bare SELECT runs`, async () => {
          const mock = makeStrictExecutor(rows);
          const driver = makeFakeDriver({
            describeTable: () =>
              Promise.resolve(
                bookkeepingDescribeResponse([
                  'id',
                  'timestamp',
                  'name',
                  'hash',
                  'state',
                ]),
              ),
          });

          const { verdict, io } = await runReal({
            command,
            json,
            driver,
            executor: mock.executor,
            migrations: files,
          });

          // Семантика #101 сохранена: applied/pending/interrupted/
          // modified/orphan.
          expect(verdict.pending.sort()).toEqual(['2-Pending', '4-Missing']);
          expect(verdict.interrupted).toEqual(['3-Started']);
          expect(verdict.modified).toEqual(['5-Tampered']);
          expect(verdict.orphaned).toEqual(['900-Gone']);
          expect(verdict.appliedCount).toBe(1);
          expect(verdict.totalMigrations).toBe(5);
          expect(verdict.state).toBe('interrupted');

          if (json) {
            expect(io.stderrLines).toEqual([]);
            const report = JSON.parse(io.stdoutLines.join('\n'));
            expect(report.bookkeeping).toEqual({
              exists: true,
              legacy: false,
            });
            const started = report.migrations.find(
              (m: AnyRecord) => m.name === '3-Started',
            );
            expect(started).toMatchObject({
              applied: false,
              interrupted: true,
            });
            const tampered = report.migrations.find(
              (m: AnyRecord) => m.name === '5-Tampered',
            );
            expect(tampered).toMatchObject({
              applied: false,
              contentChanged: true,
            });
            const gone = report.migrations.find(
              (m: AnyRecord) => m.name === '900-Gone',
            );
            expect(gone).toMatchObject({ orphan: true, applied: true });
          }

          // Единственный допустимый SQL — голый SELECT таблицы учёта.
          mock.expectExactly([
            'SELECT `id`, `timestamp`, `name`, `hash`, `state` FROM `ydb_migrations`',
          ]);
        });
      }
    }
  });

  describe('legacy bookkeeping (no hash/state columns): read without ALTER', () => {
    // Легаси-таблица: запись есть только у '1-LegacyApplied' — она applied
    // по имени (семантика #101 для записей без хеша).
    const rows: AnyRecord[] = [
      { id: 1, timestamp: 1000, name: '1-LegacyApplied' },
    ];
    const files = [{ name: '1-LegacyApplied' }, { name: '2-LegacyPending' }];

    for (const json of [false, true]) {
      it(`migration:check${json ? ' --json' : ''}: legacy semantics preserved, no ALTER`, async () => {
        const mock = makeStrictExecutor(rows);
        const driver = makeFakeDriver({
          describeTable: () =>
            Promise.resolve(
              bookkeepingDescribeResponse(['id', 'timestamp', 'name']),
            ),
        });

        const { verdict, io } = await runReal({
          command: 'migration:check',
          json,
          driver,
          executor: mock.executor,
          migrations: files,
        });

        // Легаси-семантика (#101): записи без хеша подразумевают applied.
        expect(verdict.appliedCount).toBe(1);
        expect(verdict.pending).toEqual(['2-LegacyPending']);
        expect(verdict.modified).toEqual([]);
        expect(verdict.interrupted).toEqual([]);

        if (json) {
          const report = JSON.parse(io.stdoutLines.join('\n'));
          expect(report.bookkeeping).toEqual({ exists: true, legacy: true });
        }

        mock.expectExactly([
          'SELECT `id`, `timestamp`, `name` FROM `ydb_migrations`',
        ]);
      });
    }
  });

  describe('uninitialized database (ydb_migrations does not exist)', () => {
    const files = [{ name: '1-New' }, { name: '2-New' }];

    for (const command of commands) {
      for (const json of [false, true]) {
        it(`${command}${json ? ' --json' : ''}: deterministic "nothing applied", zero SQL`, async () => {
          const mock = makeStrictExecutor();
          const driver = makeFakeDriver({
            describeTable: () => Promise.resolve(notFoundDescribeResponse()),
          });

          const { verdict, io } = await runReal({
            command,
            json,
            driver,
            executor: mock.executor,
            migrations: files,
          });

          // «Не применено ничего»: все файлы — pending, exit-код по
          // контракту #152 (pending → 1), таблица НЕ создаётся.
          expect(verdict.state).toBe('pending');
          expect(verdict.pending).toEqual(['1-New', '2-New']);
          expect(verdict.totalMigrations).toBe(2);

          if (json) {
            expect(io.stderrLines).toEqual([]);
            const report = JSON.parse(io.stdoutLines.join('\n'));
            expect(report.bookkeeping).toEqual({
              exists: false,
              legacy: false,
            });
            expect(report.ready).toBe(false);
            expect(report.exitCode).toBe(1);
          } else {
            expect(io.stdoutLines.join('\n')).toContain(
              'Bookkeeping table ydb_migrations does not exist yet',
            );
          }

          // Ни одного SQL: читать нечего, создавать нельзя.
          mock.expectNoSqlAtAll();
        });
      }
    }

    it('empty project + uninitialized DB: ready with zero migrations', async () => {
      const mock = makeStrictExecutor();
      const driver = makeFakeDriver({
        describeTable: () => Promise.resolve(notFoundDescribeResponse()),
      });

      const { verdict } = await runReal({
        command: 'migration:check',
        driver,
        executor: mock.executor,
        migrations: [],
      });

      expect(verdict.ready).toBe(true);
      expect(verdict.state).toBe('ok');
      expect(verdict.totalMigrations).toBe(0);
      mock.expectNoSqlAtAll();
    });
  });
});
