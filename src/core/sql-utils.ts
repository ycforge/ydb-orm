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
/**
 * Column type whitelist (@YdbColumn/@YdbPrimaryColumn). Mirrors the runtime
 * mapper coverage (`core/mapper.ts`) plus the TTL numeric types supported by
 * schema sync. A column type is the one metadata string that is interpolated
 * into DDL unquoted — it must be validated before it can ever reach SQL.
 */
export const COLUMN_TYPES = new Set<string>([
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
  // TTL numeric columns (see ttl.decorator.ts NUMERIC_TTL_TYPES): scheme-legal
  // types for columns declared via @YdbColumn in TTL entities.
  'Uint32',
  'Uint64',
  'DyNumber',
]);

export function validateColumnType(type: string): void {
  if (!COLUMN_TYPES.has(type)) {
    throw new Error(
      `@YdbColumn: invalid column type ${JSON.stringify(type)} — must be one of ` +
        `the YDB primitives${' '}or Uint32/Uint64/DyNumber (TTL numeric columns)`,
    );
  }
}

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
