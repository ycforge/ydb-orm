import type { YdbEntityMetadata } from '../metadata/entity-metadata.js';

/**
 * Вычисляет эффективную SELECT-проекцию с сохранением Security AAD (#240).
 *
 * Если явная проекция выбирает шифрованное поле, чей AAD строится из полей
 * сущности (`@YdbSecurityAAD` и нет `aadOverride`), в проекцию добавляются все
 * отсутствующие AAD-поля. Иначе строка не содержит AAD-значений, при
 * дешифровке собирается другой аутентифицированный контекст и чтение падает.
 * Поля с `aadOverride` используют фиксированный AAD и дополнительных колонок
 * не требуют.
 *
 * @param meta - метаданные сущности.
 * @param select - запрошенная проекция; `undefined`/пустая — проекция по умолчанию.
 * @returns проекция, дополненная недостающими AAD-колонками.
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
