import { CredentialsProvider } from '@ydbjs/auth';
import {
  AuthKeyTokenProvider,
  authKeyFromFile,
  type AuthKeyTokenProviderOptions,
} from '@ycforge/auth';

export type IamJWTKeyCredentials = {
  keyId: string;
  serviceAccountId: string;
  privateKey: string;
};

/** Опции провайдера AuthKeyCredentialsProvider. */
export type AuthKeyCredentialsProviderOptions = AuthKeyTokenProviderOptions;

/**
 * CredentialsProvider для YDB по authorized key сервисного аккаунта
 * (обмен JWT PS256 на IAM-токен). Публичный API сохранён, внутренняя
 * реализация делегирует `AuthKeyTokenProvider` из пакета `@ycforge/auth`
 * (JWT/кэш с leeway 60 c/single-flight/retry живут там).
 */
export class AuthKeyCredentialsProvider extends CredentialsProvider {
  #provider: AuthKeyTokenProvider;

  constructor(
    credentials: IamJWTKeyCredentials,
    options: AuthKeyCredentialsProviderOptions = {},
  ) {
    super();
    this.#provider = new AuthKeyTokenProvider(credentials, options);
  }

  static fromAuthorizedKeyFile(path: string): AuthKeyCredentialsProvider {
    const config = authKeyFromFile(path);
    return new AuthKeyCredentialsProvider({
      keyId: config.keyId,
      serviceAccountId: config.serviceAccountId,
      privateKey: config.privateKey,
    });
  }

  getToken(force?: boolean, signal?: AbortSignal): Promise<string> {
    return this.#provider.getToken(force, signal);
  }
}
