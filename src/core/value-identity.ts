/**
 * Инъективная каноническая кодировка YDB-значений в строковый ключ (#174).
 *
 * Нужна везде, где Map/Set идентифицируют строки по значению колонки:
 * - дедупликация PK/FK между IN(...)-чанками в fetchByColumnIn (#86);
 * - группировка inverse-строк и владельцев в relations-мапах (#174);
 * - повторяющиеся PK-компоненты, гидратированные в РАЗНЫЕ инстансы
 *   (два `Uint8Array([1,2])` и две равные `Date`) должны считаться одним
 *   значением — сравнение по ссылке дало бы «не найден» для валидных связей.
 *
 * Конкатенация с разделителем (`String(a) + '|' + String(b)`) НЕинъективна:
 * ('a|b', 'c') и ('a', 'b|c') дают один ключ 'a|b|c'. Поэтому используется
 * двоичная кодировка без разделителей:
 * [тег типа][длина payload (4 байта, big-endian)][payload].
 * Границы компонентов восстанавливаются однозначно по объявленной длине,
 * типы различаются тегом, поэтому разные значения не могут дать одинаковый
 * ключ.
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

/** Добавляет payload с префиксом длины (4 байта BE) — самоделимитация. */
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

/** IEEE-754 double как 8 байт BE. */
function appendFloat64(out: number[], value: number): void {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  appendLengthPrefixed(out, new Uint8Array(buf));
}

const VALUE_HEX_CHARS = '0123456789abcdef';

/**
 * Канонический value-ключ кортежа YDB-значений: инъективное отображение
 * компонентов (string | number | bigint | boolean | Uint8Array | Date |
 * null/undefined) в hex-строку. Детерминировано: одинаковые значения —
 * одинаковый ключ, разные — гарантированно разные. Bytes и Date
 * сравниваются ПО ЗНАЧЕНИЮ, а не по ссылке.
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
        // -0 и 0 — одно значение по SameValueZero (как в Set).
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
          // Bytes-колонки YDB гидратируются в Uint8Array; сравнение
          // побайтовое (String() дал бы '[object Uint8Array]' для всех).
          const view = value;
          out.push(valueTag.bytes);
          appendLengthPrefixed(
            out,
            new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
          );
        } else if (value instanceof Date) {
          // Date/Datetime/Timestamp-колонки; невалидная дата — ошибка
          // конфигурации, а не источник коллизий.
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
