import 'reflect-metadata';
import {
  YDB_ENCRYPTED_KEY,
  YDB_SECURITY_AAD_KEY,
} from '../metadata/entity-metadata.js';
import type { EncryptedFieldMeta } from '../metadata/entity-metadata.js';

/** Суффикс synthetic-колонки blind index (см. @YdbEncrypted({ blindIndex })). */
export const BLIND_INDEX_SUFFIX = '_bi';

/**
 * Имя synthetic-колонки blind index для зашифрованного поля:
 * `{propertyKey}_bi`. Единственная точка именования — persistence, schema
 * sync, валидация метаданных и CLI используют её вместо inline-шаблонов.
 */
export function blindIndexColumnName(propertyKey: string): string {
  return `${propertyKey}${BLIND_INDEX_SUFFIX}`;
}

export interface YdbEncryptedOptions {
  blindIndex?: boolean;
  aadOverride?: string;
  /**
   * Ленивая дешифровка (по умолчанию false): поле не дешифруется
   * при чтении из БД — в инстансе остаётся ciphertext. Дешифровка
   * выполняется явно: await entity.decryptField('field') или
   * await entity.decryptLazyFields(). toJSON() бросает ошибку,
   * пока lazy-поле не дешифровано. Экономит CPU на запросах,
   * где значение поля не нужно.
   */
  lazy?: boolean;
}

/**
 * Помечает поле как шифруемое. Без параметров = { blindIndex: true }.
 * Шифротекст всегда хранится в YDB-колонке `Bytes` (raw bytes) — тип из
 * @YdbColumn для таких полей игнорируется, объявлять его не нужно.
 * Опция lazy: true откладывает дешифровку до явного вызова
 * decryptField()/decryptLazyFields() на инстансе.
 *
 * Семантика наследования и повторного применения: последняя декларация
 * побеждает (last-write-wins, как у @YdbEnum) — повторное применение на
 * том же классе и переопределение унаследованного свойства не создаёт
 * дублей в метаданных. Иначе дешифровка обработала бы поле дважды:
 * второй проход отдал бы провайдеру уже расшифрованный plaintext как
 * ciphertext. Метаданные клонируются перед изменением (copy-on-write),
 * чтобы наследники не портили метаданные родительского класса.
 */
export function YdbEncrypted(options?: YdbEncryptedOptions): PropertyDecorator {
  return (target, propertyKey) => {
    const constructor = target.constructor;
    const inherited: EncryptedFieldMeta[] =
      Reflect.getMetadata(YDB_ENCRYPTED_KEY, constructor) || [];
    const list: EncryptedFieldMeta[] = [
      ...inherited.filter((e) => e.propertyKey !== propertyKey),
      {
        propertyKey: propertyKey as string,
        blindIndex: options?.blindIndex ?? true,
        aadOverride: options?.aadOverride,
        lazy: options?.lazy ?? false,
      },
    ];
    Reflect.defineMetadata(YDB_ENCRYPTED_KEY, list, constructor);
  };
}

/**
 * Помечает поле первичного ключа как участника AAD (Additional Authenticated Data).
 * Может применяться только к колонкам, объявленным через @YdbPrimaryColumn.
 *
 * Семантика наследования и повторного применения: дедупликация по имени поля
 * (как у @YdbPrimaryColumn) — повторное объявление на наследнике или на том же
 * классе не создаёт дублей в AAD-строке.
 */
export function YdbSecurityAAD(): PropertyDecorator {
  return (target, propertyKey) => {
    const constructor = target.constructor;
    const inherited: string[] =
      Reflect.getMetadata(YDB_SECURITY_AAD_KEY, constructor) || [];
    if (inherited.includes(propertyKey as string)) return;
    Reflect.defineMetadata(
      YDB_SECURITY_AAD_KEY,
      [...inherited, propertyKey as string],
      constructor,
    );
  };
}
