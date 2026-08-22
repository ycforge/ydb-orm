const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIdentifier(name: string, context: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid SQL identifier for ${context}: ${name}`);
  }
}

/**
 * Валидация имени таблицы сущности (@YdbEntity). Правила те же, что и у
 * quoteIdentifier: ASCII-буквы/цифры/подчёркивание, первый символ — буква
 * или подчёркивание. Вызывается в декораторе, поэтому невалидное имя
 * падает при загрузке модуля — до того, как из него соберут путь для
 * DescribeTable или DDL (#91).
 */
export function validateTableName(name: string): void {
  if (typeof name !== 'string' || !IDENTIFIER_REGEX.test(name)) {
    throw new Error(
      `@YdbEntity: invalid table name ${JSON.stringify(name)} — ` +
        `must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (ASCII letters, digits, underscore)`,
    );
  }
}

/** Экранирование идентификаторов YQL (backticks) */
export function quoteIdentifier(name: string): string {
  validateIdentifier(name, 'identifier');
  return `\`${name}\``;
}
