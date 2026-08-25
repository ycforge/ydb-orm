import type {
  YdbExecutor,
  YdbQuery,
  YdbTransactionOptions,
} from './interfaces.js';
import { resolveYdbRetryPolicy, runWithRetry } from './retry.js';
import type {
  YdbResolvedRetryPolicy,
  YdbRetryPolicyInput,
  YdbRetryPolicyOptions,
} from './retry.js';

/**
 * Подключение retry-политики к executor'у (#27).
 *
 * Приоритет слоёв повтора (детерминированный):
 * - политика выключена — одиночные запросы ретраит только внутренний
 *   цикл SDK (@ydbjs/query), как в #98;
 * - политика включена — владение ретраями ПЕРЕХОДИТ к ORM: на каждую
 *   попытку политики приходится ровно одна попытка SDK. Внутренний цикл
 *   SDK гасится через событие `retry` запроса: ORM отменяет сигнал
 *   попытки, SDK не выполняет следующую попытку, а исходная ошибка
 *   забирается из контекста события и классифицируется политикой.
 *   Максимум обращений к БД равен maxAttempts — умножения попыток нет.
 */

/** Ошибка вида AbortError (отмена), в отличие от прикладных ошибок. */
function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Объединяет сигналы отмены (undefined-ы отбрасываются). */
function combineSignals(
  signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
  const list = signals.filter(
    (s): s is AbortSignal => s instanceof AbortSignal,
  );
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : AbortSignal.any(list);
}

function policyToOptions(
  policy: YdbResolvedRetryPolicy,
): YdbRetryPolicyOptions {
  return {
    maxAttempts: policy.maxAttempts,
    baseDelayMs: policy.baseDelayMs,
    maxDelayMs: policy.maxDelayMs,
    jitterRatio: policy.jitterRatio,
    signal: policy.signal,
    onRetry: policy.onRetry,
    shouldRetry: policy.shouldRetry,
    sleep: policy.sleep,
    rng: policy.rng,
  };
}

/**
 * Создаёт прокси-запрос под политикой: операции билдера запоминаются и
 * воспроизводятся на КАЖДОЙ попытке политики (у SDK-запроса результат
 * выполнения кешируется в инстансе — переиспользовать его нельзя).
 *
 * Правило безопасности (#27): повторять можно ТОЛЬКО запрос, явно
 * помеченный идемпотентным (`.idempotent(true)` / `{ idempotent: true }`).
 * Непомеченный запрос выполняется РОВНО ОДИН раз даже при включённой
 * политике: у SDK внутренний цикл тоже гасится, чтобы двусмысленный
 * сбой транспорта не привёл к повтору записи. SDK-запросу пометка
 * пробрасывается как `.idempotent(true)`.
 */
function createPolicyQuery(
  makeBase: () => YdbQuery,
  policy: YdbResolvedRetryPolicy,
): YdbQuery {
  const params: Array<[string, unknown]> = [];
  let timeoutMs: number | undefined;
  let userSignal: AbortSignal | undefined;
  // undefined = пользователь не вызывал .idempotent() — считаем НЕ
  // идемпотентным (fail-safe); true = помечен; false = помечен явно.
  let markedIdempotent: boolean | undefined;
  let current: YdbQuery | undefined;

  const proxy: YdbQuery = {
    parameter(name: string, value: unknown): YdbQuery {
      params.push([name, value]);
      return proxy;
    },
    timeout(timeout: number): YdbQuery {
      timeoutMs = timeout;
      return proxy;
    },
    signal(signal: AbortSignal): YdbQuery {
      userSignal = signal;
      return proxy;
    },
    idempotent(flag?: boolean): YdbQuery {
      markedIdempotent = flag !== false;
      return proxy;
    },
    cancel(): YdbQuery {
      current?.cancel();
      return proxy;
    },
    then(onFulfilled?, onRejected?) {
      const runOnce = async (policySignal?: AbortSignal): Promise<unknown> => {
        const query = makeBase();
        current = query;
        for (const [name, value] of params) query.parameter(name, value);
        if (timeoutMs !== undefined) query.timeout(timeoutMs);
        if (markedIdempotent === true) query.idempotent?.(true);

        // Гашение внутреннего ретрая SDK: после первой неудачи SDK хочет
        // повторить (событие 'retry' после своей задержки) — отменяем сигнал
        // попытки, SDK бросает AbortError ДО следующего обращения к БД, а мы
        // подменяем его исходной ошибкой из контекста события. Для
        // непомеченного запроса это даёт строго однократное исполнение.
        const attemptController = new AbortController();
        let captured = false;
        let capturedError: unknown;
        query.on?.('retry', (ctx) => {
          if (!captured) {
            captured = true;
            capturedError = ctx.error;
          }
          attemptController.abort();
        });

        const combined = combineSignals([
          userSignal,
          policySignal,
          attemptController.signal,
        ]);
        if (combined) query.signal(combined);

        try {
          return await query;
        } catch (error) {
          if (captured && isAbortLike(error)) throw capturedError;
          throw error;
        }
      };

      // Fail-safe (#27): без явной пометки идемпотентности политика НЕ
      // применяется — ровно одна попытка БД.
      const result =
        markedIdempotent === true
          ? runWithRetry(runOnce, policyToOptions(policy))
          : Promise.resolve().then(() => runOnce());
      return result.then(onFulfilled, onRejected);
    },
  };
  return proxy;
}

/**
 * Подключает retry-политику (#27) к executor'у: каждый запрос через
 * возвращённый executor выполняется под политикой (классификация по
 * статусам ABORTED/UNAVAILABLE/OVERLOADED, bounded backoff + jitter,
 * отмена сигналом). `transaction()` пробрасывается как есть — повторами
 * тела транзакции управляет опция `retry` в runInTransaction().
 *
 * ПРАВИЛО ИДЕМПОТЕНТНОСТИ (#27, fail-safe): политика ретраит только
 * запросы, ЯВНО помеченные идемпотентными — `.idempotent(true)` на цепочке
 * или `{ idempotent: true }` в QueryOptions. Непомеченный запрос (в т.ч.
 * любой INSERT/UPSERT/UPDATE/DELETE по умолчанию) выполняется РОВНО ОДИН
 * раз даже при включённой политике: внутренний цикл SDK для него тоже
 * гасится, чтобы двусмысленный сбой транспорта не продублировал запись.
 * Повторять можно только операции, устойчивые к повтору.
 *
 * Выключенная политика (`false`/`undefined`) возвращает executor без
 * изменений — поведение идентично #98.
 *
 * Оборачивайте ОДИН раз; вложение нескольких политик перемножит попытки.
 */
export function withRetryPolicy(
  executor: YdbExecutor,
  policyInput?: YdbRetryPolicyInput,
): YdbExecutor {
  const policy = resolveYdbRetryPolicy(policyInput);
  if (!policy) return executor;

  const base = executor as unknown as (
    strings: TemplateStringsArray,
    ...args: unknown[]
  ) => YdbQuery;
  const wrapped = ((
    strings: TemplateStringsArray,
    ...args: unknown[]
  ): YdbQuery =>
    createPolicyQuery(
      () => base(strings, ...args),
      policy,
    )) as unknown as YdbExecutor;

  (wrapped as unknown as Record<string, unknown>).transaction = (
    options?: YdbTransactionOptions,
  ) => executor.transaction(options);

  return wrapped;
}
