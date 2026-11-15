import { describe, expect, test } from 'bun:test';
import { resolveSearchDateBounds } from '../src/core/search/hybrid.ts';
import { utcSearchDateBound } from '../src/core/search/date-bounds.ts';
import { buildKeywordMatch } from '../src/core/search/keyword-statement.ts';
import { buildVectorSearchStatement } from '../src/core/search/vector-statement.ts';

describe('public search date bounds preserve their comparison contract', () => {
  test('bare dates are normalized to UTC for SQL timestamp casts, without rewriting timestamps', () => {
    expect(utcSearchDateBound('2030-06-15')).toBe('2030-06-15T00:00:00Z');
    expect(utcSearchDateBound('2030-06-15T08:30:00+02:00')).toBe('2030-06-15T08:30:00+02:00');
  });

  test('keyword and vector SQL bind date-only bounds as UTC timestamps', () => {
    const opts = { afterDate: '2030-06-15', beforeDate: '2030-06-16' };
    expect(buildKeywordMatch('synthetic query', opts)!.params).toContain('2030-06-15T00:00:00Z');
    expect(buildKeywordMatch('synthetic query', opts)!.params).toContain('2030-06-16T00:00:00Z');

    const vector = buildVectorSearchStatement({
      dialect: 'postgres', embedding: new Float32Array([0]), limit: 5, offset: 0, opts,
    });
    expect(vector.params).toContain('2030-06-15T00:00:00Z');
    expect(vector.params).toContain('2030-06-16T00:00:00Z');
  });

  test('since includes the exact boundary without rounding microseconds', () => {
    expect(resolveSearchDateBounds({ since: '2030-06-15T10:00:00.123456+02:00' })).toMatchObject({
      afterDate: '2030-06-15T10:00:00.123456+02:00', afterDateInclusive: true,
    });
  });

  test('exact until includes the timestamp as written', () => {
    expect(resolveSearchDateBounds({ until: '2030-06-15T23:59:59.999999Z' })).toMatchObject({
      beforeDate: '2030-06-15T23:59:59.999999Z', beforeDateInclusive: true,
    });
  });

  test.each([
    ['2030-06-15', '2030-06-16T00:00:00.000Z'],
    ['2032-02-29', '2032-03-01T00:00:00.000Z'],
    ['2030-12-31', '2031-01-01T00:00:00.000Z'],
  ])('date-only until %s includes the entire day', (until, boundary) => {
    expect(resolveSearchDateBounds({ until })).toMatchObject({
      beforeDate: boundary, beforeDateInclusive: false,
    });
  });

  test('legacy after/before remain strict and public fields win', () => {
    const legacy = resolveSearchDateBounds({ afterDate: '2030-06-01', beforeDate: '2030-06-15' });
    expect(legacy.afterDateInclusive).not.toBe(true);
    expect(legacy.beforeDateInclusive).not.toBe(true);
    expect(legacy.beforeDate).toBe('2030-06-15T23:59:59.999Z');
    expect(resolveSearchDateBounds({ afterDate: '2030-01-01', since: '2030-06-15' })).toMatchObject({
      afterDate: '2030-06-15', afterDateInclusive: true,
    });
  });

  test('invalid calendar dates are rejected instead of shifting into the next month', () => {
    expect(() => resolveSearchDateBounds({ until: '2030-02-30' })).toThrow('Invalid until');
    expect(() => resolveSearchDateBounds({ since: '2030-02-29' })).toThrow('Invalid since');
    expect(() => resolveSearchDateBounds({ until: '0000-01-01' })).toThrow('Invalid until');
  });
});
