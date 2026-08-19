import { createHash } from 'node:crypto';
import { loadOptionalPeer } from '../core/optional-peer.js';
import {
  YdbBlindIndexProvider,
  YdbEncryptionContext,
  YdbEncryptionProvider,
} from './ydb-encryption-provider.interface.js';

/**
 * Опции для KMS-провайдера шифрования.
 */
export interface KmsEncryptionProviderOptions {
  /** Идентификатор ключа шифрования в Yandex KMS. */
  keyId: string;
  /** Необязательный endpoint KMS-сервиса (если не стандартный). */
  kmsEndpoint?: string;
}

// Типизация для @ycforge/kms (опциональная зависимость)
interface KmsClient {
  encrypt(params: {
    keyId: string;
    plaintext: Uint8Array;
    aad?: Uint8Array;
  }): Promise<{ ciphertext: Uint8Array }>;
  decrypt(params: {
    ciphertext: Uint8Array;
    aad?: Uint8Array;
  }): Promise<{ plaintext: Uint8Array }>;
}

interface KmsModule {
  KmsClient: new (options?: { endpoint?: string }) => KmsClient;
}

/**
 * Провайдер шифрования, использующий Yandex KMS (Key Management Service).
 *
 * Шифрует/дешифрует данные через Managed Key из Yandex Cloud KMS.
 * Аутентификация происходит через окружение (ADC или метаданные инстанса).
 *
 * Требует установки пакета `@ycforge/kms`:
 * ```
 * npm install @ycforge/kms
 * ```
 */
export class KmsEncryptionProvider implements YdbEncryptionProvider {
  private kmsClientPromise: Promise<KmsClient>;

  constructor(private readonly options: KmsEncryptionProviderOptions) {
    this.kmsClientPromise = this.loadKmsClient();
  }

  /**
   * Динамический импорт @ycforge/kms — пакет загружается только при создании провайдера.
   */
  private async loadKmsClient(): Promise<KmsClient> {
    const kms = await loadOptionalPeer<KmsModule>(
      '@ycforge/kms',
      'KmsEncryptionProvider',
    );
    const KmsClientClass = kms.KmsClient;
    return new KmsClientClass({ endpoint: this.options.kmsEndpoint });
  }

  /**
   * Шифрует открытым текст через KMS.
   * AAD (Additional Authenticated Data) передаётся для защиты целостности контекста.
   */
  async encrypt(
    plaintext: string,
    aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    const client = await this.kmsClientPromise;
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const params: {
      keyId: string;
      plaintext: Uint8Array;
      aad?: Uint8Array;
    } = {
      keyId: this.options.keyId,
      plaintext: plaintextBytes,
    };
    if (aad) {
      params.aad = new TextEncoder().encode(aad);
    }
    const { ciphertext } = await client.encrypt(params);
    return Buffer.from(ciphertext).toString('base64');
  }

  /**
   * Дешифрует ciphertext, полученный через KMS.
   */
  async decrypt(
    ciphertext: string,
    aad: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    const client = await this.kmsClientPromise;
    const ciphertextBytes = Buffer.from(ciphertext, 'base64');
    const params: { ciphertext: Uint8Array; aad?: Uint8Array } = {
      ciphertext: ciphertextBytes,
    };
    if (aad) {
      params.aad = new TextEncoder().encode(aad);
    }
    const { plaintext } = await client.decrypt(params);
    return new TextDecoder().decode(plaintext);
  }
}

/**
 * Провайдер blind index на основе SHA-256.
 *
 * Генерирует детерминированный хеш от данных для поиска по зашифрованным полям.
 * Длина хеша — 16 hex-символов (64 бита) — компромисс между компактностью
 * индекса и устойчивостью к коллизиям.
 *
 * Внимание:
 * - hash — голый SHA-256 без соли. Для низкоэнтропийных полей (телефоны,
 *   даты, статусы) уязвим к словарной атаке: перебором можно восстановить
 *   исходное значение. Рекомендуется использовать с высокоэнтропийными
 *   значениями или обернуть в HMAC с секретным ключом.
 * - Усечение до 64 бит: по парадоксу дней рождения коллизии вероятны
 *   уже на ~4 млрд записей.
 */
export class KmsBlindIndexProvider implements YdbBlindIndexProvider {
  /**
   * Вычисляет детерминированный blind index (SHA-256, 16 hex-символов).
   */
  async hash(
    plaintext: string,
    _context: YdbEncryptionContext,
  ): Promise<string> {
    return Promise.resolve(
      createHash('sha256').update(plaintext, 'utf8').digest('hex').slice(0, 16),
    );
  }
}
