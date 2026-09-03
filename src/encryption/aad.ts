/**
 * Security AAD serialization (#165).
 *
 * `legacy` — the historical `name=value;name=value` format (concatenation
 * without escaping): values containing nested separators create collisions.
 * For example, `{ a: 'x;b=y', b: '' }` and `{ a: 'x', b: 'y;b=' }` encode
 * identically as `a=x;b=y;b=`, so with a shared-key AEAD provider a
 * ciphertext can be moved between such records without the authenticated
 * data mismatch being caught. The format is kept only as a transitional
 * mode for decrypting existing ciphertext (see `YdbModuleOptions.aadFormat`).
 *
 * `v2` (default) — a versioned, canonical, self-delimiting per-component
 * serialization. The string starts with the prefix `v2:`, then for each
 * field in the fixed `metadata.aadFields` order a block of
 * `len(name):name` + a presence flag `0|1` + optionally `len(value):value`.
 * The format is unambiguous:
 * - field order is fixed (permuting values produces a different string);
 * - length is prefixed, so values containing any delimiters are safe;
 * - a missing/null value is encoded with an explicit `0` marker, so
 *   `{ a: 'x' }` and `{ a: 'x', b: null }` cannot coincide.
 * Values are coerced to strings via `String(value)` — as in legacy, so that
 * encrypt and decrypt of the same field yield the same AAD (Uuid, Date, etc.
 * convert to a string on both paths).
 */
export type AadFormat = 'legacy' | 'v2';

/** The default AAD format: the safe, canonical `v2`. */
export const DEFAULT_AAD_FORMAT: AadFormat = 'v2';

const AAD_V2_PREFIX = 'v2:';

/**
 * Canonical v2 serialization of tuple AAD (#165).
 *
 * @param names - Ordered field names from metadata (fixed order).
 * @param valueOf - Function returning the value for a given field name.
 * @returns Serialized AAD string with `v2:` prefix.
 */
export function serializeAadV2(
  names: readonly string[],
  valueOf: (name: string) => unknown,
): string {
  let out = AAD_V2_PREFIX;
  for (const name of names) {
    const value = valueOf(name);
    const present = value !== undefined && value !== null;
    out += `${name.length}:${name}${present ? '1' : '0'}`;
    if (present) {
      const normalized = toAadString(value);
      out += `${normalized.length}:${normalized}`;
    }
  }
  return out;
}

/**
 * Legacy serialization `name=value;...` (for migration to v2 only).
 *
 * @param names - Ordered field names from metadata.
 * @param valueOf - Function returning the value for a given field name.
 * @returns Serialized AAD string in legacy format.
 */
export function serializeAadLegacy(
  names: readonly string[],
  valueOf: (name: string) => unknown,
): string {
  return names
    .filter((name) => {
      const value = valueOf(name);
      return value !== undefined && value !== null;
    })
    .map((name) => `${name}=${toAadString(valueOf(name))}`)
    .join(';');
}

/**
 * Value normalization for AAD: values are coerced to a string
 * deterministically (Uuid/Date/Bytes etc. convert the same way during
 * encrypt and decrypt):
 * - Date/Datetime/Timestamp — ISO string;
 * - Bytes — base64 (canonical, reversible, ASCII-safe);
 * - other primitives — String().
 * Objects and arrays are not allowed: they cannot occur in PK/AAD columns,
 * and a silent `[object Object]` would erase the distinction between records.
 *
 * @param value - The value to normalize.
 * @returns Normalized string representation.
 * @throws If value is not a supported scalar type.
 */
export function toAadString(value: unknown): string {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    case 'object':
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('base64');
      }
      break;
    default:
      break;
  }
  throw new Error(
    `Security AAD value must be a scalar, got ${Object.prototype.toString.call(value)}.`,
  );
}

/**
 * Builds the AAD according to the selected format. Defaults to the safe `v2`;
 * `legacy` is only needed during the transition to read old records.
 *
 * @param names - Ordered field names from metadata.
 * @param valueOf - Function returning the value for a given field name.
 * @param format - AAD format: 'v2' (default) or 'legacy'.
 * @returns Serialized AAD string.
 */
export function buildAad(
  names: readonly string[],
  valueOf: (name: string) => unknown,
  format: AadFormat = DEFAULT_AAD_FORMAT,
): string {
  return format === 'legacy'
    ? serializeAadLegacy(names, valueOf)
    : serializeAadV2(names, valueOf);
}
