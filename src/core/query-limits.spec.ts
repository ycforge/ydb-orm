import { describe, expect, it } from '@jest/globals';
import { dedupeInValues } from './query-limits.js';

describe('dedupeInValues', () => {
  it('deduplicates primitive values by value', () => {
    expect(dedupeInValues(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    expect(dedupeInValues([1, 2, 1, 3])).toEqual([1, 2, 3]);
    expect(dedupeInValues([1n, 2n, 1n])).toEqual([1n, 2n]);
    expect(dedupeInValues([true, false, true])).toEqual([true, false]);
  });

  it('preserves first-occurrence order', () => {
    expect(dedupeInValues(['x', 'y', 'x', 'z', 'y', 'w'])).toEqual([
      'x',
      'y',
      'z',
      'w',
    ]);
    expect(dedupeInValues([1, 2, 2, 3, 1, 4, 3])).toEqual([1, 2, 3, 4]);
  });

  it('treats -0 and 0 as the same value (SameValueZero)', () => {
    expect(dedupeInValues([0, -0, 0])).toEqual([0]);
  });

  it('compares Bytes (Uint8Array) by value, not by reference', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    const out = dedupeInValues<Uint8Array>([a, b, c, a]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(c);
  });

  it('compares Date/Datetime/Timestamp-like values by value', () => {
    const a = new Date('2024-01-01T00:00:00.000Z');
    const b = new Date('2024-01-01T00:00:00.000Z');
    const c = new Date('2025-06-15T12:30:00.000Z');
    const out = dedupeInValues<Date>([a, b, c, a]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(c);
  });

  it('distinguishes types that native Set alone would collapse by string', () => {
    const input1: (string | number)[] = ['1', 1, '1'];
    expect(dedupeInValues(input1)).toEqual(['1', 1]);
    const input2: (boolean | number)[] = [false, 0, false];
    expect(dedupeInValues(input2)).toEqual([false, 0]);
  });

  it('treats null and undefined as distinct values', () => {
    const input: (null | undefined)[] = [null, undefined, null];
    expect(dedupeInValues(input)).toEqual([null, undefined]);
  });

  it('distinguishes Bytes from strings and numbers with same shape', () => {
    const bytes = new Uint8Array([49]);
    const input: (Uint8Array | string | number)[] = [bytes, '1', 1, bytes];
    expect(dedupeInValues(input)).toEqual([bytes, '1', 1]);
  });

  it('handles an empty input', () => {
    expect(dedupeInValues([])).toEqual([]);
  });
});
