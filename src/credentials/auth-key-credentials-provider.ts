import { type RetryConfig, retry } from '@ydbjs/retry';
import { backoff } from '@ydbjs/retry/strategy';
import { CredentialsProvider } from '@ydbjs/auth';
import { Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs';

const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';

/**
 * Запас перед истечением токена: без него токен мог протухнуть
 * между проверкой в кеше и реальным запросом к API.
 */
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;

export type IamJWTKeyCredentials = {
  keyId: string;
  serviceAccountId: string;
  privateKey: string;
};

/** Ответ IAM API обмена JWT на токен. */
interface IamTokenResponse {
  iamToken?: string;
  expiresAt?: string;
}

/** Парсит expiresAt (RFC3339-строка/число/Date) в Date. */
function parseTimestamp(ts: unknown): Date {
  if (!ts) return new Date(Date.now() + 3600_000);
  if (ts instanceof Date) return ts;
  if (typeof ts === 'string') return new Date(ts);
  if (typeof ts === 'number') return new Date(ts);
  return new Date(Date.now() + 3600_000);
}

export class AuthKeyCredentialsProvider extends CredentialsProvider {
  #promise: Promise<string> | null = null;
  #token: { value: string; expired_at: Date } | null = null;
  #credentials: IamJWTKeyCredentials;

  private readonly logger = new Logger(AuthKeyCredentialsProvider.name);

  constructor(credentials: IamJWTKeyCredentials) {
    super();
    this.#credentials = credentials;
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
      retry: (err) => err instanceof Error,
      signal,
      budget: 5,
      strategy: backoff(10, 1000),
    };

    this.#promise = retry(retryConfig, async () => {
      const jwt = this.#generateJWT();

      this.logger.debug('Exchanging JWT for IAM token');
      const response = await fetch(IAM_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jwt }),
        signal: signal ?? null,
      });
      if (!response.ok) {
        const body = await response.text();
        this.logger.error(
          `IAM token exchange failed: ${response.status} ${body}`,
        );
        throw new Error(
          `IAM token exchange failed with status ${response.status}`,
        );
      }

      const token = (await response.json()) as IamTokenResponse;
      if (!token.iamToken) {
        this.logger.error('Missing IAM token in response:', token);
        throw new Error('No IAM token in response');
      }

      const expiresAt = parseTimestamp(token.expiresAt);

      this.#token = {
        value: token.iamToken,
        expired_at: expiresAt,
      };

      this.logger.debug(
        `IAM token cached, expires at ${expiresAt.toISOString()}`,
      );

      return this.#token.value;
    }).finally(() => {
      this.#promise = null;
    });

    return this.#promise;
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
