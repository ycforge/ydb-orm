import { quoteIdentifier, validateIdentifier } from './sql-utils.js';

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
