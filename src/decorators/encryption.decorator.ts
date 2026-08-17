import 'reflect-metadata';
import {
  YDB_ENCRYPTED_KEY,
  YDB_SECURITY_AAD_KEY,
} from '../metadata/entity-metadata.js';
import type { EncryptedFieldMeta } from '../metadata/entity-metadata.js';

export interface YdbEncryptedOptions {
  blindIndex?: boolean;
  aadOverride?: string;
}

/**
 * Помечает поле как шифруемое. Без параметров = { blindIndex: true }.
 * Метаданные клонируются перед изменением (copy-on-write), чтобы
 * наследники не портили метаданные родительского класса.
 */
export function YdbEncrypted(options?: YdbEncryptedOptions): PropertyDecorator {
  return (target, propertyKey) => {
    const constructor = target.constructor;
    const inherited: EncryptedFieldMeta[] =
      Reflect.getMetadata(YDB_ENCRYPTED_KEY, constructor) || [];
    const list: EncryptedFieldMeta[] = [
      ...inherited,
      {
        propertyKey: propertyKey as string,
        blindIndex: options?.blindIndex ?? true,
        aadOverride: options?.aadOverride,
      },
    ];
    Reflect.defineMetadata(YDB_ENCRYPTED_KEY, list, constructor);
  };
}

/**
 * Помечает НЕзашифрованное поле как участника AAD (Additional Authenticated Data).
 */
export function YdbSecurityAAD(): PropertyDecorator {
  return (target, propertyKey) => {
    const constructor = target.constructor;
    const inherited: string[] =
      Reflect.getMetadata(YDB_SECURITY_AAD_KEY, constructor) || [];
    Reflect.defineMetadata(
      YDB_SECURITY_AAD_KEY,
      [...inherited, propertyKey as string],
      constructor,
    );
  };
}
