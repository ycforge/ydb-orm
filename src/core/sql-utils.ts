const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIdentifier(name: string, context: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid SQL identifier for ${context}: ${name}`);
  }
}

/** Экранирование идентификаторов YQL (backticks) */
export function quoteIdentifier(name: string): string {
  validateIdentifier(name, 'identifier');
  return `\`${name}\``;
}
