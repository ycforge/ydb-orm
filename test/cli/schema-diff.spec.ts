import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import {
  diffSchemas,
  ExpectedTableSchema,
  YdbTableDescription,
} from '../../src/schema/schema-sync.js';
import { renderSchemaDiff, shouldUseColor } from '../../src/cli/diff.js';
import type { YdbSchemaIssue } from '../../src/schema/schema-sync.js';

// ESC-последовательности ANSI: через fromCharCode, чтобы не триггерить no-control-regex
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[\\d+m', 'g');

function makeExpected(): ExpectedTableSchema {
  return {
    tableName: 'users',
    columns: { uuid: 'Uuid', name: 'Utf8', age: 'Int32', email: 'Utf8' },
    primaryKey: ['uuid'],
    indexes: [],
  };
}

function makeExisting(): YdbTableDescription {
  return {
    columns: new Map<string, Type_PrimitiveTypeId>([
      ['uuid', Type_PrimitiveTypeId.UUID],
      // name отсутствует → missing-column
      ['age', Type_PrimitiveTypeId.INT64], // type-mismatch
      ['legacy', Type_PrimitiveTypeId.UTF8], // extra-column
    ]),
    primaryKey: ['uuid'],
    indexes: [],
  };
}

describe('renderSchemaDiff', () => {
  it('groups issues by table and renders markers', () => {
    const issues: YdbSchemaIssue[] = [
      {
        tableName: 'users',
        kind: 'missing-column',
        message: 'Table "users" is missing column "name"',
      },
      {
        tableName: 'users',
        kind: 'extra-column',
        message: 'Table "users" has extra column "legacy"',
      },
      {
        tableName: 'photos',
        kind: 'missing-table',
        message: 'Table "photos" does not exist',
      },
    ];

    const out = renderSchemaDiff(issues, { color: false });

    const lines = out.split('\n');
    expect(lines[0]).toBe('users');
    expect(lines[1]).toContain('+ is missing column "name"');
    expect(lines[2]).toContain('- has extra column "legacy"');
    expect(lines[3]).toBe('photos');
    expect(lines[4]).toContain('✖ does not exist');
  });

  it('renders type-mismatch as "actual → expected"', () => {
    const issues: YdbSchemaIssue[] = [
      {
        tableName: 'users',
        kind: 'type-mismatch',
        message:
          'Table "users" column "age" type mismatch: expected Int32, actual Int64',
      },
    ];

    const out = renderSchemaDiff(issues, { color: false });

    expect(out).toContain('~ column "age": Int64 → Int32');
  });

  it('renders index-columns-mismatch as "actual → expected"', () => {
    const issues: YdbSchemaIssue[] = [
      {
        tableName: 'users',
        kind: 'index-columns-mismatch',
        message:
          'Table "users" index "users__name_age" columns mismatch: ' +
          'expected [name, age], actual [age, name]',
      },
    ];

    const out = renderSchemaDiff(issues, { color: false });

    expect(out).toContain(
      '~ index "users__name_age": [age, name] → [name, age]',
    );
  });

  it('renders unique-mismatch and TTL issues (#88)', () => {
    const issues: YdbSchemaIssue[] = [
      {
        tableName: 'users',
        kind: 'unique-mismatch',
        message:
          'Table "users" index "users__name" unique flag mismatch: ' +
          'expected false, actual true',
      },
      {
        tableName: 'sessions',
        kind: 'ttl-missing',
        message:
          'Table "sessions" has no TTL, entity declares PT2H on column "expires_at"',
      },
      {
        tableName: 'sessions',
        kind: 'ttl-mismatch',
        message:
          'Table "sessions" TTL mismatch: expected PT2H on column "expires_at", ' +
          'actual PT1H on column "expires_at"',
      },
      {
        tableName: 'legacy',
        kind: 'ttl-extra',
        message:
          'Table "legacy" has TTL PT1H on column "created_at" not present in entity',
      },
    ];

    const out = renderSchemaDiff(issues, { color: false });
    const lines = out.split('\n');

    expect(lines[1]).toContain('~ index "users__name" unique flag mismatch');
    expect(lines[3]).toContain('+ has no TTL, entity declares PT2H');
    expect(lines[4]).toContain(
      '~ TTL: PT1H on column "expires_at" → PT2H on column "expires_at"',
    );
    expect(lines[6]).toContain(
      '- has TTL PT1H on column "created_at" not present in entity',
    );
  });

  it('adds ANSI codes when color is enabled', () => {
    const issues: YdbSchemaIssue[] = [
      {
        tableName: 'users',
        kind: 'type-mismatch',
        message:
          'Table "users" column "age" type mismatch: expected Int32, actual Int64',
      },
    ];

    const out = renderSchemaDiff(issues, { color: true });

    expect(out).toMatch(ANSI_RE);
    expect(out).toContain('\x1b[31m'); // mismatch — красный
    // stripped-версия совпадает с вариантом без цвета
    const stripped = out.replace(ANSI_RE, '');
    expect(stripped).toBe(renderSchemaDiff(issues, { color: false }));
  });

  it('uses different colors for missing and extra issues', () => {
    const issues: YdbSchemaIssue[] = [
      {
        tableName: 'users',
        kind: 'missing-column',
        message: 'Table "users" is missing column "name"',
      },
      {
        tableName: 'users',
        kind: 'extra-column',
        message: 'Table "users" has extra column "legacy"',
      },
    ];

    const out = renderSchemaDiff(issues, { color: true });

    expect(out).toContain('\x1b[33m+\x1b[0m'); // missing — жёлтый
    expect(out).toContain('\x1b[90m-\x1b[0m'); // extra — серый
  });
});

describe('diffSchemas + renderSchemaDiff (schema:verify output)', () => {
  it('produces issues rendered by the diff printer', () => {
    const issues = diffSchemas(
      [makeExpected(), { ...makeExpected(), tableName: 'photos' }],
      [makeExisting(), null],
    );

    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain('missing-column');
    expect(kinds).toContain('type-mismatch');
    expect(kinds).toContain('extra-column');
    expect(kinds).toContain('missing-table');

    const out = renderSchemaDiff(issues, { color: false });
    expect(out).toContain('users');
    expect(out).toContain('photos');
    expect(out).toContain('~ column "age": Int64 → Int32');
  });

  it('reports index-columns-mismatch for same-name index with reordered columns', () => {
    const expected: ExpectedTableSchema = {
      ...makeExpected(),
      indexes: [
        { name: 'users__name_age', columns: ['name', 'age'], unique: false },
      ],
    };
    const existing: YdbTableDescription = {
      ...makeExisting(),
      indexes: [
        { name: 'users__name_age', columns: ['age', 'name'], unique: false },
      ],
    };

    const issues = diffSchemas([expected], [existing]);

    const mismatch = issues.find((i) => i.kind === 'index-columns-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch?.message).toContain('expected [name, age]');
    expect(mismatch?.message).toContain('actual [age, name]');

    const out = renderSchemaDiff(issues, { color: false });
    expect(out).toContain(
      '~ index "users__name_age": [age, name] → [name, age]',
    );
  });

  it('reports reordered composite PK as a primary-key order mismatch (#89)', () => {
    const expected: ExpectedTableSchema = {
      tableName: 'tenant_users',
      columns: { tenant_id: 'Utf8', uuid: 'Uuid' },
      primaryKey: ['tenant_id', 'uuid'],
      indexes: [],
    };
    const existing: YdbTableDescription = {
      columns: new Map<string, Type_PrimitiveTypeId>([
        ['tenant_id', Type_PrimitiveTypeId.UTF8],
        ['uuid', Type_PrimitiveTypeId.UUID],
      ]),
      // Порядок переставлен: [tenant, id] и [id, tenant] — разные схемы
      primaryKey: ['uuid', 'tenant_id'],
      indexes: [],
    };

    const issues = diffSchemas([expected], [existing]);

    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('primary-key-mismatch');
    expect(issues[0].message).toBe(
      'Table "tenant_users" primary key column order mismatch: ' +
        'expected [tenant_id, uuid], actual [uuid, tenant_id]',
    );

    const out = renderSchemaDiff(issues, { color: false });
    expect(out).toContain(
      '! primary key column order mismatch: ' +
        'expected [tenant_id, uuid], actual [uuid, tenant_id]',
    );
  });
});

describe('shouldUseColor', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    jest.restoreAllMocks();
  });

  it('is disabled when NO_COLOR is set', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    process.env.NO_COLOR = '1';

    expect(shouldUseColor()).toBe(false);
  });

  it('is disabled when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: undefined,
      configurable: true,
    });
    delete process.env.NO_COLOR;

    expect(shouldUseColor()).toBe(false);
  });

  it('is enabled for a TTY without NO_COLOR', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    delete process.env.NO_COLOR;

    expect(shouldUseColor()).toBe(true);
  });

  it('decides by the passed stream, not always stdout (#103)', () => {
    // schema:verify пишет расхождения в stderr: при pipe stdout
    // (`yorm schema:verify | cat`) цвет должен решаться по stderr.
    const ttyStderr = { isTTY: true } as unknown as NodeJS.WriteStream;
    const pipedStdout = { isTTY: false } as unknown as NodeJS.WriteStream;

    expect(shouldUseColor(ttyStderr)).toBe(true);
    expect(shouldUseColor(pipedStdout)).toBe(false);
  });

  it('renderSchemaDiff colors by the target stream (#103)', () => {
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: undefined,
      configurable: true,
    });
    const issues = diffSchemas([makeExpected()], [makeExisting()]);

    // stderr остался TTY, хотя stdout перенаправлен — цвет включается.
    const colored = renderSchemaDiff(issues, {
      stream: { isTTY: true } as unknown as NodeJS.WriteStream,
    });
    expect(colored).toMatch(ANSI_RE);

    const plain = renderSchemaDiff(issues, {
      stream: { isTTY: false } as unknown as NodeJS.WriteStream,
    });
    expect(plain).not.toMatch(ANSI_RE);
  });

  it('renderSchemaDiff without options emits no ANSI when NO_COLOR is set', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    process.env.NO_COLOR = '1';

    const out = renderSchemaDiff([
      {
        tableName: 'users',
        kind: 'missing-table',
        message: 'Table "users" does not exist',
      },
    ]);

    expect(out).not.toMatch(ANSI_RE);
  });
});
