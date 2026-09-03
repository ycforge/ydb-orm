/**
 * Minimal interactive prompts for the CLI (#24) on node:readline —
 * without external dependencies.
 *
 * Input lines are collected in a queue regardless of whether a question was
 * pending when they arrived: scripted/piped input and terminal input are
 * both handled deterministically.
 *
 * Cancel/EOF are handled explicitly: the input stream closing, Ctrl+D and
 * Ctrl+C reject an active question with a PromptCancelledError so the wizard
 * never hangs and never writes to disk.
 */
import readline from 'node:readline';
import { Readable, Writable } from 'node:stream';

/** User interrupted input (EOF/Ctrl+D/Ctrl+C/declined confirmation). */
export class PromptCancelledError extends Error {
  constructor(reason: string = 'EOF') {
    super(`Input cancelled (${reason})`);
    this.name = 'PromptCancelledError';
  }
}

/** I/O streams backing the prompt reader (injectable for tests). */
export interface PromptIo {
  input: Readable;
  output: Writable;
}

interface PendingQuestion {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

/**
 * Reads answers from input via node:readline: lines are queued and consumed
 * on demand, so both terminal and scripted/piped input behave identically.
 * Handles EOF, Ctrl+C (SIGINT) and explicit cancel(); see the class' methods.
 */
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
      // Previously entered lines remain valid answers: EOF is considered a
      // cancellation only when the queue is empty and no answer is pending.
      this.eof = true;
      if (this.queue.length === 0) {
        this.rejectPending(new PromptCancelledError('EOF'));
      }
    });
    // Fires only in interactive mode (TTY); in non-interactive mode SIGINT
    // arrives as a normal process signal handled in cli.ts.
    this.rl.on('SIGINT', () =>
      this.rejectPending(new PromptCancelledError('SIGINT (Ctrl+C)')),
    );
  }

  /** Rejects an active question with an error (idempotent for interruptions). */
  private rejectPending(err: Error): void {
    const waiting = this.pending;
    this.pending = null;
    waiting?.reject(err);
  }

  /** Immediate cancel (Ctrl+C): queued answers are ignored. Idempotent. */
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
   * Poses a question and returns the answer without trailing spaces ('' — empty input).
   * After input is exhausted/cancelled, any following question is rejected
   * with a PromptCancelledError.
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

  /** Yes/no question with a default value; unrecognizable input re-prompts. */
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

  /** Prints a line to the wizard's output stream. */
  writeLine(text: string): void {
    this.output.write(`${text}\n`);
  }

  close(): void {
    this.rl.close();
  }
}
