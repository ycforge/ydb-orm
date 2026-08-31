import { loadOptionalPeer } from '../core/optional-peer.js';
import type {
  YdbValidationProvider,
  YdbValidationOptions,
  YdbValidationErrorItem,
} from './ydb-validate.interface.js';

/**
 * Safe explicit default (#95): missing properties are validated.
 * Previously this was hardcoded to true — @IsNotEmpty/@IsDefined on
 * unfilled fields silently passed validation on save() of a new object.
 */
const DEFAULT_SKIP_MISSING_PROPERTIES = false;

/** Minimal structural slice of ValidationError from class-validator. */
interface ClassValidatorErrorLike {
  property?: string;
  value?: unknown;
  constraints?: Record<string, string>;
  children?: ClassValidatorErrorLike[];
  /** Real ValidationError has a human-readable toString(). */
  toString?: () => string;
}

/**
 * `YdbValidationProvider` backed by `class-validator` (optional peer
 * dependency). Translates class-validator's `ValidationError` tree into
 * the structured `YdbValidationErrorItem[]` format.
 */
export class ClassValidatorProvider implements YdbValidationProvider {
  private readonly groups?: string[];
  private readonly skipMissingProperties: boolean;

  constructor(options?: YdbValidationOptions) {
    this.groups = options?.groups;
    this.skipMissingProperties =
      options?.skipMissingProperties ?? DEFAULT_SKIP_MISSING_PROPERTIES;
  }

  async validate(entity: any): Promise<YdbValidationErrorItem[]> {
    // class-validator is an optional peer dependency
    const mod = await loadOptionalPeer<{
      validate: (
        object: object,
        options?: Record<string, unknown>,
      ) => Promise<ClassValidatorErrorLike[]>;
    }>('class-validator', 'ClassValidatorProvider');
    const validateFn = mod.validate;

    const errors = await validateFn(entity, {
      groups: this.groups,
      skipMissingProperties: this.skipMissingProperties,
    });

    if (!errors?.length) return [];

    const issues: YdbValidationErrorItem[] = [];
    collectIssues(errors, '', issues);
    return issues;
  }
}

/**
 * Flattens a ValidationError tree into a flat list of structured
 * errors: property (nesting via dot), constraint, message, value.
 */
function collectIssues(
  errors: ClassValidatorErrorLike[],
  prefix: string,
  out: YdbValidationErrorItem[],
): void {
  for (const error of errors ?? []) {
    const property = error.property
      ? prefix
        ? `${prefix}.${error.property}`
        : error.property
      : prefix;

    const constraints = error.constraints;
    const children = error.children;

    if (constraints) {
      for (const [constraint, message] of Object.entries(constraints)) {
        out.push({
          property,
          constraint,
          message: String(message),
          value: error.value,
        });
      }
    }

    if (children?.length) {
      collectIssues(children, property, out);
      continue;
    }

    // Neither constraints nor children: anomalous error format — don't drop it
    if (!constraints) {
      out.push({
        property,
        constraint: 'unknown',
        message: describeUnknownError(error),
        value: error.value,
      });
    }
  }
}

/** Safe serialization of an anomalous error without constraints. */
function describeUnknownError(error: ClassValidatorErrorLike): string {
  const text = error.toString?.();
  if (typeof text === 'string') return text;
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    return 'unknown validation error';
  }
}
