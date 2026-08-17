import { jest } from '@jest/globals';
import { YdbMigration, executeSql } from './migration.interface.js';
import { YdbMigrationRunner } from './migration-runner.js';
import {
  createMockExecutor,
  MockExecutor,
} from '../../test/helpers/mock-executor.js';

const migration = (name: string) => {
  const up = jest.fn(async (executor: unknown) => {
    await executeSql(executor as any, `UP ${name}`);
  });
  const down = jest.fn(async (executor: unknown) => {
    await executeSql(executor as any, `DOWN ${name}`);
  });
  return { migration: { name, up, down } as YdbMigration, up, down };
};

const sqlLog = (mock: MockExecutor) => mock.queries.map((q) => q.sql);

describe('YdbMigrationRunner', () => {
  it('creates the migrations bookkeeping table', async () => {
    const mock = createMockExecutor([[]]);
    const runner = new YdbMigrationRunner(mock.executor);

    await runner.getAppliedMigrations();

    expect(sqlLog(mock)[0]).toContain(
      'CREATE TABLE IF NOT EXISTS `ydb_migrations`',
    );
    expect(sqlLog(mock)[0]).toContain('PRIMARY KEY (`id`)');
  });

  it('runs pending migrations in order and records them', async () => {
    const mock = createMockExecutor([[]]);
    const runner = new YdbMigrationRunner(mock.executor);
    const m1 = migration('1-First');
    const m2 = migration('2-Second');

    const executed = await runner.run([m1.migration, m2.migration]);

    expect(executed).toEqual(['1-First', '2-Second']);
    expect(m1.up).toHaveBeenCalled();
    expect(m2.up).toHaveBeenCalled();

    const inserts = mock.queries.filter((q) =>
      q.sql.startsWith('INSERT INTO `ydb_migrations`'),
    );
    expect(inserts).toHaveLength(2);
    expect((inserts[0].params.name as any).value).toBe('1-First');
    expect((inserts[1].params.name as any).value).toBe('2-Second');
    // id инкрементируется
    expect(Number((inserts[0].params.id as any).value)).toBe(1);
    expect(Number((inserts[1].params.id as any).value)).toBe(2);
  });

  it('skips already applied migrations', async () => {
    const mock = createMockExecutor([
      [{ id: 1n, timestamp: 1000n, name: '1-First' }],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);
    const m1 = migration('1-First');
    const m2 = migration('2-Second');

    const executed = await runner.run([m1.migration, m2.migration]);

    expect(executed).toEqual(['2-Second']);
    expect(m1.up).not.toHaveBeenCalled();
    expect(m2.up).toHaveBeenCalled();

    // следующий id = max(id) + 1
    const insert = mock.queries.find((q) =>
      q.sql.startsWith('INSERT INTO `ydb_migrations`'),
    );
    expect(Number((insert!.params.id as any).value)).toBe(2);
  });

  it('reverts the last applied migration', async () => {
    const mock = createMockExecutor([
      [
        { id: 1n, timestamp: 1000n, name: '1-First' },
        { id: 2n, timestamp: 2000n, name: '2-Second' },
      ],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);
    const m1 = migration('1-First');
    const m2 = migration('2-Second');

    const reverted = await runner.revert([m1.migration, m2.migration]);

    expect(reverted).toBe('2-Second');
    expect(m2.down).toHaveBeenCalled();
    expect(m1.down).not.toHaveBeenCalled();

    const del = mock.queries.find((q) =>
      q.sql.startsWith('DELETE FROM `ydb_migrations`'),
    );
    expect(del).toBeDefined();
    expect(Number((del!.params.id as any).value)).toBe(2);
  });

  it('returns null when there is nothing to revert', async () => {
    const mock = createMockExecutor([[]]);
    const runner = new YdbMigrationRunner(mock.executor);

    const reverted = await runner.revert([migration('1-First').migration]);

    expect(reverted).toBeNull();
  });

  it('fails to revert when the migration file is missing', async () => {
    const mock = createMockExecutor([
      [{ id: 1n, timestamp: 1000n, name: '1-Ghost' }],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);

    await expect(
      runner.revert([migration('2-Other').migration]),
    ).rejects.toThrow(/Migration file for "1-Ghost" not found/);
  });

  it('reports status for all migrations', async () => {
    const mock = createMockExecutor([
      [{ id: 1n, timestamp: 1000n, name: '1-First' }],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);

    const statuses = await runner.status([
      migration('1-First').migration,
      migration('2-Second').migration,
    ]);

    expect(statuses).toEqual([
      { name: '1-First', applied: true, appliedAt: new Date(1000) },
      { name: '2-Second', applied: false, appliedAt: undefined },
    ]);
  });

  it('throws when migration has no name', async () => {
    const mock = createMockExecutor([[]]);
    const runner = new YdbMigrationRunner(mock.executor);
    const nameless: YdbMigration = {
      up: jest.fn(async () => {}),
      down: jest.fn(async () => {}),
    };

    await expect(runner.run([nameless])).rejects.toThrow(/has no name/);
  });
});
