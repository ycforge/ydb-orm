import { type RetryConfig, retry } from '@ydbjs/retry';
import { backoff } from '@ydbjs/retry/strategy';
import { CredentialsProvider } from '@ydbjs/auth';
import { Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs';

const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';

/** Таймаут отдельного HTTP-запроса к IAM (обмен JWT на токен). */
const IAM_FETCH_TIMEOUT_MS = 10_000;

/**
 * Запас перед истечением токена: без него токен мог протухнуть
 * между проверкой в кеше и реальным запросом к API.
 */
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;

/**
 * Дефолтный TTL кеша, когда IAM-ответ не содержит expiresAt.
 * Совпадает с фактическим TTL IAM-токенов (1 час), чтобы кеш работал
 * без «вечного» или пустого срока действия.
 */
const DEFAULT_TOKEN_TTL_MS = 3600_000;

/**
 * Историческая граница для числового expiresAt: значение <= порога
 * трактуется как секунды (unix), больше — как миллисекунды.
 * Текущее unix-время ~1.7e9, миллисекунды — ~1.7e12.
 */
const SECONDS_TIMESTAMP_THRESHOLD = 100_000_000_000;

export type IamJWTKeyCredentials = {
  keyId: string;
  serviceAccountId: string;
  privateKey: string;
};

/** Опции провайдера AuthKeyCredentialsProvider. */
export interface AuthKeyCredentialsProviderOptions {
  /** Таймаут отдельного fetch-запроса к IAM, мс (по умолчанию 10 000). */
  fetchTimeoutMs?: number;
}

/** Ответ IAM API обмена JWT на токен. */
interface IamTokenResponse {
  iamToken?: string;
  expiresAt?: unknown;
}

/** Маркер ошибки, которую не нужно ретраить (детерминированный ответ IAM). */
const NON_RETRYABLE = Symbol('YdbOrmNonRetryableCredentialError');

function markNonRetryable<E extends Error>(err: E): E {
  (err as unknown as { [NON_RETRYABLE]?: boolean })[NON_RETRYABLE] = true;
  return err;
}

function isNonRetryable(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as { [NON_RETRYABLE]?: boolean })[NON_RETRYABLE] === true
  );
}

/** Безопасное представление значения для сообщений об ошибке (без токенов). */
function describeRawValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 120));
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return typeof value;
}

function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const name: unknown = (err as { name?: unknown }).name;
    return typeof name === 'string' ? name : '';
  }
  return '';
}

/**
 * Разбирает expiresAt из ответа IAM в Date с правильной семантикой
 * секунды/миллисекунды. Возвращает null, если поле отсутствует.
 * Невалидное значение — fail-fast Error (не Invalid Date и не NaN),
 * чтобы кеш никогда не деградировал до «истекает никогда».
 */
function parseTimestamp(ts: unknown): Date | null {
  if (ts === undefined || ts === null || ts === '') return null;

  let date: Date;
  if (ts instanceof Date) {
    if (Number.isNaN(ts.getTime())) {
      throw markNonRetryable(
        new Error('Invalid expiresAt: Invalid Date instance'),
      );
    }
    date = new Date(ts.getTime());
  } else if (typeof ts === 'number') {
    if (!Number.isFinite(ts) || ts < 0) {
      throw markNonRetryable(
        new Error(`Invalid numeric expiresAt: ${describeRawValue(ts)}`),
      );
    }
    date = new Date(ts <= SECONDS_TIMESTAMP_THRESHOLD ? ts * 1000 : ts);
  } else if (typeof ts === 'string') {
    date = new Date(ts);
  } else {
    throw markNonRetryable(
      new Error(`Invalid expiresAt: unexpected type ${typeof ts}`),
    );
  }

  if (Number.isNaN(date.getTime())) {
    throw markNonRetryable(
      new Error(`Invalid expiresAt: ${describeRawValue(ts)}`),
    );
  }
  return date;
}

export class AuthKeyCredentialsProvider extends CredentialsProvider {
  #promise: Promise<string> | null = null;
  #token: { value: string; expired_at: Date } | null = null;
  #credentials: IamJWTKeyCredentials;
  #fetchTimeoutMs: number;

  private readonly logger = new Logger(AuthKeyCredentialsProvider.name);

  constructor(
    credentials: IamJWTKeyCredentials,
    options: AuthKeyCredentialsProviderOptions = {},
  ) {
    super();
    this.#credentials = credentials;
    this.#fetchTimeoutMs = options.fetchTimeoutMs ?? IAM_FETCH_TIMEOUT_MS;
    if (!(this.#fetchTimeoutMs > 0)) {
      throw new Error('fetchTimeoutMs must be a positive number');
    }
  }

  static fromAuthorizedKeyFile(path: string): AuthKeyCredentialsProvider {
    const raw = fs.readFileSync(path, 'utf-8');
    const json = JSON.parse(raw);

    if (!json.id || !json.service_account_id || !json.private_key) {
      throw new Error(
        `Invalid authorized_key.json at ${path}. Expected fields: id, service_account_id, private_key`,
      );
    }

    return new AuthKeyCredentialsProvider({
      keyId: json.id,
      serviceAccountId: json.service_account_id,
      privateKey: json.private_key,
    });
  }

  async getToken(force?: boolean, signal?: AbortSignal): Promise<string> {
    if (
      !force &&
      this.#token &&
      this.#token.expired_at.getTime() - TOKEN_EXPIRY_LEEWAY_MS > Date.now()
    ) {
      return this.#token.value;
    }

    if (this.#promise) {
      return this.#promise;
    }

    const retryConfig: RetryConfig = {
      retry: (err) => err instanceof Error && !isNonRetryable(err),
      signal,
      budget: 5,
      strategy: backoff(10, 1000),
    };

    this.#promise = retry(retryConfig, async () => {
      const jwt = this.#generateJWT();

      this.logger.debug('Exchanging JWT for IAM token');

      let response: Response;
      try {
        response = await fetch(IAM_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jwt }),
          signal: this.#withFetchTimeout(signal),
        });
      } catch (err) {
        throw this.#normalizeFetchError(err);
      }

      if (!response.ok) {
        // Тело ответа в лог не пишем: там может быть чувствительное содержимое.
        const error = new Error(
          `IAM token exchange failed with status ${response.status}`,
        );
        this.logger.error(error.message, error.stack);
        throw error;
      }

      let payload: IamTokenResponse;
      try {
        payload = (await response.json()) as IamTokenResponse;
      } catch (err) {
        // Не валидный JSON — детерминированная ошибка, доверять телу нельзя.
        const error = markNonRetryable(
          new Error('IAM token exchange failed: response is not valid JSON', {
            cause: err,
          }),
        );
        this.logger.error(error.message, error.stack);
        throw error;
      }

      if (typeof payload.iamToken !== 'string' || payload.iamToken === '') {
        const error = markNonRetryable(
          new Error('IAM token exchange failed: no iamToken in response'),
        );
        this.logger.error(error.message, error.stack);
        throw error;
      }

      const parsed = parseTimestamp(payload.expiresAt);
      let expiresAt: Date;
      if (parsed === null) {
        const fallback = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
        this.logger.warn(
          `IAM response is missing expiresAt; assuming default token TTL ` +
            `${DEFAULT_TOKEN_TTL_MS} ms (until ${fallback.toISOString()})`,
        );
        expiresAt = fallback;
      } else {
        expiresAt = parsed;
      }

      this.#token = {
        value: payload.iamToken,
        expired_at: expiresAt,
      };

      this.logger.debug(
        `IAM token cached, expires at ${expiresAt.toISOString()}`,
      );

      return this.#token.value;
    })
      .catch((err) => {
        // Рефреш не удался — устаревший токен из кеша больше не выдаём.
        this.#token = null;
        throw err;
      })
      .finally(() => {
        this.#promise = null;
      });

    return this.#promise;
  }

  #withFetchTimeout(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.#fetchTimeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  #normalizeFetchError(err: unknown): Error {
    const errName = errorName(err);

    if (errName === 'TimeoutError') {
      const error = new Error(
        `IAM token exchange timed out after ${this.#fetchTimeoutMs} ms`,
      );
      error.name = 'TimeoutError';
      this.logger.error(error.message, error.stack);
      return error;
    }
    if (errName === 'AbortError') {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'IAM token exchange aborted';
      const error = new Error(message);
      error.name = 'AbortError';
      if (err instanceof Error && err.stack) error.stack = err.stack;
      // Внешняя отмена — debug, а не error.
      this.logger.debug(error.message, error.stack);
      return error;
    }

    const baseMessage =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: unknown }).message)
          : String(err);
    const error = new Error(`IAM token exchange failed: ${baseMessage}`);
    if (err instanceof Error && err.stack) error.stack = err.stack;
    this.logger.error(error.message, error.stack);
    return error;
  }

  #generateJWT(): string {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;

    const header = {
      alg: 'PS256',
      typ: 'JWT',
      kid: this.#credentials.keyId,
    };

    const payload = {
      iss: this.#credentials.serviceAccountId,
      sub: this.#credentials.serviceAccountId,
      aud: IAM_TOKEN_URL,
      iat: now,
      exp: exp,
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
      'base64url',
    );
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      'base64url',
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const privateKey = crypto.createPrivateKey(this.#credentials.privateKey);

    const signature = crypto.sign('sha256', Buffer.from(signingInput), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });

    const encodedSignature = signature.toString('base64url');

    return `${signingInput}.${encodedSignature}`;
  }
}
