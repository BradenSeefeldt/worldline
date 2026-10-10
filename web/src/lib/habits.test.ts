import { describe, expect, it } from 'vitest';
import { SKIP, amountOn, bestStreak, calendarCredit, habitsCsv, dayOf, describeGoal, periodProgress, strength, streak, sumBetween, tapAmount, totals, weekStart, weekdayRates, yearGrid, yearWeeks, type Habit, type HabitLog } from './habits';
import type { CalEvent } from '../data/types';

const day = (d: number) => dayOf(new Date(2026, 9, d, 12).getTime()); // October 2026
const TODAY = day(9); // Fri Oct 9
const habit = (extra: Partial<Habit> = {}): Habit => ({
  id: 'h', title: 'Gym', color: '#000', kind: 'check', goal: 1, period: 'day', createdAt: new Date(2026, 8, 1).getTime(), ...extra,
});
const logOn = (...days: number[]): HabitLog => ({ h: Object.fromEntries(days.map((d) => [d, 1])) });
const none = new Map<number, number>();

describe('habits', () => {
  it('weeks start on Monday', () => {
    expect(weekStart(day(9))).toBe(day(5)); // Fri → Mon Oct 5
    expect(weekStart(day(5))).toBe(day(5));
    expect(weekStart(day(11))).toBe(day(5)); // Sunday belongs to the week before
  });
  it('a calendar event that happened ticks a check habit (by title words, not deadlines/future)', () => {
    const ev = (title: string, d: number, extra: Partial<CalEvent> = {}): CalEvent => ({
      id: title + d, calendarId: 'personal', title, start: new Date(2026, 9, d, 7).getTime(), end: new Date(2026, 9, d, 8).getTime(), allDay: false, ...extra,
    });
    const now = new Date(2026, 9, 9, 12).getTime();
    const h = habit({ match: 'gym' });
    const auto = calendarCredit(h, [ev('Gym', 6), ev('Leg day at the GYM', 8), ev('Gym', 12), ev('Gym fees due', 7, { kind: 'deadline' })], now);
    expect([...auto.keys()].sort()).toEqual([day(6), day(8)]);
    expect(amountOn(h, {}, auto, day(6))).toBe(1);
    expect(calendarCredit(habit({ kind: 'count', match: 'gym' }), [ev('Gym', 6)], now).size).toBe(0);
  });
  it('weekly goals count Mon–Sun', () => {
    const h = habit({ goal: 3, period: 'week' });
    expect(periodProgress(h, logOn(day(4), day(5), day(7)), none, TODAY)).toEqual({ done: 2, goal: 3 }); // Sun 4 is last week
  });
  it('strength fills with practice, forgives one miss, and drains when you stop', () => {
    const h = habit({ createdAt: new Date(2026, 6, 1).getTime() });
    const every = Array.from({ length: 100 }, (_, k) => TODAY - k);
    const perfect = strength(h, logOn(...every), none, TODAY);
    expect(perfect).toBeGreaterThan(0.95);
    const oneMiss = strength(h, logOn(...every.filter((d) => d !== TODAY - 3)), none, TODAY);
    expect(perfect - oneMiss).toBeLessThan(0.07); // e^(-3/14)·(1-e^(-1/14)) ≈ 0.056
    const stopped = strength(h, logOn(...every.filter((d) => d < TODAY - 14)), none, TODAY);
    expect(stopped).toBeLessThan(0.4); // two weeks off ≈ e^-1
    // Today isn't over: not having done it yet costs nothing, doing it adds.
    const notYet = strength(h, logOn(...every.slice(1)), none, TODAY);
    const yesterdayEnd = strength(h, logOn(...every.slice(1)), none, TODAY - 1) + 0; // includes yesterday's credit
    expect(notYet).toBeGreaterThanOrEqual(yesterdayEnd);
    expect(perfect).toBeGreaterThan(notYet);
  });
  it('a weekly habit met on its schedule is full strength (not punished for rest days)', () => {
    const h = habit({ goal: 3, period: 'week', createdAt: new Date(2026, 3, 1).getTime() });
    const mwf: number[] = [];
    for (let d = TODAY - 180; d <= TODAY; d++) if ([0, 2, 4].includes(d - weekStart(d))) mwf.push(d);
    expect(strength(h, logOn(...mwf), none, TODAY)).toBeGreaterThan(0.9);
  });
  it('streaks count whole periods and wait for today', () => {
    const h = habit();
    expect(streak(h, logOn(TODAY - 1, TODAY - 2, TODAY - 3), none, TODAY)).toBe(3); // today not done yet
    expect(streak(h, logOn(TODAY, TODAY - 1, TODAY - 3), none, TODAY)).toBe(2);
    const w = habit({ goal: 2, period: 'week' });
    expect(streak(w, logOn(day(5), day(6), day(-2), day(-1)), none, TODAY)).toBe(2); // this week (Oct 5, 6) and last (Sep 28, 29)
    expect(streak(w, logOn(day(5), day(-2), day(-1)), none, TODAY)).toBe(1); // this week not met yet: last week still counts
  });
  it('one tap marks today done, a second tap clears it', () => {
    expect(tapAmount(habit(), {}, none, TODAY)).toBe(1);
    expect(tapAmount(habit(), logOn(TODAY), none, TODAY)).toBe(0);
    const read = habit({ kind: 'count', goal: 20, unit: 'pages' });
    expect(tapAmount(read, { h: { [TODAY]: 5 } }, none, TODAY)).toBe(20);
    expect(tapAmount(read, { h: { [TODAY]: 25 } }, none, TODAY)).toBe(0);
  });
  it('year grid: 53 Monday-first weeks, future days empty, partial days partly filled', () => {
    const read = habit({ kind: 'count', goal: 20 });
    const g = yearGrid(read, { h: { [TODAY]: 10 } }, none, TODAY);
    expect(g).toHaveLength(53);
    expect(g[52][4]).toBe(0.5); // Friday
    expect(g[52][5]).toBe(null); // Saturday hasn't happened
  });
  it('describes goals in words', () => {
    expect(describeGoal({ kind: 'check', goal: 3, period: 'week' })).toBe('3× a week');
    expect(describeGoal({ kind: 'check', goal: 1, period: 'day' })).toBe('Every day');
    expect(describeGoal({ kind: 'count', goal: 20, period: 'day', unit: 'pages' })).toBe('20 pages a day');
  });
});

describe('rest days and the long view', () => {
  it('a rest day keeps the streak and the strength (it is neither a hit nor a miss)', () => {
    const h = habit({ createdAt: new Date(2026, 6, 1).getTime() });
    const days = Array.from({ length: 60 }, (_, k) => TODAY - k);
    const withRest: HabitLog = { h: Object.fromEntries(days.map((d) => [d, d === TODAY - 2 ? SKIP : 1])) };
    const withMiss: HabitLog = { h: Object.fromEntries(days.filter((d) => d !== TODAY - 2).map((d) => [d, 1])) };
    expect(streak(h, withRest, none, TODAY)).toBe(59); // passes through the rest day, doesn't count it
    expect(streak(h, withMiss, none, TODAY)).toBe(2);
    expect(strength(h, withRest, none, TODAY)).toBeGreaterThan(strength(h, withMiss, none, TODAY));
    expect(amountOn(h, withRest, none, TODAY - 2)).toBe(0);
  });
  it('best streak remembers the longest run', () => {
    const h = habit();
    const log = logOn(day(1), day(2), day(3), day(4), day(6), day(7));
    expect(bestStreak(h, log, none, TODAY)).toEqual({ n: 4, end: day(4) });
  });
  it('totals by month and year, and between dates', () => {
    const h = habit({ kind: 'count', goal: 20, createdAt: new Date(2025, 11, 30).getTime() });
    const log: HabitLog = { h: { [dayOf(new Date(2025, 11, 31).getTime())]: 10, [day(1)]: 5, [day(2)]: 7 } };
    expect(totals(h, log, none, 'year', TODAY).map((b) => b.value)).toEqual([10, 12]);
    expect(totals(h, log, none, 'month', TODAY).at(-1)!.value).toBe(12);
    expect(sumBetween(h, log, none, day(1), day(1))).toBe(5);
  });
  it('weekday pattern: the share of Mondays, Tuesdays… done', () => {
    const h = habit({ createdAt: new Date(2026, 9, 5).getTime() }); // Mon Oct 5 → Fri Oct 9
    expect(weekdayRates(h, logOn(day(5), day(7)), none, TODAY).slice(0, 5)).toEqual([1, 0, 1, 0, 0]);
  });
  it('a calendar year as Monday-first weeks', () => {
    const w = yearWeeks(2026); // Jan 1 2026 is a Thursday
    expect(w[0].slice(0, 3)).toEqual([null, null, null]);
    expect(w[0][3]).toBe(dayOf(new Date(2026, 0, 1, 12).getTime()));
    expect(w.flat().filter((d) => d !== null)).toHaveLength(365);
    expect(yearGrid(habit(), logOn(TODAY), none, TODAY)[52][4]).toBe(1);
  });
});

describe('avoid habits, timed calendar credit, export', () => {
  it('avoid: a clean day succeeds untouched; a slip breaks the streak; at-most-N weekly limits', () => {
    const h = habit({ kind: 'avoid', goal: 0, createdAt: new Date(2026, 9, 1).getTime() });
    expect(streak(h, {}, none, TODAY)).toBe(9); // Oct 1–9, nothing logged = clean
    expect(streak(h, logOn(TODAY - 2), none, TODAY)).toBe(2);
    const w = habit({ kind: 'avoid', goal: 2, period: 'week', createdAt: new Date(2026, 9, 1).getTime() });
    expect(periodProgress(w, logOn(day(5), day(6)), none, TODAY)).toEqual({ done: 2, goal: 2 });
    expect(streak(w, logOn(day(5), day(6)), none, TODAY)).toBeGreaterThanOrEqual(1); // 2 slips ≤ 2 allowed
    expect(streak(w, logOn(day(5), day(6), day(7)), none, TODAY)).toBe(1); // this week broken; last week still clean
  });
  it('a timed count habit is credited by event length; what you log wins', () => {
    const ev = (d: number, h0: number, mins: number): CalEvent => ({
      id: `w${d}${h0}`, calendarId: 'research', title: 'Thesis writing', start: new Date(2026, 9, d, h0).getTime(), end: new Date(2026, 9, d, h0).getTime() + mins * 60_000, allDay: false,
    });
    const now = new Date(2026, 9, 9, 20).getTime();
    const h = habit({ kind: 'count', goal: 30, unit: 'min', match: 'writing' });
    const auto = calendarCredit(h, [ev(8, 9, 45), ev(8, 14, 30), ev(9, 9, 60)], now);
    expect(auto.get(day(8))).toBe(75);
    expect(amountOn(h, {}, auto, day(9))).toBe(60);
    expect(amountOn(h, { h: { [day(9)]: 20 } }, auto, day(9))).toBe(20); // logged by hand: yours wins
    expect(calendarCredit(habit({ kind: 'count', goal: 20, unit: 'pages', match: 'writing' }), [ev(8, 9, 45)], now).size).toBe(0);
    expect(calendarCredit(habit({ kind: 'count', goal: 2, unit: 'hours', match: 'writing' }), [ev(8, 9, 45)], now).get(day(8))).toBe(0.75);
  });
  it('CSV: one row per recorded day, quoting what needs it', () => {
    const h = habit({ title: 'Read, slowly', kind: 'count', goal: 20, unit: 'pages' });
    const csv = habitsCsv([h], { h: { [day(8)]: 12, [day(9)]: SKIP } }, { h: { [day(8)]: 'Dune, ch. 3' } }, () => none);
    expect(csv.split('\n')).toEqual([
      'date,habit,kind,amount,unit,status,note',
      '2026-10-08,"Read, slowly",count,12,pages,logged,"Dune, ch. 3"',
      '2026-10-09,"Read, slowly",count,,pages,rest,',
    ]);
  });
});

describe('nothing before a habit began (or after today) counts', () => {
  it('a new avoid habit shows only today as clean', () => {
    const h = habit({ kind: 'avoid', goal: 0, createdAt: new Date(2026, 9, 9, 9).getTime() }); // made this morning
    const g = yearGrid(h, {}, none, TODAY, 2);
    expect(g[1]).toEqual([null, null, null, null, 1, null, null]); // Mon–Thu: before it began; Sat, Sun: not yet
  });
});
