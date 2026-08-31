import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Driver } from '@ydbjs/core';
import {
  runMigrationVerification,
  renderStatusLine,
  type MigrationVerifyIo,
} from './migration-verify.js';
import { exitCodeOf } from './exit-codes.js';
import type { YdbMigration } from '../migrations/migration.interface.js';
import type { AppliedMigration } from '../migrations/migration-runner.js';
import type { MigrationBookkeepingSnapshot } from '../migrations/migration-bookkeeping.js';
import type { YdbSchemaIssue } from '../schema/schema-sync.js';

/** Executor mock: records each SQL and returns the given rows. */
function makeRecordingExecutor(resultRows: Record<string, unknown>[] = []) {
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
    /** No SQL was executed at all — so certainly no DDL happened. */
    expectNoSqlAtAll: () => expect(executor).not.toHaveBeenCalled(),
    /** SQL happened, but among them there is no DDL/DML statement. */
    expectNoDdlOrDml: () => {
      for (const sql of executedSql) {
        expect(sql.toUpperCase()).not.toMatch(
          /^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|UPSERT|REPLACE)\b/,
        );
      }
    },
  };
}

interface RowSpec {
  name: string;
  timestamp?: number;
  hash?: string | null;
  state?: string;
}

function recordFromRow(row: RowSpec, id: number): AppliedMigration {
  return {
    id,
    timestamp: row.timestamp ?? 1000,
    name: row.name,
    hash: row.hash ?? undefined,
    state: row.state === 'started' ? 'started' : 'applied',
  };
}

/**
 * inspectBookkeeping seam: the snapshot is assembled from bookkeeping-table
 * rows WITHOUT touching the executor — as in the real read-only path,
 * where metadata comes via DescribeTable.
 */
function makeInspect(
  rows: RowSpec[] = [],
  overrides: Partial<MigrationBookkeepingSnapshot> = {},
) {
  const inspect = jest.fn(
    (_deps: {
      driver: Driver;
      executor: unknown;
    }): Promise<MigrationBookkeepingSnapshot> =>
      Promise.resolve({
        exists: true,
        legacy: false,
        records: rows.map(recordFromRow),
        ...overrides,
      }),
  );
  return inspect;
}

const notInitialized = () => makeInspect([], { exists: false });

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

/** Migration with mocked up/down (typed as properties — for expect). */
type MockMigration = Omit<YdbMigration, 'up' | 'down'> & {
  up: jest.Mock<() => Promise<void>>;
  down: jest.Mock<() => Promise<void>>;
};

function makeMigrations(
  specs: Array<{ name: string; hash?: string }>,
): MockMigration[] {
  return specs.map((s) => ({
    name: s.name,
    ...(s.hash ? { hash: s.hash } : {}),
    up: jest.fn(async () => {}),
    down: jest.fn(async () => {}),
  }));
}

const fakeDriver = {} as Driver;

function makeConnect(executor: unknown, closed = { count: 0 }) {
  return () =>
    Promise.resolve({
      driver: fakeDriver,
      executor: executor as any,
      close: () => {
        closed.count++;
      },
    });
}

const SCHEMA_ISSUES: YdbSchemaIssue[] = [
  {
    tableName: 'users',
    kind: 'missing-column',
    message: 'Table "users" is missing column "email"',
  },
];

const stubVerifySchema = jest.fn(
  (
    _driver: Driver,
    _executor: unknown,
    _entities: Array<new (...args: any[]) => any>,
  ): Promise<YdbSchemaIssue[]> => Promise.resolve(SCHEMA_ISSUES),
);

let savedNoColor: string | undefined;

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
});

describe('runMigrationVerification (#152)', () => {
  it('ready state: everything applied, success text on stdout only', async () => {
    const migrations = makeMigrations([{ name: '1-A' }]);
    const mock = makeRecordingExecutor();
    const inspect = makeInspect([{ name: '1-A', timestamp: 1000, hash: null }]);
    const io = makeIo();

    const verdict = await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(mock.executor),
      loadMigrations: () => Promise.resolve(migrations),
      inspectBookkeeping: inspect,
      io,
    });

    expect(verdict.ready).toBe(true);
    expect(verdict.state).toBe('ok');
    expect(io.stdoutLines.join('\n')).toContain(
      'Up to date: 1 migration(s) applied',
    );
    expect(io.stderrLines).toEqual([]);
    // Verification does not run migrations: neither up() nor down().
    expect(migrations[0].up).not.toHaveBeenCalled();
    expect(migrations[0].down).not.toHaveBeenCalled();
    // State is read through the snapshot (DescribeTable), without SQL to the bookkeeping.
    expect(inspect).toHaveBeenCalledTimes(1);
    mock.expectNoSqlAtAll();
  });

  it('pending migrations: problems on stderr, deterministic state', async () => {
    const mock = makeRecordingExecutor();
    const io = makeIo();

    const verdict = await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(mock.executor),
      loadMigrations: () =>
        Promise.resolve(
          makeMigrations([{ name: '1-Pending' }, { name: '2-Too' }]),
        ),
      inspectBookkeeping: makeInspect(),
      io,
    });

    expect(verdict.state).toBe('pending');
    expect(verdict.pending).toEqual(['1-Pending', '2-Too']);
    const errText = io.stderrLines.join('\n');
    expect(errText).toContain('Pending migrations (2/2):');
    expect(errText).toContain('- 1-Pending');
    expect(errText).toContain('Not ready: pending migrations');
    // Success is not printed on failure.
    expect(io.stdoutLines.join('\n')).not.toContain('Up to date');
    mock.expectNoSqlAtAll();
  });

  it('interrupted migration (#101): explicit state, not treated as applied', async () => {
    const mock = makeRecordingExecutor();
    const io = makeIo();

    const verdict = await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(mock.executor),
      loadMigrations: () =>
        Promise.resolve(makeMigrations([{ name: '1-Halfway' }])),
      inspectBookkeeping: makeInspect([
        { name: '1-Halfway', timestamp: 1000, state: 'started' },
      ]),
      io,
    });

    expect(verdict.state).toBe('interrupted');
    expect(verdict.interrupted).toEqual(['1-Halfway']);
    expect(verdict.pending).toEqual([]);
    const errText = io.stderrLines.join('\n');
    expect(errText).toContain('Interrupted migrations (1)');
    expect(errText).toContain(
      "- 1-Halfway (state='started'; resolve via migration:repair)",
    );
    mock.expectNoSqlAtAll();
  });

  it('modified after apply (#101): own state and hint', async () => {
    const migrations = makeMigrations([
      { name: '1-Tampered', hash: 'hash-new' },
    ]);
    const mock = makeRecordingExecutor();
    const io = makeIo();

    const verdict = await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(mock.executor),
      loadMigrations: () => Promise.resolve(migrations),
      inspectBookkeeping: makeInspect([
        { name: '1-Tampered', timestamp: 1000, hash: 'hash-old' },
      ]),
      io,
    });

    expect(verdict.state).toBe('modified');
    expect(verdict.modified).toEqual(['1-Tampered']);
    expect(io.stderrLines.join('\n')).toContain('Modified after apply (1)');
    mock.expectNoSqlAtAll();
  });

  it('orphan record alone stays informational: ready=true, exit code 0', async () => {
    const mock = makeRecordingExecutor();
    const io = makeIo();

    const verdict = await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(mock.executor),
      loadMigrations: () =>
        Promise.resolve(makeMigrations([{ name: '1-Alive' }])),
      inspectBookkeeping: makeInspect([
        { name: '1-Alive', timestamp: 1000 },
        { name: '900-Gone', timestamp: 2000 },
      ]),
      io,
    });

    expect(verdict.ready).toBe(true);
    expect(verdict.orphaned).toEqual(['900-Gone']);
    expect(io.stderrLines.join('\n')).toContain('Orphan records (1)');
    mock.expectNoSqlAtAll();
  });

  it('schema mismatch: detailed diagnostics preserved, colored by real stream (#103)', async () => {
    savedNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;

    const mock = makeRecordingExecutor();
    const io = makeIo();

    const verdict = await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      entities: [class Users {}],
      connect: makeConnect(mock.executor),
      loadMigrations: () => Promise.resolve([]),
      inspectBookkeeping: makeInspect(),
      verifySchema: stubVerifySchema,
      io,
      streams: { stderr: { isTTY: true }, stdout: { isTTY: false } },
    });

    expect(stubVerifySchema).toHaveBeenCalledWith(fakeDriver, mock.executor, [
      expect.any(Function),
    ]);
    expect(verdict.state).toBe('schema-drift');
    const errText = io.stderrLines.join('\n');
    expect(errText).toContain(
      'Schema differs from entity metadata (1 issue(s)):',
    );
    // Detailed diagnostics preserved: table header + column.
    expect(errText).toContain('users');
    expect(errText).toContain('is missing column "email"');
    // Color by the real output stream (stderr TTY) — #103.
    expect(errText).toContain('\x1b[');
    mock.expectNoSqlAtAll();
  });

  it('non-TTY output: no ANSI codes in schema diff', async () => {
    savedNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;

    const mock = makeRecordingExecutor();
    const io = makeIo();

    const verdict = await runMigrationVerification({
      command: 'migration:status',
      migrationsDir: './migrations',
      entities: [class Users {}],
      connect: makeConnect(mock.executor),
      loadMigrations: () => Promise.resolve([]),
      inspectBookkeeping: makeInspect(),
      verifySchema: stubVerifySchema,
      io,
      streams: { stderr: { isTTY: false } },
    });

    expect(verdict.state).toBe('schema-drift');
    expect(io.stderrLines.join('\n')).not.toContain('\x1b[');
  });

  it('NO_COLOR disables color even on TTY (#103)', async () => {
    savedNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';

    const mock = makeRecordingExecutor();
    const io = makeIo();

    await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      entities: [class Users {}],
      connect: makeConnect(mock.executor),
      loadMigrations: () => Promise.resolve([]),
      inspectBookkeeping: makeInspect(),
      verifySchema: stubVerifySchema,
      io,
      streams: { stderr: { isTTY: true } },
    });

    expect(io.stderrLines.join('\n')).not.toContain('\x1b[');
  });

  describe('read-only contract: no DDL/DML from verification commands (#152)', () => {
    // Matrix from the task: check / status / show / --json variants.
    const cases: Array<{
      command: 'migration:check' | 'migration:show' | 'migration:status';
      json: boolean;
    }> = [
      { command: 'migration:check', json: false },
      { command: 'migration:status', json: false },
      { command: 'migration:show', json: false },
      { command: 'migration:check', json: true },
      { command: 'migration:status', json: true },
      { command: 'migration:show', json: true },
    ];

    for (const { command, json } of cases) {
      it(`${command}${json ? ' --json' : ''}: never creates or alters ydb_migrations`, async () => {
        // If the path went through ensureMigrationsTable, the executor would
        // receive CREATE TABLE IF NOT EXISTS (+ possible ALTER) — the test fails.
        const mock = makeRecordingExecutor();
        const io = makeIo();

        await runMigrationVerification({
          command,
          migrationsDir: './migrations',
          ...(json ? { json: true } : {}),
          connect: makeConnect(mock.executor),
          loadMigrations: () =>
            Promise.resolve(makeMigrations([{ name: '1-A' }])),
          inspectBookkeeping: makeInspect([{ name: '1-A', timestamp: 1000 }]),
          io,
        });

        // Strict requirement: the mutating path is not merely "didn't fire",
        // it is absent from the execution path entirely — the executor was never called.
        mock.expectNoSqlAtAll();
        mock.expectNoDdlOrDml();
      });
    }

    it('bookkeeping inspection receives driver+executor, not a runner', async () => {
      const mock = makeRecordingExecutor();
      const inspect = makeInspect();
      const io = makeIo();

      await runMigrationVerification({
        command: 'migration:check',
        migrationsDir: './migrations',
        connect: makeConnect(mock.executor),
        loadMigrations: () => Promise.resolve([]),
        inspectBookkeeping: inspect,
        io,
      });

      expect(inspect).toHaveBeenCalledWith({
        driver: fakeDriver,
        executor: mock.executor,
      });
    });
  });

  describe('uninitialized database: ydb_migrations does not exist (#152)', () => {
    it('check: deterministic "nothing applied" result, table is NOT created', async () => {
      const mock = makeRecordingExecutor();
      const io = makeIo();

      const verdict = await runMigrationVerification({
        command: 'migration:check',
        migrationsDir: './migrations',
        connect: makeConnect(mock.executor),
        loadMigrations: () =>
          Promise.resolve(makeMigrations([{ name: '1-New' }])),
        inspectBookkeeping: notInitialized(),
        io,
      });

      // #152 contract: pending → exit 1; nothing was created.
      expect(verdict.state).toBe('pending');
      expect(verdict.pending).toEqual(['1-New']);
      expect(io.stdoutLines.join('\n')).toContain(
        'Bookkeeping table ydb_migrations does not exist yet',
      );
      expect(io.stderrLines.join('\n')).toContain(
        'Not ready: pending migrations',
      );
      mock.expectNoSqlAtAll();
    });

    it('check on empty project: ready with zero migrations, still no writes', async () => {
      const mock = makeRecordingExecutor();
      const io = makeIo();

      const verdict = await runMigrationVerification({
        command: 'migration:check',
        migrationsDir: './migrations',
        connect: makeConnect(mock.executor),
        loadMigrations: () => Promise.resolve([]),
        inspectBookkeeping: notInitialized(),
        io,
      });

      expect(verdict.ready).toBe(true);
      expect(verdict.state).toBe('ok');
      expect(io.stdoutLines.join('\n')).toContain(
        'Up to date: 0 migration(s) applied',
      );
      mock.expectNoSqlAtAll();
    });

    it('status --json: bookkeeping.exists=false distinguishes fresh DB', async () => {
      const mock = makeRecordingExecutor();
      const io = makeIo();

      await runMigrationVerification({
        command: 'migration:status',
        migrationsDir: './migrations',
        json: true,
        connect: makeConnect(mock.executor),
        loadMigrations: () =>
          Promise.resolve(makeMigrations([{ name: '1-New' }])),
        inspectBookkeeping: notInitialized(),
        io,
      });

      expect(io.stderrLines).toEqual([]);
      const report = JSON.parse(io.stdoutLines.join('\n'));
      expect(report.bookkeeping).toEqual({ exists: false, legacy: false });
      expect(report.ready).toBe(false);
      expect(report.state).toBe('pending');
      expect(report.exitCode).toBe(1);
      expect(report.migrations).toEqual([
        {
          name: '1-New',
          applied: false,
          appliedAt: null,
          interrupted: false,
          orphan: false,
          contentChanged: false,
        },
      ]);
      mock.expectNoSqlAtAll();
    });
  });

  describe('--json: machine-readable report on stdout only', () => {
    it('pending state', async () => {
      const mock = makeRecordingExecutor();
      const io = makeIo();

      await runMigrationVerification({
        command: 'migration:check',
        migrationsDir: './migrations',
        json: true,
        connect: makeConnect(mock.executor),
        loadMigrations: () =>
          Promise.resolve(makeMigrations([{ name: '1-New' }])),
        inspectBookkeeping: makeInspect(),
        io,
      });

      expect(io.stderrLines).toEqual([]);
      const report = JSON.parse(io.stdoutLines.join('\n'));
      expect(report).toMatchObject({
        command: 'migration:check',
        ready: false,
        state: 'pending',
        states: ['pending'],
        exitCode: 1,
        total: 1,
        appliedCount: 0,
        applied: false,
        pending: ['1-New'],
        interrupted: [],
        modified: [],
        orphaned: [],
        bookkeeping: { exists: true, legacy: false },
        schema: { checked: false },
      });
      expect(report.migrations).toEqual([
        {
          name: '1-New',
          applied: false,
          appliedAt: null,
          interrupted: false,
          orphan: false,
          contentChanged: false,
        },
      ]);
    });

    it('interrupted: applied=false, explicit flags (#101)', async () => {
      const mock = makeRecordingExecutor();
      const io = makeIo();

      await runMigrationVerification({
        command: 'migration:status',
        migrationsDir: './migrations',
        json: true,
        connect: makeConnect(mock.executor),
        loadMigrations: () =>
          Promise.resolve(makeMigrations([{ name: '1-Halfway', hash: 'h' }])),
        inspectBookkeeping: makeInspect([
          {
            name: '1-Halfway',
            timestamp: 12345,
            state: 'started',
            hash: 'h',
          },
        ]),
        io,
      });

      const report = JSON.parse(io.stdoutLines.join('\n'));
      expect(report).toMatchObject({
        ready: false,
        state: 'interrupted',
        exitCode: 2,
        applied: false,
        interrupted: ['1-Halfway'],
      });
      expect(report.migrations[0]).toEqual({
        name: '1-Halfway',
        applied: false,
        appliedAt: new Date(12345).toISOString(),
        interrupted: true,
        orphan: false,
        contentChanged: false,
      });
    });

    it('#212: content-changed migration is applied=false in JSON, state=modified', async () => {
      const mock = makeRecordingExecutor();
      const io = makeIo();

      await runMigrationVerification({
        command: 'migration:check',
        migrationsDir: './migrations',
        json: true,
        connect: makeConnect(mock.executor),
        loadMigrations: () =>
          Promise.resolve(
            makeMigrations([{ name: '1-Tampered', hash: 'new' }]),
          ),
        inspectBookkeeping: makeInspect([
          { name: '1-Tampered', timestamp: 12345, hash: 'old' },
        ]),
        io,
      });

      const report = JSON.parse(io.stdoutLines.join('\n'));
      expect(report).toMatchObject({
        ready: false,
        state: 'modified',
        states: ['modified'],
        exitCode: 4,
        applied: false,
        appliedCount: 0,
        modified: ['1-Tampered'],
        pending: [],
      });
      expect(report.migrations[0]).toEqual({
        name: '1-Tampered',
        applied: false,
        appliedAt: new Date(12345).toISOString(),
        interrupted: false,
        orphan: false,
        contentChanged: true,
      });
      mock.expectNoSqlAtAll();
    });

    it('schema drift: structured issues included', async () => {
      const mock = makeRecordingExecutor();
      const io = makeIo();

      await runMigrationVerification({
        command: 'migration:check',
        migrationsDir: './migrations',
        entities: [class Users {}],
        json: true,
        connect: makeConnect(mock.executor),
        loadMigrations: () => Promise.resolve([]),
        inspectBookkeeping: makeInspect(),
        verifySchema: stubVerifySchema,
        io,
      });

      const report = JSON.parse(io.stdoutLines.join('\n'));
      expect(report.ready).toBe(false);
      expect(report.state).toBe('schema-drift');
      expect(report.exitCode).toBe(3);
      expect(report.schema).toEqual({
        checked: true,
        issueCount: 1,
        issues: [
          {
            tableName: 'users',
            kind: 'missing-column',
            message: 'Table "users" is missing column "email"',
          },
        ],
      });
    });
  });

  it('runtime error: rethrown as-is with EXIT_COMMAND_ERROR tag, cause preserved', async () => {
    const boom = new Error('connection refused', {
      cause: new Error('ECONNREFUSED'),
    });
    const io = makeIo();

    await expect(
      runMigrationVerification({
        command: 'migration:check',
        migrationsDir: './migrations',
        connect: () => Promise.reject(boom),
        loadMigrations: () => Promise.resolve([]),
        io,
      }),
    ).rejects.toBe(boom);

    // The tag does not break the message or the cause chain.
    expect(boom.message).toBe('connection refused');
    expect((boom as Error & { cause?: Error }).cause?.message).toBe(
      'ECONNREFUSED',
    );
    expect(exitCodeOf(boom)).toBe(5);
    // Nothing printed as a success.
    expect(io.stdoutLines).toEqual([]);
  });

  it('bookkeeping inspection failure is also a command error (exit 5)', async () => {
    const inspect = jest.fn((): Promise<MigrationBookkeepingSnapshot> =>
      Promise.reject(new Error('table ydb_migrations is unavailable')),
    );

    const error = await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(makeRecordingExecutor().executor),
      loadMigrations: () => Promise.resolve([]),
      inspectBookkeeping: inspect,
      io: makeIo(),
    }).catch((e: unknown) => e);

    expect((error as Error).message).toContain('unavailable');
    expect(exitCodeOf(error)).toBe(5);
  });

  it('closes the connection exactly once', async () => {
    const mock = makeRecordingExecutor();
    const closed = { count: 0 };

    await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(mock.executor, closed),
      loadMigrations: () => Promise.resolve([]),
      inspectBookkeeping: makeInspect(),
      io: makeIo(),
    });

    expect(closed.count).toBe(1);
  });

  it('entities are passed to schema verification; absent config skips it', async () => {
    const mock = makeRecordingExecutor();
    const verifySchema = jest.fn(
      (
        _driver: Driver,
        _executor: unknown,
        _entities: Array<new (...args: any[]) => any>,
      ): Promise<YdbSchemaIssue[]> => Promise.resolve([]),
    );

    await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      connect: makeConnect(mock.executor),
      loadMigrations: () => Promise.resolve([]),
      inspectBookkeeping: makeInspect(),
      io: makeIo(),
    });

    // Without entities the schema is not checked at all.
    const io2 = makeIo();
    const entities = [class Photos {}];
    await runMigrationVerification({
      command: 'migration:check',
      migrationsDir: './migrations',
      entities,
      connect: makeConnect(mock.executor),
      loadMigrations: () => Promise.resolve([]),
      inspectBookkeeping: makeInspect(),
      verifySchema,
      io: io2,
    });

    expect(verifySchema).toHaveBeenCalledTimes(1);
    expect(verifySchema).toHaveBeenCalledWith(
      fakeDriver,
      mock.executor,
      entities,
    );
    // Ready + schema matches.
    expect(io2.stdoutLines.join('\n')).toContain(
      '; schema matches entity metadata',
    );
  });
});

describe('renderStatusLine (#152)', () => {
  it('keeps #101 markers and adds content-changed marker', () => {
    expect(renderStatusLine({ name: 'a', applied: true })).toBe('[x] a');
    expect(
      renderStatusLine({ name: 'a', applied: true, appliedAt: new Date(0) }),
    ).toBe(`[x] a (${new Date(0).toISOString()})`);
    expect(renderStatusLine({ name: 'a', applied: false })).toBe('[ ] a');
    expect(
      renderStatusLine({ name: 'a', applied: true, interrupted: true }),
    ).toBe('[~] a — interrupted, resolve via migration:repair');
    expect(
      renderStatusLine({ name: 'a', applied: false, contentChanged: true }),
    ).toContain('[#] a — content changed after apply');
    expect(renderStatusLine({ name: 'a', applied: true, orphan: true })).toBe(
      '[!] a — orphan record (no matching migration file)',
    );
    expect(
      renderStatusLine({
        name: 'a',
        applied: false,
        orphan: true,
        interrupted: true,
      }),
    ).toBe('[!] a — orphan record (no matching migration file) [interrupted]');
    expect(
      renderStatusLine({
        name: 'a',
        applied: false,
        interrupted: true,
        contentChanged: true,
      }),
    ).toContain('interrupted and content changed after apply');
  });
});
