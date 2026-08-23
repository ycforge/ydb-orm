import { CommitError, YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';

/**
 * Retry-политика ORM по типу ошибки (#27).
 *
 * SDK (@ydbjs/query) УЖЕ ретраит одиночные запросы и тело транзакции
 * (см. «Retry-семантика» в README): у него свой неограниченный по умолчанию
 * бюджет и своя классификация ошибок. Поэтому эта политика — ЯВНАЯ утилита
 * без скрытого глобального состояния: пользователь сам решает, какие
 * составные операции обернуть в runWithRetry(). Оборачивать одиночные
 * запросы и runInTransaction() не нужно и вредно — попытки SDK и ORM
 * перемножатся.
 *
 * Классификация ошибок — ТОЛЬКО по структурным признакам (статус-код YDB
 * из @ydbjs/error), никогда по тексту сообщения.
 */

/**
 * Статусы YDB, которые политика считает транзитными (#27): только
 * ABORTED / UNAVAILABLE / OVERLOADED. Всё остальное — включая статусы,
 * которые SDK считает условно-retryable (SESSION_EXPIRED, UNDETERMINED,
 * TIMEOUT) и ошибки сессий (BAD_SESSION, SESSION_BUSY) — политикой ORM
 * не ретраится: это либо детерминированные ошибки, либо внутренняя
 * забота SDK-ретрая.
 */
export const TRANSIENT_YDB_STATUSES: ReadonlySet<number> = new Set([
  StatusIds_StatusCode.ABORTED,
  StatusIds_StatusCode.UNAVAILABLE,
  StatusIds_StatusCode.OVERLOADED,
] as const);

/** Результат классификации ошибки. */
export type YdbErrorKind = 'transient' | 'fatal';

/** Сигнатура функции задержки (инъецируется в тестах). */
export type YdbRetrySleepFn = (
  ms: number,
  signal?: AbortSignal,
) => Promise<void>;

/** Сигнатура генератора случайных чисел [0, 1) для jitter. */
export type YdbRetryRng = () => number;

/**
 * Контекст попытки для хука onRetry: вызывается перед каждой повторной
 * попыткой (после отработки задержки).
 */
export interface YdbRetryAttemptContext {
  /** Номер НЕУДАЧНОЙ попытки (начиная с 1). */
  attempt: number;
  /** Ошибка, приведшая к повтору. */
  error: unknown;
  /** Задержка перед повторной попыткой, мс. */
  delayMs: number;
}

/**
 * Опции retry-политики (#27).
 *
 * Все поля опциональны; значения по умолчанию см.
 * DEFAULT_YDB_RETRY_POLICY_OPTIONS. Опции валидируются fail-fast:
 * невалидное значение — ошибка сразу, а не тихо проигнорированная опция.
 */
export interface YdbRetryPolicyOptions {
  /**
   * Максимум попыток ВКЛЮЧАЯ первую (по умолчанию 3). Целое число ≥ 1.
   */
  maxAttempts?: number;
  /**
   * Базовая задержка экспоненциального backoff, мс (по умолчанию 100).
   * Попытка N (с единицы) ждёт baseDelayMs * 2^(N-1), ограничено maxDelayMs.
   */
  baseDelayMs?: number;
  /**
   * Верхняя граница задержки, мс (по умолчанию 5000). Bounded backoff:
   * рост экспоненты останавливается на этом значении.
   */
  maxDelayMs?: number;
  /**
   * Доля jitter в [0, 1] (по умолчанию 0.25): итоговая задержка равномерно
   * распределена в [(1 - ratio) * raw, raw], где raw — задержка до jitter.
   * 0 — отключить jitter; 1 — «полный» jitter (от 0 до raw).
   */
  jitterRatio?: number;
  /**
   * Сигнал отмены: отменяет ожидание текущей задержки и запрещает старт
   * новых попыток. Отмена НЕ превращается в повтор — операция завершается
   * причиной отмены (signal.reason).
   */
  signal?: AbortSignal;
  /**
   * Хук перед каждой повторной попыткой (после задержки): логирование,
   * метрики. Ошибки хука не глотаются — пробрасываются как есть.
   */
  onRetry?: (ctx: YdbRetryAttemptContext) => void;
  /**
   * Кастомный предикат повторяемости: замещает классификацию по умолчанию
   * (classifyYdbError). Расширение точки для нестандартных обёрток ошибок;
   * дефолт строго ретраит только ABORTED/UNAVAILABLE/OVERLOADED.
   */
  shouldRetry?: (error: unknown) => boolean;
  /** Шов для тестов: подмена ожидания (по умолчанию setTimeout+signal). */
  sleep?: YdbRetrySleepFn;
  /** Шов для тестов: детерминированный источник случайности для jitter. */
  rng?: YdbRetryRng;
}

export const RETRY_DEFAULT_MAX_ATTEMPTS = 3;
export const RETRY_DEFAULT_BASE_DELAY_MS = 100;
export const RETRY_DEFAULT_MAX_DELAY_MS = 5_000;
export const RETRY_DEFAULT_JITTER_RATIO = 0.25;

/** Значения по умолчанию политики (заморожены). */
export const DEFAULT_YDB_RETRY_POLICY_OPTIONS: Readonly<
  Required<
    Pick<
      YdbRetryPolicyOptions,
      'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'jitterRatio'
    >
  >
> = Object.freeze({
  maxAttempts: RETRY_DEFAULT_MAX_ATTEMPTS,
  baseDelayMs: RETRY_DEFAULT_BASE_DELAY_MS,
  maxDelayMs: RETRY_DEFAULT_MAX_DELAY_MS,
  jitterRatio: RETRY_DEFAULT_JITTER_RATIO,
});

/**
 * Классифицирует ошибку по структурным признакам (#27):
 *
 * - CommitError (ошибка коммита из @ydbjs/query) — раскрывается в cause;
 * - YDBError — transient только при коде ABORTED/UNAVAILABLE/OVERLOADED;
 * - всё остальное (включая обычные Error приложения/валидации/схемы и
 *   AbortError/TimeoutError) — fatal, повтор запрещён.
 *
 * Текст сообщения не анализируется никогда.
 */
export function classifyYdbError(error: unknown): YdbErrorKind {
  if (error instanceof CommitError) {
    return classifyYdbError(error.cause);
  }
  if (error instanceof YDBError) {
    return TRANSIENT_YDB_STATUSES.has(error.code) ? 'transient' : 'fatal';
  }
  return 'fatal';
}

/** true, если ошибка транзитная по умолчательной политике (#27). */
export function isTransientYdbError(error: unknown): boolean {
  return classifyYdbError(error) === 'transient';
}

/**
 * Fail-fast валидация опций политики: неизвестных ключей нет (структура
 * типизирована), проверяются значения диапазонов. Невалидное значение —
 * ошибка конфигурации сразу.
 */
export function validateYdbRetryPolicyOptions(
  options?: YdbRetryPolicyOptions,
): void {
  if (options === undefined) return;
  if (typeof options !== 'object' || options === null) {
    throw new Error('Retry policy options must be an object if provided.');
  }

  const { maxAttempts, baseDelayMs, maxDelayMs, jitterRatio, signal } = options;

  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || maxAttempts < 1)
  ) {
    throw new Error(
      'Retry policy options: "maxAttempts" must be an integer >= 1.',
    );
  }
  for (const [name, value] of [
    ['baseDelayMs', baseDelayMs],
    ['maxDelayMs', maxDelayMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(
        `Retry policy options: "${name}" must be a positive number of milliseconds.`,
      );
    }
  }
  if (
    jitterRatio !== undefined &&
    (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)
  ) {
    throw new Error(
      'Retry policy options: "jitterRatio" must be a number between 0 and 1.',
    );
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error('Retry policy options: "signal" must be an AbortSignal.');
  }
  for (const [name, value] of [
    ['onRetry', options.onRetry],
    ['shouldRetry', options.shouldRetry],
    ['sleep', options.sleep],
    ['rng', options.rng],
  ] as const) {
    if (value !== undefined && typeof value !== 'function') {
      throw new Error(`Retry policy options: "${name}" must be a function.`);
    }
  }
}

/**
 * Чистая функция расчёта задержки перед повторной попыткой (#27):
 *
 *   raw     = min(baseDelayMs * 2^(attempt-1), maxDelayMs)
 *   delayMs = round(raw * (1 - jitterRatio + jitterRatio * rng()))
 *
 * Результат всегда ограничен maxDelayMs (bounded backoff), детерминирован
 * при фиксированных опциях и rng. `attempt` нумеруется с единицы.
 */
export function computeRetryDelayMs(
  attempt: number,
  options?: Pick<
    YdbRetryPolicyOptions,
    'baseDelayMs' | 'maxDelayMs' | 'jitterRatio'
  >,
  rng: YdbRetryRng = Math.random,
): number {
  const base =
    options?.baseDelayMs ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.baseDelayMs;
  const max =
    options?.maxDelayMs ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.maxDelayMs;
  const ratio =
    options?.jitterRatio ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.jitterRatio;

  const raw = Math.min(base * 2 ** (attempt - 1), max);
  const factor = 1 - ratio + ratio * rng();
  return Math.round(raw * factor);
}

/**
 * Нормализует причину отмены к Error: причина abort() может быть любым
 * значением (в т.ч. строкой или undefined) — не-Error заворачивается,
 * исходное значение сохраняется в cause. Строковые/числовые причины
 * попадают и в сообщение; произвольные объекты не строковятся
 * (небезопасно) — они видны только через cause.
 */
function abortReasonToError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const detail =
    typeof reason === 'string'
      ? reason
      : typeof reason === 'number' ||
          typeof reason === 'boolean' ||
          typeof reason === 'bigint'
        ? String(reason)
        : '';
  return new Error(
    detail ? `Operation aborted: ${detail}` : 'Operation aborted',
    { cause: reason },
  );
}

/** Задержка по умолчанию: setTimeout, прерываемый сигналом отмены. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReasonToError(signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(abortReasonToError(signal?.reason));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Выполняет fn под retry-политикой по типу ошибки (#27).
 *
 * Семантика:
 * - максимум `maxAttempts` попыток ВКЛЮЧАЯ первую; между попытками —
 *   экспоненциальный backoff с jitter, ограниченный maxDelayMs;
 * - повторяются ТОЛЬКО транзитные ошибки (по умолчанию — статус-коды
 *   ABORTED/UNAVAILABLE/OVERLOADED, классификация структурная);
 *   детерминированные/прикладные ошибки пробрасываются немедленно;
 * - исчерпание попыток пробрасывает ПОСЛЕДНЮЮ ошибку как есть (без
 *   заворачивания) — структура YDBError сохраняется для вызывающего;
 * - `signal` отменяет ожидание задержки и запрещает новые попытки;
 *   операция завершается причиной отмены: если signal.reason — не Error,
 *   он заворачивается в Error (исходное значение — в cause);
 * - колбэк должен быть идемпотентным или устойчивым к повтору: при
 *   повторе заново выполняется вся fn (те же требования, что к
 *   idempotent-транзакциям #98).
 *
 * НЕ оборачивайте этой функцией одиночные запросы и runInTransaction():
 * их уже ретраит SDK внутри себя — вложение перемножит попытки.
 * Целевой сценарий — составные операции вне транзакции (несколько
 * запросов/шагов бизнес-логики), которые SDK как единое целое не ретраит.
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  options?: YdbRetryPolicyOptions,
): Promise<T> {
  validateYdbRetryPolicyOptions(options);

  const maxAttempts =
    options?.maxAttempts ?? DEFAULT_YDB_RETRY_POLICY_OPTIONS.maxAttempts;
  const sleep = options?.sleep ?? defaultSleep;
  const rng = options?.rng ?? Math.random;
  const signal = options?.signal;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortReasonToError(signal.reason);

    try {
      return await fn();
    } catch (error) {
      const retryable = options?.shouldRetry
        ? options.shouldRetry(error)
        : isTransientYdbError(error);
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt, options, rng);
      await sleep(delayMs, signal);
      options?.onRetry?.({ attempt, error, delayMs });
    }
  }

  /* istanbul ignore next: цикл всегда возвращается или бросает выше */
  throw new Error('unreachable');
}
