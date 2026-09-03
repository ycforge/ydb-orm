/**
 * Integration regression tests of the read-only contract (#152).
 *
 * Unlike the unit specs with an inspectBookkeeping seam, here the REAL
 * runMigrationVerification() is called with the REAL default path of reading
 * the bookkeeping table (readBookkeepingSnapshot → YdbSchemaSyncer.describeTable
 * via the Table service). Only transport boundaries are replaced:
 *  - driver.createClient(TableServiceDefinition) → a fake Table client
 *    (DescribeTable returns controlled metadata);
 *  - executor — a strict mock: ANY non-SELECT throws, so an attempted
 *    CREATE/ALTER/INSERT/... from the verification path fails the test
 *    loudly rather than passing unnoticed; all executed SQL is recorded and
 *    compared line by line.
 *
 * loadMigrations is injected only to avoid depending on the filesystem — the
 * bookkeeping table in these tests is read by the real code.
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

/** Strict executor: SELECT — ok (records SQL, returns rows), everything else — failure. */
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
              // An attempted DDL/DML from the read-only path — a loud test failure.
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
    /** No DB query at all. */
    expectNoSqlAtAll: () => expect(executor).not.toHaveBeenCalled(),
    /** Exactly the expected list of SQL (no extra probe/probe-like queries). */
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
    // The table has no records for '2-Pending' and '4-Missing' — they are
    // the pending ones; the '3-Started' record was left from an interrupted run.
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
      // Name matches the file, hash differs — modified after apply.
      {
        id: 5,
        timestamp: 5000,
        name: '5-Tampered',
        hash: 'h5-old',
        state: 'applied',
      },
      // Record without a file — orphan.
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

          // #101 semantics preserved: applied/pending/interrupted/
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

          // The only allowed SQL is the bare SELECT of the bookkeeping table.
          mock.expectExactly([
            'SELECT `id`, `timestamp`, `name`, `hash`, `state` FROM `ydb_migrations`',
          ]);
        });
      }
    }
  });

  describe('legacy bookkeeping (no hash/state columns): read without ALTER', () => {
    // Legacy table: only '1-LegacyApplied' has a record — it is applied
    // by name (#101 semantics for records without a hash).
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

        // Legacy semantics (#101): records without a hash imply applied.
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

          // "Nothing applied": all files are pending, exit code per the
          // #152 contract (pending → 1), the table is NOT created.
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

          // No SQL at all: nothing to read, nothing may be created.
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
