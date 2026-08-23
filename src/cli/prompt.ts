/**
 * Минималистичные интерактивные подсказки для CLI (#24) на node:readline —
 * без внешних зависимостей.
 *
 * Строки ввода собираются в очередь независимо от того, задан ли в момент
 * прихода вопрос: скриптовый/piped-ввод и ввод с терминала обрабатываются
 * одинаково детерминированно.
 *
 * Отмена/EOF обрабатываются явно: закрытие входного потока, Ctrl+D и Ctrl+C
 * отклоняют активный вопрос ошибкой PromptCancelledError, чтобы мастер
 * гарантированно не зависал и ничего не писал на диск.
 */
import readline from 'node:readline';
import { Readable, Writable } from 'node:stream';

/** Пользователь прервал ввод (EOF/Ctrl+D/Ctrl+C/отказ в подтверждении). */
export class PromptCancelledError extends Error {
  constructor(reason: string = 'EOF') {
    super(`Input cancelled (${reason})`);
    this.name = 'PromptCancelledError';
  }
}

export interface PromptIo {
  input: Readable;
  output: Writable;
}

interface PendingQuestion {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

export class PromptReader {
  private readonly rl: readline.Interface;
  private readonly output: Writable;
  private readonly queue: string[] = [];
  private pending: PendingQuestion | null = null;
  private eof = false;
  private interrupted: Error | null = null;

  constructor(io: PromptIo) {
    this.output = io.output;
    this.rl = readline.createInterface({ input: io.input });
    this.rl.on('line', (line) => {
      const answer = line.trim();
      const waiting = this.pending;
      if (waiting) {
        this.pending = null;
        waiting.resolve(answer);
      } else {
        this.queue.push(answer);
      }
    });
    this.rl.on('close', () => {
      // Введённые ранее строки остаются валидными ответами: EOF считается
      // отменой только когда очередь пуста и активного ответа нет.
      this.eof = true;
      if (this.queue.length === 0) {
        this.rejectPending(new PromptCancelledError('EOF'));
      }
    });
    // Срабатывает только в интерактивном режиме (TTY); в неинтерактивном
    // SIGINT приходит как обычный сигнал процесса и обрабатывается в cli.ts.
    this.rl.on('SIGINT', () =>
      this.rejectPending(new PromptCancelledError('SIGINT (Ctrl+C)')),
    );
  }

  /** Отклоняет активный вопрос ошибкой (идемпотентно для прерываний). */
  private rejectPending(err: Error): void {
    const waiting = this.pending;
    this.pending = null;
    waiting?.reject(err);
  }

  /** Немедленная отмена (Ctrl+C): очередь ответов игнорируется. Идемпотентно. */
  cancel(err: Error): void {
    if (this.interrupted) return;
    this.interrupted = err;
    this.queue.length = 0;
    this.rejectPending(err);
  }

  get isCancelled(): boolean {
    return this.interrupted !== null;
  }

  /**
   * Задаёт вопрос, возвращает ответ без концевых пробелов ('' — пустой ввод).
   * После исчерпания ввода/отмены любой следующий вопрос отклоняется
   * ошибкой PromptCancelledError.
   */
  async ask(prompt: string): Promise<string> {
    if (this.interrupted) throw this.interrupted;
    this.output.write(prompt);
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.eof) {
      throw new PromptCancelledError('EOF');
    }
    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /** Да/нет-вопрос со значением по умолчанию; неразборчивый ввод переспрашивается. */
  async confirm(prompt: string, defaultValue: boolean): Promise<boolean> {
    for (;;) {
      const hint = defaultValue ? '(Y/n)' : '(y/N)';
      const answer = await this.ask(`${prompt} ${hint}`);
      if (answer === '') return defaultValue;
      if (/^(y|yes)$/i.test(answer)) return true;
      if (/^(n|no)$/i.test(answer)) return false;
      this.writeLine('Please answer y or n.');
    }
  }

  /** Печатает строку в поток вывода мастера. */
  writeLine(text: string): void {
    this.output.write(`${text}\n`);
  }

  close(): void {
    this.rl.close();
  }
}
