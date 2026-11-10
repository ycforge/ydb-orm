import type { YdbEntityMetadata } from '../metadata/entity-metadata.js';

/**
 * Preserve complete record identity when an encrypted field is projected.
 * Providers need all PK components regardless of aadOverride. Security AAD
 * fields are included as well unless an explicit override supplies the AAD.
 */
export function resolveEncryptedProjection(
  meta: YdbEntityMetadata,
  select: string[] | undefined,
): string[] | undefined {
  if (!select?.length) return select;

  const effective = [...select];
  const present = new Set(select);
  for (const ef of meta.encryptedFields) {
    if (!present.has(ef.propertyKey)) continue;
    for (const aad of [
      ...meta.primaryKeys,
      ...(ef.aadOverride ? [] : meta.aadFields),
    ]) {
      if (!present.has(aad)) {
        effective.push(aad);
        present.add(aad);
      }
    }
  }
  return effective;
}
