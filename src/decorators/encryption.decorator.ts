import 'reflect-metadata';
import {
  YDB_ENCRYPTED_KEY,
  YDB_SECURITY_AAD_KEY,
} from '../metadata/entity-metadata.js';
import type { EncryptedFieldMeta } from '../metadata/entity-metadata.js';

/**
 * Suffix of the synthetic blind-index column (see @YdbEncrypted({ blindIndex })).
 * Used by persistence, schema sync, metadata validation, and CLI.
 */
export const BLIND_INDEX_SUFFIX = '_bi';

/**
 * Name of the synthetic blind-index column for an encrypted field:
 * `{propertyKey}_bi`. The single naming point — persistence, schema sync,
 * metadata validation and the CLI use it instead of inline templates.
 *
 * @param propertyKey - The entity property name.
 * @returns Blind index column name with `_bi` suffix.
 */
export function blindIndexColumnName(propertyKey: string): string {
  return `${propertyKey}${BLIND_INDEX_SUFFIX}`;
}

/**
 * Options for @YdbEncrypted decorator.
 */
export interface YdbEncryptedOptions {
  blindIndex?: boolean;
  aadOverride?: string;
  /**
   * Lazy decryption (default false): the field is not decrypted when read
   * from the DB — ciphertext stays on the instance. Decryption is done
   * explicitly: await entity.decryptField('field') or
   * await entity.decryptLazyFields(). toJSON() throws an error until a
   * lazy field has been decrypted. Saves CPU on queries where the field
   * value is not needed.
   */
  lazy?: boolean;
}

/**
 * Marks a field as encrypted. No parameters = { blindIndex: true }.
 * Ciphertext is always stored in a YDB `Bytes` column (raw bytes) — the
 * type from @YdbColumn is ignored for such fields and need not be declared.
 * The lazy: true option defers decryption until an explicit call to
 * decryptField()/decryptLazyFields() on the instance.
 *
 * Inheritance and re-application semantics: the last declaration wins
 * (last-write-wins, like @YdbEnum) — re-applying on the same class and
 * overriding an inherited property does not create duplicates in metadata.
 * Otherwise decryption would process the field twice: the second pass would
 * hand the provider already-decrypted plaintext as if it were ciphertext.
 * Metadata is cloned before being modified (copy-on-write), so that
 * subclasses do not corrupt the parent class's metadata.
 *
 * @param options - Encryption options: blindIndex, aadOverride, lazy.
 * @returns Property decorator function.
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
 * Marks a primary key field as a participant of the AAD (Additional
 * Authenticated Data). Can only be applied to columns declared via
 * @YdbPrimaryColumn.
 *
 * Inheritance and re-application semantics: deduplication by field name
 * (like @YdbPrimaryColumn) — a re-declaration on a subclass or on the same
 * class does not create duplicates in the AAD string.
 *
 * @returns Property decorator function.
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
