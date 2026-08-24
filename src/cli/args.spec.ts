import { describe, expect, it } from '@jest/globals';
import { CliArgsError, formatError, parseArgs } from './args.js';

describe('parseArgs (#103)', () => {
  it('parses command with positional and boolean flags', () => {
    const args = parseArgs(['migration:show', 'extra', '--json', '--verbose']);

    expect(args).toMatchObject({
      command: 'migration:show',
      positional: 'extra',
      json: true,
      verbose: true,
    });
  });

  it('parses --config/--dir values', () => {
    const args = parseArgs([
      '--config',
      'custom.config.ts',
      '--dir',
      './migrations',
      'migration:run',
    ]);

    expect(args.config).toBe('custom.config.ts');
    expect(args.dir).toBe('./migrations');
    expect(args.command).toBe('migration:run');
  });

  it('supports --flag=value syntax', () => {
    const args = parseArgs(['migration:run', '--dir=./db/migrations']);

    expect(args.dir).toBe('./db/migrations');
    expect(args.command).toBe('migration:run');
  });

  it('parses --output value for entity:diagram (#36)', () => {
    const args = parseArgs(['entity:diagram', '--output', './diagram.mmd']);

    expect(args.command).toBe('entity:diagram');
    expect(args.output).toBe('./diagram.mmd');
  });

  it('rejects --output without a value', () => {
    expect(() => parseArgs(['entity:diagram', '--output'])).toThrow(
      /Option --output requires a non-empty value/,
    );
  });

  it('rejects unknown flag instead of making it positional', () => {
    // Раньше `migration:create --nme foo` создавал миграцию с именем «--nme».
    expect(() => parseArgs(['migration:create', '--nme', 'foo'])).toThrow(
      CliArgsError,
    );
    expect(() => parseArgs(['migration:create', '--nme', 'foo'])).toThrow(
      /Unknown option: --nme/,
    );
  });

  it('rejects unknown short flag', () => {
    expect(() => parseArgs(['migration:run', '-x'])).toThrow(
      /Unknown option: -x/,
    );
  });

  it('rejects missing value at end of argv for value flags', () => {
    // Раньше `--config` без значения тихо откатывался к env/дефолту.
    expect(() => parseArgs(['migration:run', '--config'])).toThrow(
      /Option --config requires a non-empty value/,
    );
    expect(() => parseArgs(['migration:show', '--dir'])).toThrow(
      /Option --dir requires a non-empty value/,
    );
  });

  it('rejects empty string value', () => {
    expect(() => parseArgs(['migration:run', '--config', ''])).toThrow(
      /Option --config requires a non-empty value/,
    );
    expect(() => parseArgs(['migration:run', '--dir='])).toThrow(
      /Option --dir requires a non-empty value/,
    );
  });

  it('rejects whitespace-only value', () => {
    expect(() => parseArgs(['migration:run', '--dir', '   '])).toThrow(
      /Option --dir requires a non-empty value/,
    );
  });

  it('rejects next flag instead of treating it as value', () => {
    expect(() =>
      parseArgs(['migration:run', '--config', '--dir', './m']),
    ).toThrow(/Option --config requires a non-empty value/);
  });

  it('rejects extra positional arguments instead of ignoring them', () => {
    expect(() => parseArgs(['entity:create', 'user', 'photo'])).toThrow(
      CliArgsError,
    );
    expect(() => parseArgs(['entity:create', 'user', 'photo'])).toThrow(
      /Unexpected extra argument\(s\): photo/,
    );
  });

  it('recognizes -h/--help anywhere without a command', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['schema:verify', '--help']).help).toBe(true);
  });

  it('treats bare "-" as positional, not as an option', () => {
    const args = parseArgs(['-']);
    expect(args.command).toBe('-');
  });
});

describe('formatError (#103)', () => {
  it('keeps the message only by default', () => {
    const error = new Error('boom', { cause: new Error('root cause') });
    const out = formatError(error);

    expect(out).toContain('boom');
    expect(out).not.toContain('at '); // стек не печатается без verbose
  });

  it('preserves the cause chain by default', () => {
    // Раньше в catch печатался только error.message.
    const error = new Error('boom', {
      cause: new Error('middle', { cause: new Error('root') }),
    });

    expect(formatError(error)).toBe(
      ['boom', 'Caused by: middle', 'Caused by: root'].join('\n'),
    );
  });

  it('prints full stacks of every cause in verbose mode', () => {
    const root = new Error('root');
    const error = new Error('boom', { cause: root });
    const out = formatError(error, { verbose: true });

    expect(out).toContain('Error: boom');
    expect(out).toContain('Caused by: Error: root');
    expect(out).toMatch(/\n\s+at /); // реальные кадры стека сохранены
  });

  it('prints context lines first in verbose mode', () => {
    const out = formatError(new Error('boom'), {
      verbose: true,
      context: ['cwd: /tmp'],
    });

    expect(out).toMatch(/^\[ydb-orm\] cwd: \/tmp\n/);
  });

  it('formats non-error throwables', () => {
    expect(formatError('plain string')).toBe('Unexpected error: plain string');
    expect(formatError(undefined)).toBe('Unexpected error: undefined');
  });
});
