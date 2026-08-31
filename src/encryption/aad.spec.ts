import { describe, it, expect, jest } from '@jest/globals';
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
  it('distinguishes tuples from the issue: nested separators cause no collisions', () => {
    const t1 = serializeAadV2(['a', 'b'], fromRecord({ a: 'x;b=y', b: '' }));
    const t2 = serializeAadV2(['a', 'b'], fromRecord({ a: 'x', b: 'y;b=' }));
    expect(t1).not.toBe(t2);
  });

  it('prefix v2 marks format and separates from legacy', () => {
    const out = serializeAadV2(['uuid'], fromRecord({ uuid: 'u-1' }));
    expect(out.startsWith('v2:')).toBe(true);
    expect(out).not.toBe('uuid=u-1');
  });

  it('fixed field order: permuting values produces different string', () => {
    const rec = { a: 'x', b: 'y' };
    const ab = serializeAadV2(['a', 'b'], fromRecord(rec));
    const ba = serializeAadV2(['b', 'a'], fromRecord(rec));
    expect(ab).not.toBe(ba);
  });

  it('absent and null encoded with single missing-value marker', () => {
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

  it('field with empty string differs from absent field', () => {
    const empty = serializeAadV2(['a', 'b'], fromRecord({ a: 'x', b: '' }));
    const missing = serializeAadV2(['a', 'b'], fromRecord({ a: 'x' }));
    expect(empty).not.toBe(missing);
  });

  it('Bytes values (Uint8Array) normalized via base64 deterministically', () => {
    const bytes = new TextEncoder().encode('abc');
    const same = new TextEncoder().encode('abc');
    const other = new TextEncoder().encode('abd');

    const aad1 = serializeAadV2(['blob'], fromRecord({ blob: bytes }));
    const aad2 = serializeAadV2(['blob'], fromRecord({ blob: same }));
    const aad3 = serializeAadV2(['blob'], fromRecord({ blob: other }));

    // The same byte set yields the same AAD string (from any instance).
    expect(aad1).toBe(aad2);
    // Different bytes yield different strings.
    expect(aad1).not.toBe(aad3);
    // The value is base64-encoded ('abc' → 'YWJj').
    expect(aad1).toContain('4:YWJj');
  });

  it('Bytes AAD distinguishes different values at first line', () => {
    const a = serializeAadV2(
      ['a', 'b'],
      fromRecord({ a: 'x', b: new TextEncoder().encode('v') }),
    );
    const b = serializeAadV2(
      ['a', 'b'],
      fromRecord({ a: 'x', b: new TextEncoder().encode('w') }),
    );
    expect(a).not.toBe(b);
  });

  it('values resembling length-prefix component do not break encoding', () => {
    const t1 = serializeAadV2(['a'], fromRecord({ a: '1:a0' }));
    const t2 = serializeAadV2(['a'], fromRecord({ a: '1:a1' }));
    const t3 = serializeAadV2(['a', 'b'], fromRecord({ a: 'x', b: '0' }));
    expect(t1).not.toBe(t2);
    expect(t3).not.toBe(t1);
  });

  it('different value pairs always produce different encodings', () => {
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

  it('normalizes each present value exactly once (#204)', () => {
    const d1 = new Date('2024-01-01T00:00:00.000Z');
    const d2 = new Date('2025-06-15T12:30:45.000Z');
    const iso1 = jest.spyOn(d1, 'toISOString');
    const iso2 = jest.spyOn(d2, 'toISOString');
    try {
      const out = serializeAadV2(
        ['dt1', 'dt2'],
        fromRecord({ dt1: d1, dt2: d2 }),
      );
      // Byte-for-byte the same v2 format: length + value for each field.
      expect(out).toBe(
        'v2:3:dt1124:2024-01-01T00:00:00.000Z' +
          '3:dt2124:2025-06-15T12:30:45.000Z',
      );
      // Normalization (Date → ISO) happens once per value.
      expect(iso1).toHaveBeenCalledTimes(1);
      expect(iso2).toHaveBeenCalledTimes(1);
    } finally {
      iso1.mockRestore();
      iso2.mockRestore();
    }
  });
});

describe('serializeAadLegacy', () => {
  it('preserves historical name=value;... format and skips null fields', () => {
    const out = serializeAadLegacy(
      ['uuid', 'tenant_id'],
      fromRecord({ uuid: 'u-1', tenant_id: null }),
    );
    expect(out).toBe('uuid=u-1');
  });

  it('typical legacy collisions remain legacy collisions (for migration test)', () => {
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
  it('defaults to safe v2', () => {
    expect(DEFAULT_AAD_FORMAT).toBe('v2');
    const out = buildAad(['uuid'], fromRecord({ uuid: 'u-1' }));
    expect(out.startsWith('v2:')).toBe(true);
  });

  it('explicit legacy returns historical format', () => {
    const out = buildAad(['uuid'], fromRecord({ uuid: 'u-1' }), 'legacy');
    expect(out).toBe('uuid=u-1');
  });
});
