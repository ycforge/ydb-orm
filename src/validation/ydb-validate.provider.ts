import type {
  YdbValidationProvider,
  YdbValidationOptions,
} from './ydb-validate.interface.js';

export class ClassValidatorProvider implements YdbValidationProvider {
  private readonly groups?: string[];

  constructor(options?: YdbValidationOptions) {
    this.groups = options?.groups;
  }

  async validate(entity: any): Promise<string[]> {
    let validateFn: (
      object: object,
      options?: Record<string, unknown>,
    ) => Promise<any[]>;
    try {
      // class-validator — опциональный peer dependency
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const loader = new Function(
        'return import("class-validator")',
      ) as () => Promise<{
        validate: typeof validateFn;
      }>;
      const mod = await loader();
      validateFn = mod.validate;
    } catch {
      throw new Error(
        'class-validator is not installed. Install it to use ClassValidatorProvider: npm install class-validator reflect-metadata',
      );
    }

    const errors = await validateFn(entity, {
      groups: this.groups,
      skipMissingProperties: true,
    });

    if (!errors.length) return [];

    const messages: string[] = [];
    for (const error of errors) {
      for (const constraint of Object.values(error.constraints ?? {})) {
        messages.push(String(constraint));
      }
    }
    return messages;
  }
}
