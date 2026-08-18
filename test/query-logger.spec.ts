import 'reflect-metadata';
import { jest } from '@jest/globals';
import { createMockExecutor } from './helpers/mock-executor.js';
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
    expect(logEntries[0].maskedParams).toEqual({ id: 'test' });
    expect(logEntries[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(logEntries[0].error).toBeUndefined();
  });

  it('logs failed query with error', async () => {
    const failExecutor: any = jest.fn(() => ({
      parameter: jest.fn().mockReturnThis(),
      timeout: jest.fn().mockReturnThis(),
      signal: jest.fn().mockReturnThis(),
      cancel: jest.fn().mockReturnThis(),
      then: (_onFulfilled: any, onRejected: any) =>
        Promise.reject(new Error('connection refused')).then(
          _onFulfilled,
          onRejected,
        ),
    }));
    failExecutor.transaction = () => ({
      execute: (fn: any) => fn(failExecutor),
    });

    const logging = wrapExecutorWithLogging(failExecutor, mockLogger);
    const q = logging(['SELECT 1'] as unknown as TemplateStringsArray);
    q.parameter('p', 'val');

    await expect(q).rejects.toThrow('connection refused');

    expect(logEntries).toHaveLength(1);
    expect(logEntries[0].error?.message).toBe('connection refused');
  });

  it('masks long string parameters', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('secret', 'a'.repeat(200));
    await q;

    expect(logEntries[0].maskedParams.secret).toBe('a'.repeat(64) + '...');
  });

  it('masks Uint8Array parameters', async () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    const q = logging(['INSERT INTO t'] as unknown as TemplateStringsArray);
    q.parameter('data', new Uint8Array([1, 2, 3]));
    await q;

    expect(logEntries[0].maskedParams.data).toBe('<bytes:3>');
  });

  it('passes through transaction method', () => {
    const mock = createMockExecutor([[]]);
    const logging = wrapExecutorWithLogging(mock.executor, mockLogger);

    expect(typeof (logging as any).transaction).toBe('function');
  });
});
