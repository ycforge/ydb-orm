import type { YdbEntityMetadata } from '../metadata/entity-metadata.js';

/**
 * Computes the effective SELECT projection while preserving the Security AAD (#240).
 *
 * If an explicit projection selects an encrypted field whose AAD is built from
 * entity fields (`@YdbSecurityAAD` and no `aadOverride`), all missing AAD fields
 * are added to the projection. Otherwise the row has no AAD values, a different
 * authenticated context is assembled on decryption and the read fails.
 * Fields with `aadOverride` use a fixed AAD and require no extra columns.
 *
 * @param meta - entity metadata.
 * @param select - requested projection; `undefined`/empty means the default projection.
 * @returns the projection extended with the missing AAD columns.
 */
export function resolveEncryptedProjection(
  meta: YdbEntityMetadata,
  select: string[] | undefined,
): string[] | undefined {
  if (!select?.length || !meta.aadFields.length) return select;

  const effective = [...select];
  const present = new Set(select);
  for (const ef of meta.encryptedFields) {
    if (ef.aadOverride || !present.has(ef.propertyKey)) continue;
    for (const aad of meta.aadFields) {
      if (!present.has(aad)) {
        effective.push(aad);
        present.add(aad);
      }
    }
  }
  return effective;
}
