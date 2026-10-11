import { describe, expect, it } from 'vitest';
import { allDays, weekdaysOnly } from './slots';

describe('grid columns with weekends hidden', () => {
  const s = weekdaysOnly(70, 1); // day 0 is a Monday
  it('Monday–Friday get consecutive columns; the next Monday follows Friday', () => {
    expect([0, 1, 2, 3, 4, 7].map((d) => s.toSlot(d))).toEqual([0, 1, 2, 3, 4, 5]);
    expect([0, 1, 2, 3, 4, 5].map(s.toDay)).toEqual([0, 1, 2, 3, 4, 7]);
  });
  it('a weekend day has no column of its own', () => {
    expect(s.toSlot(5, 'exact')).toBe(-1);
    expect(s.toSlot(6, 'ceil')).toBe(5); // → the Monday after
    expect(s.toSlot(6, 'floor')).toBe(4); // → the Friday before
  });
  it('round trip for every weekday, and a week starting on Sunday works the same', () => {
    for (let d = 0; d < 70; d++) if (s.toSlot(d, 'exact') >= 0) expect(s.toDay(s.toSlot(d))).toBe(d);
    const sun = weekdaysOnly(70, 0); // day 0 is a Sunday
    expect(sun.toSlot(0, 'exact')).toBe(-1);
    expect(sun.toDay(0)).toBe(1); // first column: Monday
    expect(sun.toDay(4)).toBe(5); // Friday
    expect(sun.toDay(5)).toBe(8); // next Monday
  });
  it('50 weeks of days → 250 columns; weekends shown is the identity', () => {
    expect(weekdaysOnly(350, 1).total).toBe(250);
    const a = allDays(10);
    expect([a.toSlot(3), a.toDay(3), a.total]).toEqual([3, 3, 10]);
  });
});
