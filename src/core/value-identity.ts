/**
 * Injective canonical encoding of YDB values into a string key (#174).
 *
 * Needed wherever Map/Set identify rows by column value:
 * - PK/FK deduplication across IN(...) chunks in fetchByColumnIn (#86);
 * - grouping of inverse rows and owners in relations maps (#174);
 * - repeated PK components hydrated into DIFFERENT instances
 *   (two `Uint8Array([1,2])` and two equal `Date`) must count as one
 *   value — reference comparison would give "not found" for valid relations.
 *
 * Concatenation with a delimiter (`String(a) + '|' + String(b)`) is NON-injective:
 * ('a|b', 'c') and ('a', 'b|c') produce the same key 'a|b|c'. Therefore a
 * delimiter-free binary encoding is used:
 * [type tag][payload length (4 bytes, big-endian)][payload].
 * Component boundaries are recovered unambiguously by the declared length,
 * types are distinguished by tag, so different values cannot produce the same key.
 */

const valueTag = {
  nullValue: 0,
  undefinedValue: 1,
  string: 2,
  number: 3,
  bigint: 4,
  boolean: 5,
  bytes: 6,
  date: 7,
} as const;

const textEncoder = new TextEncoder();

/** Adds payload with length prefix (4 bytes BE) — self-delimiting. */
function appendLengthPrefixed(out: number[], payload: Uint8Array): void {
  const len = payload.length;
  out.push(
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
  );
  for (let i = 0; i < len; i++) out.push(payload[i]);
}

/** IEEE-754 double as 8 bytes BE. */
function appendFloat64(out: number[], value: number): void {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  appendLengthPrefixed(out, new Uint8Array(buf));
}

const VALUE_HEX_CHARS = '0123456789abcdef';

/**
 * Canonical value-key of a YDB value tuple: injective mapping
 * of components (string | number | bigint | boolean | Uint8Array | Date |
 * null/undefined) to a hex string. Deterministic: same values — same key,
 * different — guaranteed different. Bytes and Date compared BY VALUE,
 * not by reference.
 */
export function valueIdentityKey(components: readonly unknown[]): string {
  const out: number[] = [];
  for (const value of components) {
    if (value === null) {
      out.push(valueTag.nullValue);
      continue;
    }
    switch (typeof value) {
      case 'string':
        out.push(valueTag.string);
        appendLengthPrefixed(out, textEncoder.encode(value));
        break;
      case 'number': {
        // -0 and 0 are one value per SameValueZero (like in Set).
        out.push(valueTag.number);
        appendFloat64(out, Object.is(value, -0) ? 0 : value);
        break;
      }
      case 'bigint':
        out.push(valueTag.bigint);
        appendLengthPrefixed(out, textEncoder.encode(value.toString()));
        break;
      case 'boolean':
        out.push(valueTag.boolean, value ? 1 : 0);
        break;
      case 'object': {
        if (ArrayBuffer.isView(value)) {
          // YDB bytes columns hydrate to Uint8Array; comparison
          // is bytewise (String() would give '[object Uint8Array]' for all).
          const view = value;
          out.push(valueTag.bytes);
          appendLengthPrefixed(
            out,
            new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
          );
        } else if (value instanceof Date) {
          // Date/Datetime/Timestamp columns; invalid date is a
          // configuration error, not a collision source.
          if (Number.isNaN(value.getTime())) {
            throw new Error(
              'Invalid Date in value identity key: cannot build identity key',
            );
          }
          out.push(valueTag.date);
          appendFloat64(out, value.getTime());
        } else {
          throw new Error(
            `Unsupported value identity component type: ${typeof value}. ` +
              'Value components must be YDB primitives',
          );
        }
        break;
      }
      case 'undefined':
        out.push(valueTag.undefinedValue);
        break;
      default:
        throw new Error(
          `Unsupported value identity component type: ${typeof value}. ` +
            'Value components must be YDB primitives',
        );
    }
  }

  let hex = '';
  for (const byte of out) {
    hex += VALUE_HEX_CHARS[byte >> 4] + VALUE_HEX_CHARS[byte & 0x0f];
  }
  return hex;
}
