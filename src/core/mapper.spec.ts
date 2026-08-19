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
  });

  describe('error handling', () => {
    it('throws on undefined value', () => {
      expect(() => mapToYdb('Uuid', undefined)).toThrow(
        /Undefined passed to YDB/,
      );
    });

    it('throws on unsupported type', () => {
      expect(() => mapToYdb('Foo' as any, 'bar')).toThrow(
        /Unsupported YDB type/,
      );
    });
  });
});
