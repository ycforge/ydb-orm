import type {
  YdbValidationIssue,
  YdbValidationErrorItem,
} from './ydb-validate.interface.js';

/**
 * Converts validation provider result to structured form.
 * Strings (legacy providers before #95) lose property/constraint —
 * only message is preserved.
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
 * Entity validation error before write (#95).
 * Preserves structured list of violations in `errors` —
 * original property/constraint/value are not collapsed into a string.
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
