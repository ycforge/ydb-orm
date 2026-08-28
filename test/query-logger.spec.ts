import 'reflect-metadata';
import { jest } from '@jest/globals';
import { createMockExecutor } from './helpers/mock-executor.js';
import { createScriptedExecutor } from './helpers/ydb-mock.js';
import {
  ConsoleQueryLogger,
  wrapExecutorWithLogging,
  type QueryLogger,
  type QueryLogEntry,
} from '../src/core/query-logger.js';

describe('ConsoleQueryLogger', () => {
  const logSpies: jest.SpiedFunction<typeof console.log>[] = [];
  const errorSpies: jest.SpiedFunction<typeof console.error>[] = [];

  afterEach(() => {
    for (const s of logSpies) s.mockRestore();
    for (const s of errorSpies) s.mockRestore();
    logSpies.length = 0;
    errorSpies.length = 0;
  });

  it('logs query with params and duration', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    logSpies.push(logSpy);
    const logger = new ConsoleQueryLogger();
    logger.log({
      sql: 'SELECT * FROM users WHERE id = $id',
      paramNames: ['id'],
      maskedParams: { id: 'abc-123' },
      durationMs: 42,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[YDB] QUERY 42ms');
    expect(output).toContain('SELECT * FROM users WHERE id = $id');
    expect(output).toContain('id="abc-123"');
  });

  it('logs error queries', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    errorSpies.push(errorSpy);
    const logger = new ConsoleQueryLogger();
    logger.log({
      sql: 'BAD SQL',
      paramNames: [],
      maskedParams: {},
      durationMs: 1,
      error: new Error('syntax error'),
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).toContain('ERROR: syntax error');
    expect(output).toContain('BAD SQL');
  });

  it('truncates long SQL', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    logSpies.push(logSpy);
    const logger = new ConsoleQueryLogger();
    const longSql = 'SELECT ' + 'x, '.repeat(100);
    logger.log({
      sql: longSql,
      paramNames: [],
      maskedParams: {},
      durationMs: 0,
    });

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('...');
    expect(output.length).toBeLessThan(longSql.length);
  });
});

describe('wrapExecutorWithLogging', () => {
  let logEntries: QueryLogEntry[];
  let mockLogger: QueryLogger;

  beforeEach(() => {
    logEntries = [];
    mockLogger = { log: (entry) => logEntries.push(entry) };
  });

  it('logs successful query with duration', async () => {
    const mock = createMockExecutor([[{ uuid: '1' }]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging([
      'SELECT * FROM users',
    ] as unknown as TemplateStringsArray);
    q.parameter('id', 'test');
    await q;

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].sql).toBe('SELECT * FROM users');
    expect(logEntries[0].paramNames).toEqual(['id']);
    // #168: по умолчанию значения не раскрываются — только метаинформация
    expect(logEntries[0].maskedParams).toEqual({ id: '<string:4>' });
    expect(logEntries[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(logEntries[0].error).toBeUndefined();
  });

  it('logs failed query with error', async () => {
    // #109: программный мок вместо ad-hoc failExecutor
    const db = createScriptedExecutor();
    db.expect('SELECT 1').throws(new Error('connection refused'));

    const logging = wrapExecutorWithLogging(db.executor, mockLogger);
    const q = logging(['SELECT 1'] as unknown as TemplateStringsArray);
    q.parameter('p', 'val');

    await expect(q).rejects.toThrow('connection refused');

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].error?.message).toBe('connection refused');
  });

  it('masks long string parameters to metadata', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('description', 'a'.repeat(200));
    await q;

    expect(logEntries[0].maskedParams.description).toBe('<string:200>');
  });

  it('masks every scalar by default, including non-denylisted names (#168)', async () => {
    // Раньше значения с произвольными именами (salary, medical_record и т.п.)
    // утекали в лог открыто — денylist не мог их покрыть.
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('password', 'hunter2');
    q.parameter('api_token', 'abc123');
    q.parameter('salary', 150000);
    q.parameter('medical_record', 'MI-3712-X');
    q.parameter('home_address', 'Baker St');
    q.parameter('birth_date', '1990-01-02');
    await q;

    expect(logEntries[0].maskedParams.password).toBe('<string:7>');
    expect(logEntries[0].maskedParams.api_token).toBe('<string:6>');
    expect(logEntries[0].maskedParams.salary).toBe('<number>');
    expect(logEntries[0].maskedParams.medical_record).toBe('<string:9>');
    expect(logEntries[0].maskedParams.home_address).toBe('<string:8>');
    expect(logEntries[0].maskedParams.birth_date).toBe('<string:10>');
  });

  it('masks blind index columns to metadata without revealing hashes', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('email_encrypted_bi', 'hash-of-plaintext');
    q.parameter('author_email_bi', 'another-hash');
    // Нумерованные blind-index параметры non-root WHERE ({field}_bi_N,
    // см. buildFieldCondition) маскируются так же, как корневые.
    q.parameter('email_bi_0', 'numbered-hash');
    await q;

    expect(logEntries[0].maskedParams.email_encrypted_bi).toBe('<string:17>');
    expect(logEntries[0].maskedParams.author_email_bi).toBe('<string:12>');
    expect(logEntries[0].maskedParams.email_bi_0).toBe('<string:13>');
  });

  it('passes idempotent() through to the wrapped query (#27)', async () => {
    // Без проброса пометка терялась бы на логирующем прокси, и запрос
    // выпадал бы из retry-политики при включённом logQueries.
    const db = createScriptedExecutor();
    db.expect('SELECT 1').returnsRows({ one: 1 });

    const logging = wrapExecutorWithLogging(db.executor, mockLogger);
    const q = logging(['SELECT 1'] as unknown as TemplateStringsArray);
    (q as any).idempotent(true);
    await q;

    expect(db.calls[0].idempotent).toBe(true);
    db.assertComplete();
  });

  it('masks non-string sensitive values by default', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('pin', 1234);
    q.parameter('is_admin', true);
    await q;

    expect(logEntries[0].maskedParams.pin).toBe('<number>');
    expect(logEntries[0].maskedParams.is_admin).toBe('<boolean>');
  });

  it('option true reveals all raw values (#168)', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger, {
      values: true,
    });

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('title', 'Hello');
    q.parameter('table_name', 't'.repeat(100));
    q.parameter('hash', 'sha256hash');
    await q;

    expect(logEntries[0].maskedParams.title).toBe('Hello');
    expect(logEntries[0].maskedParams.table_name).toBe('t'.repeat(64) + '...');
    expect(logEntries[0].maskedParams.hash).toBe('sha256hash');
  });

  it('allowlist by name reveals only listed parameters (#168)', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger, {
      values: ['title'],
    });

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('title', 'Hello');
    q.parameter('salary', 150000);
    await q;

    expect(logEntries[0].maskedParams.title).toBe('Hello');
    expect(logEntries[0].maskedParams.salary).toBe('<number>');
  });

  it('allowlist by regex matches parameter names (#168)', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger, {
      values: /^email/,
    });

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('email', 'ivan@example.com');
    q.parameter('name', 'Ivan');
    await q;

    expect(logEntries[0].maskedParams.email).toBe('ivan@example.com');
    expect(logEntries[0].maskedParams.name).toBe('<string:4>');
  });

  it('allowlist predicate decides per parameter name (#168)', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger, {
      values: (name) => name.startsWith('debug_'),
    });

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('debug_trace_id', 'abc-123');
    q.parameter('user_id', 'u-42');
    await q;

    expect(logEntries[0].maskedParams.debug_trace_id).toBe('abc-123');
    expect(logEntries[0].maskedParams.user_id).toBe('<string:4>');
  });

  it('bytes and blind index stay masked even when values are revealed (#168)', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger, {
      values: true,
    });

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('data', new Uint8Array([1, 2, 3]));
    q.parameter('email_bi', 'hash');
    await q;

    expect(logEntries[0].maskedParams.data).toBe('<bytes:3>');
    expect(logEntries[0].maskedParams.email_bi).toBe('hash');
  });

  it('masks Uint8Array parameters', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('data', new Uint8Array([1, 2, 3]));
    await q;

    expect(logEntries[0].maskedParams.data).toBe('<bytes:3>');
  });

  it('masks YDB typed-parameter inner values by default (#168)', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('typed', { type: 'Utf8', value: 'raw-secret' });
    await q;

    expect(logEntries[0].maskedParams.typed).toBe('<string:10>');
  });

  it('keeps logging through parameter() chaining', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    // Цепочка должна оставаться на прокси, иначе второй параметр не залогируется
    q.parameter('a', 1).parameter('b', 2);
    await q;

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].paramNames).toEqual(['a', 'b']);
    expect(logEntries[0].maskedParams).toEqual({
      a: '<number>',
      b: '<number>',
    });
  });

  it('passes through transaction method', () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    expect(typeof (logging as any).transaction).toBe('function');
  });

  it('logs queries inside a transaction', async () => {
    const mock = createMockExecutor([[{ cnt: 1 }]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    await (logging as any).transaction().execute(async (trx: any) => {
      const q = trx(['SELECT COUNT(*) FROM t'] as unknown);
      q.parameter('flag', 1);
      await q;
    });

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].sql).toBe('SELECT COUNT(*) FROM t');
    expect(logEntries[0].paramNames).toEqual(['flag']);
    expect(logEntries[0].maskedParams).toEqual({ flag: '<number>' });
    expect(logEntries[0].error).toBeUndefined();
  });

  it('logs queries across nested transactions', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    await (logging as any).transaction().execute(async (trx: any) => {
      await trx(['SELECT 1'] as unknown);
      await trx.transaction().execute(async (trx2: any) => {
        await trx2(['SELECT 2'] as unknown);
      });
    });

    expect(logEntries).toHaveLength(2);
    expect(logEntries.map((e) => e.sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('logs transaction queries that fail with the query error', async () => {
    // #109: программный мок вместо ad-hoc failExecutor
    const db = createScriptedExecutor();
    db.expect('SELECT 1')
      .inTransaction()
      .throws(new Error('tx query rejected'));

    const logging = wrapExecutorWithLogging(db.executor, mockLogger);

    await expect(
      (logging as any).transaction().execute(async (trx: any) => {
        const q = trx(['SELECT 1'] as unknown);
        q.parameter('p', 'v');
        await q;
      }),
    ).rejects.toThrow('tx query rejected');

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].sql).toBe('SELECT 1');
    expect(logEntries[0].error?.message).toBe('tx query rejected');
  });

  it('logs queries whose transaction body later fails (rollback)', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    await expect(
      (logging as any).transaction().execute(async (trx: any) => {
        const q = trx(['UPDATE t SET x = 1'] as unknown);
        q.parameter('v', 2);
        await q;
        throw new Error('tx rollback');
      }),
    ).rejects.toThrow('tx rollback');

    // Сам запрос прошёл успешно — он залогирован без ошибки, несмотря на
    // последующий откат транзакции.
    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].sql).toBe('UPDATE t SET x = 1');
    expect(logEntries[0].maskedParams).toEqual({ v: '<number>' });
    expect(logEntries[0].error).toBeUndefined();
  });
});
