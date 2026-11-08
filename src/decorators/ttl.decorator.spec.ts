import 'reflect-metadata';
import { YdbTtl } from './ttl.decorator.js';

// Interval validation in @YdbTtl (#236): YDB Interval supports only fixed
// durations representable as integer microseconds. Calendar components
// (years/months) have no fixed length and must fail at decoration time,
// before an invalid Interval("P1Y") reaches DDL generation.

describe('@YdbTtl interval validation (#236)', () => {
  /** Decorates a class with the given interval — the decorator runs immediately. */
  function decorate(interval: string): void {
    @YdbTtl({ interval, column: 'expires_at' })
    class DecoratorValidationEntity {}
    void DecoratorValidationEntity;
  }

  it.each(['P30D', 'PT2H', 'PT2H30M', 'P1DT2H30M', 'PT0.5S', 'PT0.000001S'])(
    'accepts fixed duration "%s"',
    (interval) => {
      expect(() => decorate(interval)).not.toThrow();
    },
  );

  it.each(['P1Y', 'P1M', 'P2Y6M', 'P1Y1D', 'P1M1D', 'P1YT2H'])(
    'rejects calendar-based interval "%s"',
    (interval) => {
      expect(() => decorate(interval)).toThrow(/calendar components/);
    },
  );

  it('names the invalid interval and calendar components in the error', () => {
    expect(() => decorate('P1Y')).toThrow(
      '@YdbTtl on class "DecoratorValidationEntity": interval "P1Y" contains calendar components',
    );
  });

  it('rejects sub-microsecond intervals', () => {
    expect(() => decorate('PT0.0000001S')).toThrow(
      /more precise than a microsecond/,
    );
  });
});
