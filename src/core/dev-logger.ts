/**
 * Framework-neutral core logger.
 *
 * Used where Logger from @nestjs/common was previously used (schema
 * sync etc.), so the main package doesn't depend on NestJS. Output format
 * is close to Nest-style: `[<context>] message`.
 */
export class YdbDevLogger {
  constructor(private readonly context: string) {}

  private format(message: unknown): string {
    return `[${this.context}] ${String(message)}`;
  }

  log(message: unknown): void {
    console.log(this.format(message));
  }

  warn(message: unknown): void {
    console.warn(this.format(message));
  }
}
