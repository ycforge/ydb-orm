/**
 * Сериализация Security AAD (#165).
 *
 * `legacy` — исторический формат `name=value;name=value` (конкатенация без
 * экранирования): значения с вложенными разделителями создают коллизии.
 * Например, `{ a: 'x;b=y', b: '' }` и `{ a: 'x', b: 'y;b=' }` кодируются
 * одинаково как `a=x;b=y;b=`, поэтому при shared-key AEAD-провайдере
 * ciphertext можно перенести между такими записями, не поймав расхождение
 * аутентифицированных данных. Формат оставлен только как переходный режим
 * для дешифровки существующего ciphertext (см. `YdbModuleOptions.aadFormat`).
 *
 * `v2` (по умолчанию) — версионированная, каноническая, self-delimiting
 * покомпонентная сериализация. Строка начинается с префикса `v2:`, затем для
 * каждого поля в порядке `metadata.aadFields` (фиксированном) идёт блок
 * `len(name):name` + признак присутствия `0|1` + опционально `len(value):value`.
 * Формат однозначен:
 * - порядок полей фиксирован (перестановка значений даёт другую строку);
 * - длина префиксирована — значения с любыми разделителями безопасны;
 * - отсутствующее/null-значение кодируется явным маркером `0`, поэтому
 *   `{ a: 'x' }` и `{ a: 'x', b: null }` не могут совпасть.
 * Значения приводятся к строке через `String(value)` — как в legacy, чтобы
 * для одного и того же поля шифрование и дешифровка давали одинаковый AAD
 * (Uuid, Date и т.п. конвертируются в строку на обоих путях).
 */
export type AadFormat = 'legacy' | 'v2';

export const DEFAULT_AAD_FORMAT: AadFormat = 'v2';

const AAD_V2_PREFIX = 'v2:';

/** Каноническая v2-сериализация tuple AAD (#165). */
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
      out += `${toAadString(value).length}:${toAadString(value)}`;
    }
  }
  return out;
}

/** Легаси-сериализация `name=value;...` (только для миграции на v2). */
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
 * Значения AAD нормализуются в строку детерминированно (Uuid/Date и т.п.
 * конвертируются одинаково при шифровании и дешифровании). Объекты и массивы
 * недопустимы: в PK-колонках их быть не может, а молчаливый
 * `[object Object]` стёр бы различие между записями.
 */
function toAadString(value: unknown): string {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    case 'object':
      if (value instanceof Date) return value.toISOString();
      break;
    default:
      break;
  }
  throw new Error(
    `Security AAD value must be a scalar, got ${Object.prototype.toString.call(value)}.`,
  );
}

/**
 * Сборка AAD по выбранному формату. По умолчанию — безопасный `v2`;
 * `legacy` нужен только в переходный период для чтения старых записей.
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
