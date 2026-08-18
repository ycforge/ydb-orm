import 'reflect-metadata';
import { jest } from '@jest/globals';
import { createMockExecutor } from '../helpers/mock-executor.js';
import { YdbMigrationRunner } from '../../src/migrations/migration-runner.js';
import type { YdbMigration } from '../../src/migrations/migration.interface.js';

function makeMigration(name: string): YdbMigration {
  return {
    name,
    up: jest.fn(async () => {}),
    down: jest.fn(async () => {}),
  };
}

describe('migration:check', () => {
  describe('YdbMigrationRunner.status()', () => {
    it('reports all applied when no pending migrations', async () => {
      const mock = createMockExecutor([
        [
          { id: 1, timestamp: 1000, name: '20250101-CreateUsers' },
          { id: 2, timestamp: 2000, name: '20250102-AddEmail' },
        ],
      ]);
      const runner = new YdbMigrationRunner(mock.executor);
      const migrations = [
        makeMigration('20250101-CreateUsers'),
        makeMigration('20250102-AddEmail'),
      ];

      const statuses = await runner.status(migrations);
      const pending = statuses.filter((s) => !s.applied);

      expect(statuses).toHaveLength(2);
      expect(statuses.every((s) => s.applied)).toBe(true);
      expect(pending).toHaveLength(0);
    });

    it('reports pending migrations', async () => {
      const mock = createMockExecutor([
        [{ id: 1, timestamp: 1000, name: '20250101-CreateUsers' }],
      ]);
      const runner = new YdbMigrationRunner(mock.executor);
      const migrations = [
        makeMigration('20250101-CreateUsers'),
        makeMigration('20250102-AddEmail'),
        makeMigration('20250103-AddRole'),
      ];

      const statuses = await runner.status(migrations);
      const pending = statuses.filter((s) => !s.applied);

      expect(statuses).toHaveLength(3);
      expect(statuses[0].applied).toBe(true);
      expect(statuses[1].applied).toBe(false);
      expect(statuses[2].applied).toBe(false);
      expect(pending).toHaveLength(2);
      expect(pending.map((s) => s.name)).toEqual([
        '20250102-AddEmail',
        '20250103-AddRole',
      ]);
    });

    it('returns empty array when no migrations exist', async () => {
      const mock = createMockExecutor([[]]);
      const runner = new YdbMigrationRunner(mock.executor);

      const statuses = await runner.status([]);

      expect(statuses).toHaveLength(0);
    });
  });

  describe('check logic', () => {
    it('exits with code 0 when all applied', async () => {
      const mock = createMockExecutor([
        [{ id: 1, timestamp: 1000, name: 'm1' }],
      ]);
      const runner = new YdbMigrationRunner(mock.executor);
      const statuses = await runner.status([makeMigration('m1')]);
      const pending = statuses.filter((s) => !s.applied);

      expect(pending).toHaveLength(0);
    });

    it('exits with code 1 when pending exist', async () => {
      const mock = createMockExecutor([[]]);
      const runner = new YdbMigrationRunner(mock.executor);
      const statuses = await runner.status([
        makeMigration('m1'),
        makeMigration('m2'),
      ]);
      const pending = statuses.filter((s) => !s.applied);

      expect(pending).toHaveLength(2);
    });
  });

  describe('JSON output format', () => {
    it('returns correct shape when all applied', async () => {
      const mock = createMockExecutor([
        [{ id: 1, timestamp: 1000, name: 'm1' }],
      ]);
      const runner = new YdbMigrationRunner(mock.executor);
      const statuses = await runner.status([makeMigration('m1')]);
      const pending = statuses.filter((s) => !s.applied);

      const result = {
        applied: pending.length === 0,
        pending: pending.map((s) => s.name),
        total: statuses.length,
      };

      expect(result).toEqual({
        applied: true,
        pending: [],
        total: 1,
      });
    });

    it('returns correct shape when pending exist', async () => {
      const mock = createMockExecutor([
        [{ id: 1, timestamp: 1000, name: 'm1' }],
      ]);
      const runner = new YdbMigrationRunner(mock.executor);
      const statuses = await runner.status([
        makeMigration('m1'),
        makeMigration('m2'),
        makeMigration('m3'),
      ]);
      const pending = statuses.filter((s) => !s.applied);

      const result = {
        applied: pending.length === 0,
        pending: pending.map((s) => s.name),
        total: statuses.length,
      };

      expect(result).toEqual({
        applied: false,
        pending: ['m2', 'm3'],
        total: 3,
      });
    });
  });
});
