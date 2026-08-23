import type {
  YdbValidationIssue,
  YdbValidationErrorItem,
} from './ydb-validate.interface.js';

/**
 * Приводит результат провайдера валидации к структурному виду.
 * Строки (legacy-провайдеры до #95) теряют property/constraint —
 * сохраняются только в message.
 */
export function normalizeValidationIssues(
  issues: YdbValidationIssue[],
): YdbValidationErrorItem[] {
  return issues.map((issue) =>
    typeof issue === 'string'
      ? { property: '', constraint: '', message: issue }
      : issue,
  );
}

function formatIssue(issue: YdbValidationErrorItem): string {
  const property = issue.property ? `${issue.property}: ` : '';
  const constraint = issue.constraint ? ` [${issue.constraint}]` : '';
  return `${property}${issue.message}${constraint}`;
}

/**
 * Ошибка валидации сущности перед записью (#95).
 * Сохраняет структурированный список нарушений в `errors` —
 * исходное property/constraint/value не схлопываются в строку.
 */
export class YdbEntityValidationError extends Error {
  readonly entityName: string;
  readonly errors: YdbValidationErrorItem[];

  constructor(entityName: string, issues: YdbValidationIssue[]) {
    const errors = normalizeValidationIssues(issues);
    super(
      `Validation failed for ${entityName}: ${errors.map(formatIssue).join('; ')}`,
    );
    this.name = 'YdbEntityValidationError';
    this.entityName = entityName;
    this.errors = errors;
  }
}
