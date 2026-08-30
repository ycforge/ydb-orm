import { describe, expect, it } from '@jest/globals';
import {
  evaluateMigrationCheck,
  migrationStateExitCode,
  MIGRATION_STATE_EXIT_CODES,
} from './migration-check.js';
import type { YdbMigrationStatus } from './migration-runner.js';
import type { YdbSchemaIssue } from '../schema/schema-sync.js';

function status(
  overrides: Partial<YdbMigrationStatus> & { name: string },
): YdbMigrationStatus {
  return { applied: false, ...overrides };
}

const schemaIssues: YdbSchemaIssue[] = [
  {
    tableName: 'users',
    kind: 'missing-column',
    message: 'Table "users" is missing column "email"',
  },
];

describe('evaluateMigrationCheck (#152)', () => {
  it('ok when there are no migrations at all', () => {
    const verdict = evaluateMigrationCheck([]);

    expect(verdict.ready).toBe(true);
    expect(verdict.state).toBe('ok');
    expect(verdict.states).toEqual([]);
    expect(verdict.totalMigrations).toBe(0);
  });

  it('ok when every migration is applied', () => {
    const verdict = evaluateMigrationCheck([
      status({ name: 'a', applied: true }),
      status({ name: 'b', applied: true }),
    ]);

    expect(verdict.ready).toBe(true);
    expect(verdict.state).toBe('ok');
    expect(verdict.appliedCount).toBe(2);
    expect(verdict.totalMigrations).toBe(2);
  });

  it('pending state for unapplied migrations', () => {
    const verdict = evaluateMigrationCheck([
      status({ name: 'a', applied: true }),
      status({ name: 'b' }),
      status({ name: 'c' }),
    ]);

    expect(verdict.ready).toBe(false);
    expect(verdict.state).toBe('pending');
    expect(verdict.pending).toEqual(['b', 'c']);
    expect(migrationStateExitCode(verdict.state)).toBe(1);
  });

  it('interrupted (#101) is reported and blocks readiness', () => {
    const verdict = evaluateMigrationCheck([
      status({ name: 'a', applied: true, interrupted: true }),
    ]);

    // Прерванная миграция НЕ считается успешно применённой.
    expect(verdict.pending).toEqual([]);
    expect(verdict.interrupted).toEqual(['a']);
    expect(verdict.appliedCount).toBe(0);
    expect(verdict.ready).toBe(false);
    expect(verdict.state).toBe('interrupted');
    expect(migrationStateExitCode(verdict.state)).toBe(2);
  });

  it('modified after apply (#101) is its own state', () => {
    // #212: producer даёт applied=false для изменённой миграции.
    const verdict = evaluateMigrationCheck([
      status({ name: 'a', contentChanged: true }),
    ]);

    expect(verdict.modified).toEqual(['a']);
    expect(verdict.pending).toEqual([]);
    expect(verdict.interrupted).toEqual([]);
    expect(verdict.appliedCount).toBe(0);
    expect(verdict.ready).toBe(false);
    expect(verdict.state).toBe('modified');
    expect(migrationStateExitCode(verdict.state)).toBe(4);
  });

  it('#212: a content-changed migration can never satisfy the healthy-applied condition', () => {
    // Обе формы входа (новая from producer и legacy/ручная с applied=true)
    // дают один вердикт: не готово, state=modified, appliedCount=0.
    const inputs: YdbMigrationStatus[][] = [
      [status({ name: 'm', contentChanged: true })],
      [status({ name: 'm', applied: true, contentChanged: true })],
    ];

    for (const list of inputs) {
      expect(
        list[0].applied && !list[0].contentChanged && !list[0].interrupted,
      ).toBe(false);

      const verdict = evaluateMigrationCheck(list);
      expect(verdict.ready).toBe(false);
      expect(verdict.state).toBe('modified');
      expect(verdict.appliedCount).toBe(0);
      expect(verdict.modified).toEqual(['m']);
      expect(verdict.pending).toEqual([]);
    }
  });

  it('schema drift only when issues are passed', () => {
    const withoutSchema = evaluateMigrationCheck([
      status({ name: 'a', applied: true }),
    ]);
    expect(withoutSchema.ready).toBe(true);

    const drifted = evaluateMigrationCheck(
      [status({ name: 'a', applied: true })],
      { schemaIssues },
    );

    expect(drifted.ready).toBe(false);
    expect(drifted.state).toBe('schema-drift');
    expect(drifted.states).toEqual(['schema-drift']);
    expect(migrationStateExitCode(drifted.state)).toBe(3);
  });

  it('schema-drift is not detected when the issue list is empty', () => {
    const verdict = evaluateMigrationCheck(
      [status({ name: 'a', applied: true })],
      { schemaIssues: [] },
    );

    expect(verdict.ready).toBe(true);
    expect(verdict.states).toEqual([]);
  });

  it('orphan records are informational: they do not break readiness by themselves', () => {
    const verdict = evaluateMigrationCheck([
      status({ name: 'a', applied: true }),
      status({ name: 'gone', applied: true, orphan: true }),
    ]);

    expect(verdict.orphaned).toEqual(['gone']);
    expect(verdict.ready).toBe(true);
    expect(verdict.totalMigrations).toBe(1);
  });

  it('interrupted orphan record still blocks (#101): file removed mid-run', () => {
    const verdict = evaluateMigrationCheck([
      status({
        name: 'halfway',
        applied: true,
        orphan: true,
        interrupted: true,
      }),
    ]);

    expect(verdict.orphaned).toContain('halfway');
    expect(verdict.interrupted).toEqual(['halfway']);
    expect(verdict.ready).toBe(false);
    expect(verdict.state).toBe('interrupted');
  });

  it('priority: interrupted > modified > pending > schema-drift', () => {
    const all = evaluateMigrationCheck(
      [
        status({ name: 'p' }),
        status({ name: 'i', applied: true, interrupted: true }),
        status({ name: 'm', contentChanged: true }),
      ],
      { schemaIssues },
    );

    expect(all.states).toEqual([
      'interrupted',
      'modified',
      'pending',
      'schema-drift',
    ]);
    expect(all.state).toBe('interrupted');
    expect(MIGRATION_STATE_EXIT_CODES[all.state]).toBe(2);

    expect(
      evaluateMigrationCheck([
        status({ name: 'p' }),
        status({ name: 'm', contentChanged: true }),
      ]).state,
    ).toBe('modified');

    expect(
      evaluateMigrationCheck([status({ name: 'p' })], { schemaIssues }).state,
    ).toBe('pending');
  });
});
