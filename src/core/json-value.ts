/** Explicitly marks already-serialized JSON; ordinary strings are JSON values. */
export class RawJson {
  readonly #brand = true;
  constructor(readonly text: string) {
    if (typeof text !== 'string')
      throw new TypeError('rawJson expects JSON text.');
    JSON.parse(text);
    Object.freeze(this);
  }
  static is(value: unknown): value is RawJson {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}
export function rawJson(text: string): RawJson {
  return new RawJson(text);
}
export function serializeJson(value: unknown): string {
  if (RawJson.is(value)) return value.text;
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new Error('Value cannot be serialized as JSON.');
  return json;
}
