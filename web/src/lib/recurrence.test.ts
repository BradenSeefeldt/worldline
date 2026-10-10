import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { describeRecurrence, expand, occurrences, resolveEvent } from './recurrence';
import type { CalEvent, Recurrence } from '../data/types';

const t = (m: number, d: number, h = 15, min = 0) => new Date(2026, m, d, h, min).getTime();
const series = (r: Recurrence, start = t(9, 9), mins = 60, extra: Partial<CalEvent> = {}): CalEvent => ({
  id: 'm', calendarId: 'research', title: 'Meeting with Alex', start, end: start + mins * 60_000, allDay: false, recurrence: r, ...extra,
});
const days = (evs: CalEvent[]) => evs.map((e) => format(e.start, 'EEE MMM d HH:mm'));

describe('recurrence', () => {
  it('weekly on the start weekday', () => {
    const occ = occurrences(series({ freq: 'weekly', interval: 1 }), t(9, 1), t(9, 31));
    expect(days(occ)).toEqual(['Fri Oct 9 15:00', 'Fri Oct 16 15:00', 'Fri Oct 23 15:00', 'Fri Oct 30 15:00']);
  });
  it('every other week, several weekdays, until a date', () => {
    const occ = occurrences(series({ freq: 'weekly', interval: 2, byDay: [2, 4], until: t(10, 1) }, t(9, 6)), t(9, 1), t(11, 31));
    expect(days(occ)).toEqual(['Tue Oct 6 15:00', 'Thu Oct 8 15:00', 'Tue Oct 20 15:00', 'Thu Oct 22 15:00']);
  });
  it('daily, monthly, yearly', () => {
    expect(occurrences(series({ freq: 'daily', interval: 1 }), t(9, 9), t(9, 12, 0)).length).toBe(3);
    expect(days(occurrences(series({ freq: 'monthly', interval: 1 }, t(0, 31)), t(0, 1), t(5, 30)))).toEqual([
      'Sat Jan 31 15:00', 'Tue Mar 31 15:00', 'Sun May 31 15:00', // no Feb 31 / Apr 31
    ]);
    expect(occurrences(series({ freq: 'yearly', interval: 1 }), t(9, 1), new Date(2029, 0, 1).getTime()).length).toBe(3);
  });
  it('keeps wall-clock time across the November DST change', () => {
    const occ = occurrences(series({ freq: 'weekly', interval: 1 }, t(9, 30)), t(9, 1), t(10, 14));
    expect(days(occ)).toEqual(['Fri Oct 30 15:00', 'Fri Nov 6 15:00', 'Fri Nov 13 15:00']);
  });
  it('skipped dates are left out, and occurrence ids resolve back', () => {
    const m = series({ freq: 'weekly', interval: 1 }, t(9, 9), 60, { exdates: [t(9, 16)] });
    const occ = expand([m], t(9, 1), t(9, 31));
    expect(days(occ)).toEqual(['Fri Oct 9 15:00', 'Fri Oct 23 15:00', 'Fri Oct 30 15:00']);
    expect(resolveEvent([m], occ[1].id)?.start).toBe(t(9, 23));
    expect(resolveEvent([m], `m@${t(9, 16)}`)).toBeUndefined();
  });
  it('describes itself', () => {
    expect(describeRecurrence({ freq: 'weekly', interval: 1 }, t(9, 9))).toBe('Weekly on Friday');
    expect(describeRecurrence({ freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }, t(9, 9))).toBe('Every weekday');
    expect(describeRecurrence({ freq: 'weekly', interval: 2, byDay: [4, 2] }, t(9, 9))).toBe('Every 2 weeks on Tuesday and Thursday');
    expect(describeRecurrence({ freq: 'monthly', interval: 1, until: t(11, 15) }, t(9, 1))).toBe('Monthly on the 1st · until Dec 15');
  });
});
