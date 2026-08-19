import { loadOptionalPeer } from '../core/optional-peer.js';
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
    // class-validator — опциональный peer dependency
    const mod = await loadOptionalPeer<{
      validate: (
        object: object,
        options?: Record<string, unknown>,
      ) => Promise<any[]>;
    }>('class-validator', 'ClassValidatorProvider');
    const validateFn = mod.validate;

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
