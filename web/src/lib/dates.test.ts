// Day indices count calendar days from a fixed date, in whatever zone the device is in now: travelling with the app
// open (the zone changes under it) mustn't shift the days or start them at 9 PM.
import { afterEach, describe, expect, it } from 'vitest';
import { dateAt, dayIndex, setWeekStart, weekStart } from './dates';

const zone0 = process.env.TZ;
afterEach(() => {
  process.env.TZ = zone0;
  setWeekStart(1);
});

describe('day indices', () => {
  it('stay on midnight and on the week’s first day after the zone changes', () => {
    for (const ws of [1, 0] as const) {
      setWeekStart(ws);
      process.env.TZ = 'America/Toronto';
      const i = dayIndex(new Date(2026, 9, 12, 15));
      for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC', 'Australia/Lord_Howe', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        const d = dateAt(i);
        expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 12, 0, 0]);
        expect(dayIndex(new Date(2026, 9, 12, 23, 59))).toBe(i);
        expect(dayIndex(new Date(2026, 9, 13, 0, 0))).toBe(i + 1);
        expect(dateAt(0).getDay()).toBe(weekStart());
        expect(dateAt(i - (i % 7)).getDay()).toBe(weekStart());
      }
    }
  });

  it('count calendar days across daylight-saving changes', () => {
    process.env.TZ = 'America/Toronto';
    const a = dayIndex(new Date(2026, 2, 7, 12));
    expect(dayIndex(new Date(2026, 2, 8, 12))).toBe(a + 1); // a 23-hour day
    expect(dayIndex(new Date(2026, 10, 1, 23, 30))).toBe(dayIndex(new Date(2026, 10, 1, 0, 30))); // a 25-hour day
    expect(dateAt(a + 1).getTime() - dateAt(a).getTime()).toBe(24 * 3_600_000);
    expect(dateAt(a + 2).getTime() - dateAt(a + 1).getTime()).toBe(23 * 3_600_000);
  });
});
