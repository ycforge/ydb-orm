import { describe, it, expect } from '@jest/globals';
import {
  buildAad,
  serializeAadV2,
  serializeAadLegacy,
  DEFAULT_AAD_FORMAT,
} from './aad.js';

function fromRecord(rec: Record<string, unknown>): (name: string) => unknown {
  return (name) => rec[name];
}

describe('serializeAadV2 (#165)', () => {
  it('различает tuple из issue: вложенные разделители не создают коллизий', () => {
    const t1 = serializeAadV2(['a', 'b'], fromRecord({ a: 'x;b=y', b: '' }));
    const t2 = serializeAadV2(['a', 'b'], fromRecord({ a: 'x', b: 'y;b=' }));
    expect(t1).not.toBe(t2);
  });

  it('prefix v2 маркирует формат и отделяет от legacy', () => {
    const out = serializeAadV2(['uuid'], fromRecord({ uuid: 'u-1' }));
    expect(out.startsWith('v2:')).toBe(true);
    expect(out).not.toBe('uuid=u-1');
  });

  it('фиксированный порядок полей: перестановка значений даёт другую строку', () => {
    const rec = { a: 'x', b: 'y' };
    const ab = serializeAadV2(['a', 'b'], fromRecord(rec));
    const ba = serializeAadV2(['b', 'a'], fromRecord(rec));
    expect(ab).not.toBe(ba);
  });

  it('absent и null кодируются единым маркером отсутствия значения', () => {
    const withNull = serializeAadV2(
      ['a', 'b'],
      fromRecord({ a: 'x', b: null }),
    );
    const withUndef = serializeAadV2(
      ['a', 'b'],
      fromRecord({ a: 'x', b: undefined }),
    );
    expect(withNull).toBe(withUndef);
    expect(withNull.endsWith('0')).toBe(true);
  });

  it('поле с пустой строкой отличается от отсутствующего поля', () => {
    const empty = serializeAadV2(['a', 'b'], fromRecord({ a: 'x', b: '' }));
    const missing = serializeAadV2(['a', 'b'], fromRecord({ a: 'x' }));
    expect(empty).not.toBe(missing);
  });

  it('значения, похожие на length-prefix компонента, не ломают кодировку', () => {
    const t1 = serializeAadV2(['a'], fromRecord({ a: '1:a0' }));
    const t2 = serializeAadV2(['a'], fromRecord({ a: '1:a1' }));
    const t3 = serializeAadV2(['a', 'b'], fromRecord({ a: 'x', b: '0' }));
    expect(t1).not.toBe(t2);
    expect(t3).not.toBe(t1);
  });

  it('разные пары значений всегда дают разные кодировки', () => {
    const tuples: Record<string, unknown>[] = [
      { a: 'x', b: 'y' },
      { a: 'x', b: 'y;b=' },
      { a: 'x;b=y', b: '' },
      { a: 'x', b: 'y', c: 'z' },
      { a: 'x', b: '', c: 'z' },
      { a: 'x', b: 'y', c: '' },
      { a: 'x', c: 'z' },
      { a: 'x', b: 'y', c: 'z', d: 'w' },
    ];
    const names = ['a', 'b', 'c', 'd'];
    const encodings = tuples.map((t) => serializeAadV2(names, fromRecord(t)));
    expect(new Set(encodings).size).toBe(encodings.length);
  });
});

describe('serializeAadLegacy', () => {
  it('сохраняет исторический формат name=value;... и пропуск null-полей', () => {
    const out = serializeAadLegacy(
      ['uuid', 'tenant_id'],
      fromRecord({ uuid: 'u-1', tenant_id: null }),
    );
    expect(out).toBe('uuid=u-1');
  });

  it('типичные коллизии legacy остаются коллизиями legacy (для теста миграции)', () => {
    const t1 = serializeAadLegacy(
      ['a', 'b'],
      fromRecord({ a: 'x;b=y', b: '' }),
    );
    const t2 = serializeAadLegacy(
      ['a', 'b'],
      fromRecord({ a: 'x', b: 'y;b=' }),
    );
    expect(t1).toBe(t2);
  });
});

describe('buildAad', () => {
  it('по умолчанию использует безопасный v2', () => {
    expect(DEFAULT_AAD_FORMAT).toBe('v2');
    const out = buildAad(['uuid'], fromRecord({ uuid: 'u-1' }));
    expect(out.startsWith('v2:')).toBe(true);
  });

  it('явный legacy отдаёт исторический формат', () => {
    const out = buildAad(['uuid'], fromRecord({ uuid: 'u-1' }), 'legacy');
    expect(out).toBe('uuid=u-1');
  });
});
