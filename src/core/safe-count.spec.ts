import { toSafeCount } from './safe-count.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

describe('toSafeCount (#245)', () => {
  it('maps undefined/null to 0', () => {
    expect(toSafeCount(undefined)).toBe(0);
    expect(toSafeCount(null)).toBe(0);
  });

  it('returns bigint values at and below MAX_SAFE_INTEGER exactly', () => {
    expect(toSafeCount(0n)).toBe(0);
    expect(toSafeCount(42n)).toBe(42);
    expect(toSafeCount(MAX_SAFE)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns safe number and integer string values exactly', () => {
    expect(toSafeCount(42)).toBe(42);
    expect(toSafeCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(toSafeCount('42')).toBe(42);
    expect(toSafeCount(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('throws for bigint values above MAX_SAFE_INTEGER', () => {
    expect(() => toSafeCount(MAX_SAFE + 1n)).toThrow(
      /COUNT\(\*\) result 9007199254740992 .* exceeds the safe integer range/,
    );
    expect(() => toSafeCount(9007199254740993n)).toThrow(
      /COUNT\(\*\) result 9007199254740993 .* exceeds the safe integer range/,
    );
  });

  it('throws for unsafe number and integer string values', () => {
    expect(() => toSafeCount(2 ** 53)).toThrow(
      /exceeds the safe integer range/,
    );
    expect(() => toSafeCount('9007199254740993')).toThrow(
      /exceeds the safe integer range/,
    );
  });

  it('throws for non-integer and non-numeric values', () => {
    expect(() => toSafeCount(1.5)).toThrow(/not a valid integer count/);
    expect(() => toSafeCount(NaN)).toThrow(/not a valid integer count/);
    expect(() => toSafeCount('abc')).toThrow(/not a valid integer count/);
    expect(() => toSafeCount({})).toThrow(/not a valid integer count/);
  });
});
