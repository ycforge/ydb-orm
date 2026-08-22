import {
  Uuid,
  Utf8,
  Bytes,
  Int32,
  Int64,
  Bool,
  Double,
  Float,
  Date as YdbDate,
  Datetime,
  Timestamp,
  Json,
  JsonDocument,
} from '@ydbjs/value/primitive';
import { Optional } from '@ydbjs/value/optional';
import { mapToYdb } from './mapper.js';

describe('mapToYdb', () => {
  describe('Uuid', () => {
    it('wraps a UUID string into Uuid value', () => {
      const val = mapToYdb('Uuid', '5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5');
      expect(val).toBeInstanceOf(Uuid);
      expect(String(val)).toBe('5ad91505-d4f6-4a81-ab65-9dbc68cf4ed5');
    });

    it('returns Optional<Uuid> for null', () => {
      const val = mapToYdb('Uuid', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('Utf8', () => {
    it('wraps a string into Utf8 value', () => {
      const val = mapToYdb('Utf8', 'hello');
      expect(val).toBeInstanceOf(Utf8);
      expect((val as any).value).toBe('hello');
    });

    it('handles unicode and emoji', () => {
      const val = mapToYdb('Utf8', 'Привет 🌍');
      expect((val as any).value).toBe('Привет 🌍');
    });

    it('returns Optional<Utf8> for null', () => {
      const val = mapToYdb('Utf8', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('Bytes', () => {
    it('wraps a Uint8Array into Bytes value', () => {
      const bytes = new Uint8Array([0, 1, 2, 255]);
      const val = mapToYdb('Bytes', bytes);
      expect(val).toBeInstanceOf(Bytes);
      expect((val as any).value).toBe(bytes);
    });

    it('returns Optional<Bytes> for null', () => {
      const val = mapToYdb('Bytes', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('Int32', () => {
    it('wraps an integer into Int32 value', () => {
      const val = mapToYdb('Int32', 42);
      expect(val).toBeInstanceOf(Int32);
    });

    it('handles zero', () => {
      const val = mapToYdb('Int32', 0);
      expect(val).toBeInstanceOf(Int32);
    });

    it('handles negative values', () => {
      const val = mapToYdb('Int32', -100);
      expect(val).toBeInstanceOf(Int32);
    });

    it('returns Optional<Int32> for null', () => {
      const val = mapToYdb('Int32', null);
      expect(val).toBeInstanceOf(Optional);
    });

    it('accepts the Int32 lower boundary', () => {
      const val = mapToYdb('Int32', -2147483648);
      expect(val).toBeInstanceOf(Int32);
    });

    it('accepts the Int32 upper boundary', () => {
      const val = mapToYdb('Int32', 2147483647);
      expect(val).toBeInstanceOf(Int32);
    });

    it('rejects values above the Int32 range', () => {
      expect(() => mapToYdb('Int32', 2147483648)).toThrow(/out of range/);
    });

    it('rejects values below the Int32 range', () => {
      expect(() => mapToYdb('Int32', -2147483649)).toThrow(/out of range/);
    });

    it('rejects non-integer values', () => {
      expect(() => mapToYdb('Int32', 1.5)).toThrow(/must be an integer/);
    });
  });

  describe('Int64', () => {
    it('wraps a BigInt into Int64 value', () => {
      const val = mapToYdb('Int64', 9007199254740991n);
      expect(val).toBeInstanceOf(Int64);
    });

    it('wraps a number into Int64 value', () => {
      const val = mapToYdb('Int64', 123);
      expect(val).toBeInstanceOf(Int64);
    });

    it('wraps a string into Int64 value', () => {
      const val = mapToYdb('Int64', '9999999999999');
      expect(val).toBeInstanceOf(Int64);
    });

    it('returns Optional<Int64> for null', () => {
      const val = mapToYdb('Int64', null);
      expect(val).toBeInstanceOf(Optional);
    });

    it('accepts the Int64 upper boundary', () => {
      const val = mapToYdb('Int64', 9223372036854775807n);
      expect(val).toBeInstanceOf(Int64);
    });

    it('accepts the Int64 lower boundary', () => {
      const val = mapToYdb('Int64', -9223372036854775808n);
      expect(val).toBeInstanceOf(Int64);
    });

    it('rejects values above the Int64 range', () => {
      expect(() => mapToYdb('Int64', 9223372036854775808n)).toThrow(
        /out of range/,
      );
    });

    it('rejects values below the Int64 range', () => {
      expect(() => mapToYdb('Int64', -9223372036854775809n)).toThrow(
        /out of range/,
      );
    });

    it('rejects fractional numbers (BigInt throws raw RangeError)', () => {
      expect(() => mapToYdb('Int64', 4.5)).toThrow(/Failed to convert/);
    });

    it('rejects NaN as Int64', () => {
      expect(() => mapToYdb('Int64', Number.NaN)).toThrow(/Failed to convert/);
    });
  });

  describe('Bool', () => {
    it('wraps true into Bool value', () => {
      const val = mapToYdb('Bool', true);
      expect(val).toBeInstanceOf(Bool);
    });

    it('wraps false into Bool value', () => {
      const val = mapToYdb('Bool', false);
      expect(val).toBeInstanceOf(Bool);
    });

    it('returns Optional<Bool> for null', () => {
      const val = mapToYdb('Bool', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('Double', () => {
    it('wraps a number into Double value', () => {
      const val = mapToYdb('Double', 3.14);
      expect(val).toBeInstanceOf(Double);
    });

    it('returns Optional<Double> for null', () => {
      const val = mapToYdb('Double', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('Float', () => {
    it('wraps a number into Float value', () => {
      const val = mapToYdb('Float', 1.5);
      expect(val).toBeInstanceOf(Float);
    });

    it('returns Optional<Float> for null', () => {
      const val = mapToYdb('Float', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('Date / Datetime / Timestamp', () => {
    const jsDate = new global.Date('2026-08-18T12:30:00.000Z');

    it('wraps Date instance into YDB Date', () => {
      expect(mapToYdb('Date', jsDate)).toBeInstanceOf(YdbDate);
    });

    it('wraps ISO string into Datetime', () => {
      expect(mapToYdb('Datetime', '2026-08-18T12:30:00.000Z')).toBeInstanceOf(
        Datetime,
      );
    });

    it('wraps epoch ms into Timestamp', () => {
      expect(mapToYdb('Timestamp', jsDate.getTime())).toBeInstanceOf(Timestamp);
    });

    it('returns Optional for null', () => {
      expect(mapToYdb('Date', null)).toBeInstanceOf(Optional);
      expect(mapToYdb('Datetime', null)).toBeInstanceOf(Optional);
      expect(mapToYdb('Timestamp', null)).toBeInstanceOf(Optional);
    });

    it('accepts a Date instance with milliseconds', () => {
      const ms = new global.Date('2026-08-18T12:30:00.123Z');
      expect(mapToYdb('Timestamp', ms)).toBeInstanceOf(Timestamp);
      expect(mapToYdb('Datetime', ms)).toBeInstanceOf(Datetime);
      expect(mapToYdb('Date', ms)).toBeInstanceOf(YdbDate);
    });

    it('stores Timestamp with millisecond precision (getTime() * 1000n)', () => {
      const ms = new Date('2026-08-18T12:30:00.123Z');
      const val = mapToYdb('Timestamp', ms) as any;
      expect(val.value).toBe(BigInt(ms.getTime()) * 1000n);
      // Субмиллисекунды не сохраняются: JS Date не может их нести.
      expect(val.value % 1000n).toBe(0n);
    });

    it('rejects an invalid Date instance for all temporal types', () => {
      const invalid = new Date('garbage');
      expect(Number.isNaN(invalid.getTime())).toBe(true);
      expect(() => mapToYdb('Date', invalid)).toThrow(/Invalid Date/);
      expect(() => mapToYdb('Datetime', invalid)).toThrow(/Invalid Date/);
      expect(() => mapToYdb('Timestamp', invalid)).toThrow(/Invalid Date/);
    });

    it('rejects a garbage string for all temporal types', () => {
      expect(() => mapToYdb('Date', 'not-a-date')).toThrow(/Invalid Date/);
      expect(() => mapToYdb('Datetime', 'not-a-date')).toThrow(/Invalid Date/);
      expect(() => mapToYdb('Timestamp', 'not-a-date')).toThrow(/Invalid Date/);
    });

    it('rejects NaN epoch ms for all temporal types', () => {
      expect(() => mapToYdb('Date', Number.NaN)).toThrow(/Invalid Date/);
      expect(() => mapToYdb('Datetime', Number.NaN)).toThrow(/Invalid Date/);
      expect(() => mapToYdb('Timestamp', Number.NaN)).toThrow(/Invalid Date/);
    });
  });

  describe('Json', () => {
    it('wraps a string into Json value', () => {
      const val = mapToYdb('Json', '{"a":1}');
      expect(val).toBeInstanceOf(Json);
      expect((val as any).value).toBe('{"a":1}');
    });

    it('serializes an object into Json value', () => {
      const val = mapToYdb('Json', { a: 1 });
      expect(val).toBeInstanceOf(Json);
      expect((val as any).value).toBe('{"a":1}');
    });

    it('returns Optional<Json> for null', () => {
      const val = mapToYdb('Json', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('JsonDocument', () => {
    it('wraps a string into JsonDocument value', () => {
      const val = mapToYdb('JsonDocument', '{"a":1}');
      expect(val).toBeInstanceOf(JsonDocument);
      expect((val as any).value).toBe('{"a":1}');
    });

    it('serializes an object into JsonDocument value', () => {
      const val = mapToYdb('JsonDocument', { a: 1 });
      expect(val).toBeInstanceOf(JsonDocument);
      expect((val as any).value).toBe('{"a":1}');
    });

    it('returns Optional<JsonDocument> for null', () => {
      const val = mapToYdb('JsonDocument', null);
      expect(val).toBeInstanceOf(Optional);
    });
  });

  describe('error handling', () => {
    it('throws on undefined value', () => {
      expect(() => mapToYdb('Uuid', undefined)).toThrow(
        /Undefined passed to YDB/,
      );
    });

    it('includes the field name on undefined value', () => {
      expect(() => mapToYdb('Uuid', undefined, 'userId')).toThrow(
        /field "userId"/,
      );
    });

    it('throws on unsupported type', () => {
      expect(() => mapToYdb('Foo' as any, 'bar')).toThrow(
        /Unsupported YDB type/,
      );
    });
  });

  describe('conversion error context', () => {
    const captureMessage = (fn: () => unknown): string => {
      let msg = '';
      try {
        fn();
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).not.toBe('');
      return msg;
    };

    it('includes field name, YDB type and value for Int32 overflow', () => {
      const msg = captureMessage(() => mapToYdb('Int32', 2147483648, 'age'));
      expect(msg).toContain('field "age"');
      expect(msg).toContain('YDB type Int32');
      expect(msg).toContain('2147483648');
    });

    it('includes field name, YDB type and value for invalid Date', () => {
      const msg = captureMessage(() =>
        mapToYdb('Timestamp', 'not-a-date', 'createdAt'),
      );
      expect(msg).toContain('field "createdAt"');
      expect(msg).toContain('YDB type Timestamp');
      expect(msg).toContain('not-a-date');
    });

    it('wraps the raw BigInt RangeError with field/type/value context', () => {
      const msg = captureMessage(() => mapToYdb('Int64', 4.5, 'counter'));
      expect(msg).toContain('field "counter"');
      expect(msg).toContain('YDB type Int64');
      expect(msg).toContain('4.5');
    });
  });
});
