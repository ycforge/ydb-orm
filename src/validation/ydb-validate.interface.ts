/**
 * Structured validation error for a single entity property.
 * Preserves property/constraint for machine processing (e.g.,
 * mapping to HTTP 400) — unlike a flat string list (#95).
 */
export interface YdbValidationErrorItem {
  /** Name of the entity property that failed validation (empty if the provider does not report it). */
  property: string;
  /** Violation type: the constraint key (e.g. 'isNotEmpty', 'minLength'). */
  constraint: string;
  /** Human-readable error message. */
  message: string;
  /** Value of the property at validation time (context; not included in message). */
  value?: unknown;
}

/**
 * Validation provider result item.
 * String — legacy format (backward compatibility with providers before #95),
 * object — structured format.
 */
export type YdbValidationIssue = string | YdbValidationErrorItem;

export interface YdbValidationProvider {
  /**
   * Validates an entity and returns a list of violations.
   * Empty array — entity is valid.
   */
  validate(entity: any): Promise<YdbValidationIssue[]>;
}

export interface YdbValidationOptions {
  groups?: string[];
  /**
   * Skip validation of missing (undefined/null) properties.
   *
   * Defaults to `false` — safe explicit default (#95): on save()
   * of a new object, @IsNotEmpty/@IsDefined on unfilled fields
   * will fail validation. `true` restores pre-#95 behavior
   * (this value was previously hardcoded).
   */
  skipMissingProperties?: boolean;
}
