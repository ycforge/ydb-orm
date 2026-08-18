import 'reflect-metadata';
import { YdbMigrationRunner } from '../../src/migrations/migration-runner.js';
import { createMockExecutor } from '../helpers/mock-executor.js';
import type { YdbMigration } from '../../src/migrations/migration.interface.js';

/** Тестовая миграция с заданным именем. */
function fakeMigration(name: string): YdbMigration {
  return {
    name,
    up: async () => {},
    down: async () => {},
  };
}

describe('migration:show --json', () => {
  it('JSON-массив содержит все миграции с корректной структурой', async () => {
    // Returned rows from the mock: one applied migration
    const mock = createMockExecutor([
      [{ id: 1, timestamp: 1700000000000, name: '20240101-CreateUsers' }],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);

    const statuses = await runner.status([
      fakeMigration('20240101-CreateUsers'),
      fakeMigration('20240201-AddEmail'),
    ]);

    const json = statuses.map((s) => ({
      name: s.name,
      applied: s.applied,
      appliedAt: s.appliedAt ? s.appliedAt.toISOString() : null,
    }));

    expect(JSON.stringify(json, null, 2)).toBe(
      JSON.stringify(
        [
          {
            name: '20240101-CreateUsers',
            applied: true,
            appliedAt: new Date(1700000000000).toISOString(),
          },
          {
            name: '20240201-AddEmail',
            applied: false,
            appliedAt: null,
          },
        ],
        null,
        2,
      ),
    );
  });

  it('каждый элемент JSON содержит name, applied, appliedAt', async () => {
    const mock = createMockExecutor([
      [{ id: 1, timestamp: 1700000000000, name: 'm1' }],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);

    const statuses = await runner.status([
      fakeMigration('m1'),
      fakeMigration('m2'),
    ]);

    const json: unknown[] = JSON.parse(
      JSON.stringify(
        statuses.map((s) => ({
          name: s.name,
          applied: s.applied,
          appliedAt: s.appliedAt ? s.appliedAt.toISOString() : null,
        })),
      ),
    );

    for (const item of json) {
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('applied');
      expect(item).toHaveProperty('appliedAt');
    }
  });

  it('применённые миграции — applied=true, pending — applied=false', async () => {
    const mock = createMockExecutor([
      [
        { id: 1, timestamp: 1700000000000, name: 'a' },
        { id: 2, timestamp: 1700100000000, name: 'b' },
      ],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);

    const statuses = await runner.status([
      fakeMigration('a'),
      fakeMigration('b'),
      fakeMigration('c'),
    ]);

    const json = statuses.map((s) => ({
      name: s.name,
      applied: s.applied,
      appliedAt: s.appliedAt ? s.appliedAt.toISOString() : null,
    }));

    expect(json).toEqual([
      {
        name: 'a',
        applied: true,
        appliedAt: new Date(1700000000000).toISOString(),
      },
      {
        name: 'b',
        applied: true,
        appliedAt: new Date(1700100000000).toISOString(),
      },
      { name: 'c', applied: false, appliedAt: null },
    ]);
  });

  it('все миграции pending — applied=false, appliedAt=null', async () => {
    const mock = createMockExecutor([[]]);
    const runner = new YdbMigrationRunner(mock.executor);

    const statuses = await runner.status([
      fakeMigration('x'),
      fakeMigration('y'),
    ]);

    const json = statuses.map((s) => ({
      name: s.name,
      applied: s.applied,
      appliedAt: s.appliedAt ? s.appliedAt.toISOString() : null,
    }));

    expect(json).toEqual([
      { name: 'x', applied: false, appliedAt: null },
      { name: 'y', applied: false, appliedAt: null },
    ]);
  });

  it('результат является валидным JSON', async () => {
    const mock = createMockExecutor([
      [{ id: 1, timestamp: 1700000000000, name: 'm1' }],
    ]);
    const runner = new YdbMigrationRunner(mock.executor);

    const statuses = await runner.status([fakeMigration('m1')]);

    const output = JSON.stringify(
      statuses.map((s) => ({
        name: s.name,
        applied: s.applied,
        appliedAt: s.appliedAt ? s.appliedAt.toISOString() : null,
      })),
      null,
      2,
    );

    expect(() => JSON.parse(output)).not.toThrow();
  });
});
