/**
 * Каркасно-нейтральный логгер ядра.
 *
 * Используется там, где раньше применялся Logger из @nestjs/common (schema
 * sync и т.п.), чтобы основной пакет не зависел от NestJS. Формат вывода
 * близок к Nest-style: `[<context>] сообщение`.
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
