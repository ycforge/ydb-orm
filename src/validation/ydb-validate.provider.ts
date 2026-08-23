import { loadOptionalPeer } from '../core/optional-peer.js';
import type {
  YdbValidationProvider,
  YdbValidationOptions,
  YdbValidationErrorItem,
} from './ydb-validate.interface.js';

/**
 * Безопасный явный дефолт (#95): отсутствующие свойства валидируются.
 * Раньше здесь было жёстко зашито true — @IsNotEmpty/@IsDefined на
 * незаполненных полях молча проходили валидацию при save() нового объекта.
 */
const DEFAULT_SKIP_MISSING_PROPERTIES = false;

/** Минимальный структурный срез ValidationError из class-validator. */
interface ClassValidatorErrorLike {
  property?: string;
  value?: unknown;
  constraints?: Record<string, string>;
  children?: ClassValidatorErrorLike[];
  /** У настоящей ValidationError есть toString() с человекочитаемым текстом. */
  toString?: () => string;
}

export class ClassValidatorProvider implements YdbValidationProvider {
  private readonly groups?: string[];
  private readonly skipMissingProperties: boolean;

  constructor(options?: YdbValidationOptions) {
    this.groups = options?.groups;
    this.skipMissingProperties =
      options?.skipMissingProperties ?? DEFAULT_SKIP_MISSING_PROPERTIES;
  }

  async validate(entity: any): Promise<YdbValidationErrorItem[]> {
    // class-validator — опциональный peer dependency
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
 * Разворачивает дерево ValidationError в плоский список структурированных
 * ошибок: property (вложенность — через точку), constraint, message, value.
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

    // Ни constraints, ни children: аномальный формат ошибки — не теряем её
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

/** Безопасная сериализация аномальной ошибки без constraints. */
function describeUnknownError(error: ClassValidatorErrorLike): string {
  const text = error.toString?.();
  if (typeof text === 'string') return text;
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    return 'unknown validation error';
  }
}
