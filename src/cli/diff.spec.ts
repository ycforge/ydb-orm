import { renderSchemaDiff, shouldUseColor } from './diff.js';
import type { YdbSchemaIssue } from '../schema/schema-sync.js';

/**
 * Спеки человекочитаемого diff-вывода расхождений схемы (#109): группировка
 * по таблицам, маркеры по видам issues, переформатирование «было → стало»,
 * отключение цвета (не-TTY поток и NO_COLOR — регрессия #103).
 */

const issue = (partial: Partial<YdbSchemaIssue>): YdbSchemaIssue => ({
  tableName: 't1',
  kind: 'missing-column',
  message: `Table "t1" is missing column "c"`,
  ...partial,
});

describe('shouldUseColor (#103)', () => {
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  it('цвет выключен для не-TTY потока', () => {
    const fakeStream = { isTTY: false } as unknown as NodeJS.WriteStream;
    delete process.env.NO_COLOR;
    expect(shouldUseColor(fakeStream)).toBe(false);
  });

  it('цвет включён только для TTY без NO_COLOR', () => {
    const ttyStream = { isTTY: true } as unknown as NodeJS.WriteStream;
    delete process.env.NO_COLOR;
    expect(shouldUseColor(ttyStream)).toBe(true);

    process.env.NO_COLOR = '1';
    expect(shouldUseColor(ttyStream)).toBe(false);
  });
});

describe('renderSchemaDiff', () => {
  it('группирует issues по таблицам с сохранением порядка', () => {
    const output = renderSchemaDiff(
      [
        issue({
          tableName: 'a',
          kind: 'missing-table',
          message: 'Table "a" does not exist',
        }),
        issue({ tableName: 'b' }),
        issue({ tableName: 'a' }),
      ],
      { color: false },
    );

    const lines = output.split('\n');
    // Группы в порядке первого появления; повторные issues той же таблицы
    // попадают в существующую группу (a: 2 шт., затем b)
    expect(lines[0]).toBe('a');
    expect(lines[1]).toContain('does not exist');
    expect(lines[2]).toContain('is missing column "c"');
    expect(lines[3]).toBe('b');
    expect(lines[4]).toContain('is missing column "c"');
  });

  it('маркеры соответствуют видам расхождений', () => {
    const output = renderSchemaDiff(
      [
        issue({
          kind: 'missing-column',
          message: 'Table "t" is missing column "c"',
        }),
        issue({
          kind: 'extra-column',
          tableName: 't',
          message: 'Table "t" has extra column "x"',
        }),
        issue({
          kind: 'primary-key-mismatch',
          tableName: 't',
          message: 'Table "t" primary key mismatch',
        }),
        issue({
          kind: 'ttl-missing',
          tableName: 't',
          message: 'Table "t" has no TTL, entity declares PT2H on column "c"',
        }),
      ],
      { color: false },
    );

    expect(output).toContain('  + ');
    expect(output).toContain('  - ');
    expect(output).toContain('  ! ');
    expect(output).not.toContain('undefined');
  });

  it('переформатирует type-mismatch как «было → стало»', () => {
    const output = renderSchemaDiff(
      [
        issue({
          kind: 'type-mismatch',
          message:
            'Table "t" column "age" type mismatch: expected Utf8, actual Int32',
        }),
      ],
      { color: false },
    );

    expect(output).toContain('column "age": Int32 → Utf8');
    expect(output).not.toContain('type mismatch:');
  });

  it('переформатирует index-columns-mismatch и ttl-mismatch так же', () => {
    const output = renderSchemaDiff(
      [
        issue({
          kind: 'index-columns-mismatch',
          message:
            'Table "t" index "i" columns mismatch: expected [a, b], actual [b, a]',
        }),
        issue({
          kind: 'ttl-mismatch',
          message:
            'Table "t" TTL mismatch: expected PT2H on column "c", actual P1D on column "c"',
        }),
      ],
      { color: false },
    );

    expect(output).toContain('index "i": [b, a] → [a, b]');
    expect(output).toContain('TTL: P1D on column "c" → PT2H on column "c"');
  });

  it('префикс таблицы убирается из текста issue', () => {
    const output = renderSchemaDiff(
      [
        issue({
          tableName: 'users',
          message: 'Table "users" is missing column "email"',
        }),
      ],
      { color: false },
    );
    expect(output).not.toContain('Table "users" is missing');
    expect(output).toContain('is missing column "email"');
  });

  it('пустой список issues — пустая строка', () => {
    expect(renderSchemaDiff([], { color: false })).toBe('');
  });

  it('с цветом текст обёрнут в ANSI-коды; без цвета — чистый текст', () => {
    const issues = [
      issue({ kind: 'missing-table', message: 'Table "t" does not exist' }),
    ];
    const plain = renderSchemaDiff(issues, { color: false });
    const colored = renderSchemaDiff(issues, { color: true });

    expect(colored).toContain('\x1b[31m✖\x1b[0m');
    expect(colored).toContain('\x1b[1m');
    expect(plain).not.toContain('\x1b[');
  });
});
