const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIdentifier(name: string, context: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid SQL identifier for ${context}: ${name}`);
  }
}

/**
 * Entity table name validation (@YdbEntity). Same rules as
 * quoteIdentifier: ASCII letters/digits/underscore, first character must be
 * a letter or underscore. Called in the decorator, so an invalid name fails
 * at module load — before it's used for DescribeTable or DDL (#91).
 */
export function validateTableName(name: string): void {
  if (typeof name !== 'string' || !IDENTIFIER_REGEX.test(name)) {
    throw new Error(
      `@YdbEntity: invalid table name ${JSON.stringify(name)} — ` +
        `must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (ASCII letters, digits, underscore)`,
    );
  }
}

/** YQL identifier escaping (backticks) */
export function quoteIdentifier(name: string): string {
  validateIdentifier(name, 'identifier');
  return `\`${name}\``;
}
