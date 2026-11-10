import {
  quoteIdentifier,
  validateColumnType,
  validateIdentifier,
  validateTableName,
} from './sql-utils.js';

describe('quoteIdentifier', () => {
  it('wraps a valid identifier in backticks', () => {
    expect(quoteIdentifier('users')).toBe('`users`');
  });

  it('handles snake_case identifiers', () => {
    expect(quoteIdentifier('email_encrypted')).toBe('`email_encrypted`');
  });

  it('handles identifiers starting with underscore', () => {
    expect(quoteIdentifier('_bi')).toBe('`_bi`');
  });

  it('handles single-char identifiers', () => {
    expect(quoteIdentifier('a')).toBe('`a`');
  });

  it('throws on identifier with spaces', () => {
    expect(() => quoteIdentifier('my table')).toThrow(/Invalid SQL identifier/);
  });

  it('throws on identifier with special characters', () => {
    expect(() => quoteIdentifier('col-name')).toThrow(/Invalid SQL identifier/);
  });

  it('throws on identifier starting with digit', () => {
    expect(() => quoteIdentifier('1col')).toThrow(/Invalid SQL identifier/);
  });

  it('throws on empty string', () => {
    expect(() => quoteIdentifier('')).toThrow(/Invalid SQL identifier/);
  });
});

describe('validateIdentifier', () => {
  it('does not throw for valid identifiers', () => {
    expect(() => validateIdentifier('users', 'table')).not.toThrow();
    expect(() => validateIdentifier('_private', 'column')).not.toThrow();
    expect(() => validateIdentifier('col123', 'field')).not.toThrow();
  });

  it('throws for invalid identifiers with context message', () => {
    expect(() => validateIdentifier('1bad', 'column')).toThrow(
      /Invalid SQL identifier for column/,
    );
  });
});

describe('validateColumnType (injection whitelist, #238)', () => {
  it('accepts YDB primitive types', () => {
    for (const type of [
      'Uuid',
      'Utf8',
      'Bytes',
      'Int32',
      'Int64',
      'Bool',
      'Double',
      'Float',
      'Date',
      'Datetime',
      'Timestamp',
      'Json',
      'JsonDocument',
    ]) {
      expect(() => validateColumnType(type)).not.toThrow();
    }
  });

  it('accepts the TTL numeric scheme types', () => {
    expect(() => validateColumnType('Uint32')).not.toThrow();
    expect(() => validateColumnType('Uint64')).not.toThrow();
    expect(() => validateColumnType('DyNumber')).not.toThrow();
  });

  it('throws for a non-whitelisted type string', () => {
    // The column type is interpolated into DDL unquoted — quotes/semicolons
    // must never survive validation.
    expect(() => validateColumnType('Utf8, PRIMARY KEY (`x`) --')).toThrow(
      /invalid column type/,
    );
    expect(() => validateColumnType('Utf8; DROP TABLE x')).toThrow(
      /invalid column type/,
    );
    expect(() => validateColumnType('')).toThrow(/invalid column type/);
  });
});

describe('validateTableName (fail-fast policy)', () => {
  it('throws for SQL injection shaped names', () => {
    expect(() => validateTableName('users`; DROP TABLE secrets')).toThrow(
      /invalid table name/,
    );
    expect(() => validateTableName('users--')).toThrow(/invalid table name/);
  });
});
