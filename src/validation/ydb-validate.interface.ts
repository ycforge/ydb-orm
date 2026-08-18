export interface YdbValidationProvider {
  validate(entity: any): Promise<string[]>;
}

export interface YdbValidationOptions {
  groups?: string[];
}
