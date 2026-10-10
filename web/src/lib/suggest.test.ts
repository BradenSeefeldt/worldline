import { describe, expect, it } from 'vitest';
import { suggest } from './suggest';
import { DEFAULT_CALENDARS } from '../data/mock';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 9, 7, 19, 10); // Wed Oct 7 2026, 7:10 PM
let n = 0;
const ev = (title: string, month: number, d: number, h: number, m = 0, mins = 60, cal = 'research'): CalEvent => {
  const start = new Date(2026, month, d, h, m).getTime();
  return { id: `e${n++}`, calendarId: cal, title, start, end: start + mins * 60_000, allDay: false };
};
/** A weekly series: `count` occurrences ending at (month, day). */
const weekly = (title: string, month: number, lastDay: number, count: number, h: number, m = 0, mins = 60, step = 7) =>
  Array.from({ length: count }, (_, k) => ev(title, month, lastDay - k * step, h, m, mins));

const BASE: CalEvent[] = [
  ...weekly('Meeting with Alex', 9, 2, 6, 14), // Fridays to Oct 2; none this week
  ...weekly('Journal club', 9, 23, 9, 11), // Fridays, including this week and beyond
  ...weekly('Dept lunch talk', 9, 15, 8, 12), // Thursdays, incl. tomorrow
  ...weekly('Jordan — BAL winds', 8, 30, 3, 14, 0, 60, 14), // every other Wednesday: Sep 2, 16, 30
  ...weekly('Coffee with Ana', 5, 9, 6, 10), // Tuesdays — last in June: months ago
  ev('Telecon with Sasha', 9, 8, 12, 30, 30), // clashes with tomorrow's lunch talk
];
const run = (events = BASE, extra = {}) => suggest(events, DEFAULT_CALENDARS, { now: NOW, ...extra });
const phrases = (events?: CalEvent[], extra?: object) => run(events, extra).map((s) => s.phrase);

describe('suggestions', () => {
  it('suggests a regular meeting that is missing this week, at its usual time and calendar', () => {
    const s = run().find((x) => x.phrase.startsWith('Meeting with Alex'));
    expect(s?.phrase).toBe('Meeting with Alex friday at 2pm #research');
    expect(s?.reason).toContain('Usually Fridays at 2pm');
  });
  it('handles every-other-week meetings', () => {
    expect(phrases()).toContain('Jordan — BAL winds wednesday at 2pm #research');
  });
  it('does not suggest something you have not done in months', () => {
    expect(phrases().some((p) => p.includes('Ana'))).toBe(false);
  });
  it('does not suggest a meeting that has stopped (no Alex for 5 weeks)', () => {
    const stale = BASE.filter((e) => !(e.title === 'Meeting with Alex' && e.start > new Date(2026, 8, 1).getTime()));
    expect(phrases(stale).some((p) => p.includes('Alex'))).toBe(false);
  });
  it('does not re-suggest what you deliberately skipped or dismissed', () => {
    const skipped = [{ key: 'alex', at: new Date(2026, 9, 9, 14).getTime() }];
    expect(phrases(BASE, { skipped }).some((p) => p.includes('Alex'))).toBe(false);
    const id = run().find((x) => x.phrase.includes('Alex'))!.id;
    expect(phrases(BASE, { dismissed: [id] }).some((p) => p.includes('Alex'))).toBe(false);
  });
  it('counts a regular meeting moved to another day as present', () => {
    const moved = [...BASE, ev('Meeting with Alex', 9, 8, 15)]; // Thursday this week instead of Friday
    expect(phrases(moved).some((p) => p.startsWith('Meeting with Alex'))).toBe(false);
  });
  it('offers to move the one-off event out of a clash, to the nearest free slot', () => {
    expect(phrases()).toContain('Move Telecon with Sasha to tomorrow at 1pm');
  });
  it('offers to push back something starting soon', () => {
    const soon = [...BASE, ev('Group meeting', 9, 7, 20)];
    const s = run(soon).find((x) => x.kind === 'late');
    expect(s?.phrase).toBe('Push Group meeting back 15 min');
    expect(s?.reason).toBe('Starts in 50 min');
  });
  it('offers to skip the next regular meeting', () => {
    expect(phrases()).toContain('Skip Dept lunch talk tomorrow');
    expect(phrases()).toContain('Skip Journal club friday');
  });
  it('does not offer to skip something you just added', () => {
    const fresh = BASE.map((e) =>
      e.title === 'Dept lunch talk' ? { ...e, createdAt: NOW.getTime() - 60_000 } : e,
    );
    expect(phrases(fresh)).not.toContain('Skip Dept lunch talk tomorrow');
  });
  it('nothing to suggest on an empty calendar', () => {
    expect(run([])).toEqual([]);
  });
});

describe('suggestions for deadlines', () => {
  const due = (title: string, m: number, d: number, extra: Partial<CalEvent> = {}): CalEvent => {
    const t = new Date(2026, m, d, 17).getTime();
    return { id: `d-${title}`, calendarId: 'research', title, start: t, end: t, allDay: false, kind: 'deadline', ...extra };
  };
  it('offers a focus block for a deadline in its runway with nothing scheduled', () => {
    const s = run([...BASE, due('NSERC proposal', 9, 16)]).find((x) => x.kind === 'focus');
    expect(s?.phrase).toBe('Work on NSERC proposal tomorrow at 9am for 3h');
    expect(s?.reason).toContain('Due in 9 days');
  });
  it('two deadlines get two different focus slots', () => {
    const f = run([...BASE, due('NSERC proposal', 9, 16), due('Referee report', 9, 14)]).filter((x) => x.kind === 'focus').map((x) => x.phrase);
    expect(f).toEqual(['Work on Referee report tomorrow at 9am for 3h', 'Work on NSERC proposal tomorrow at 1pm for 3h']);
  });
  it('not when work is already scheduled, it is done, or still far off', () => {
    const work = ev('NSERC writing', 9, 12, 9, 0, 180);
    expect(run([...BASE, due('NSERC proposal', 9, 16), work]).some((x) => x.kind === 'focus')).toBe(false);
    expect(run([...BASE, due('NSERC proposal', 9, 16, { done: true })]).some((x) => x.kind === 'focus')).toBe(false);
    expect(run([...BASE, due('NSERC proposal', 11, 18)]).some((x) => x.kind === 'focus')).toBe(false);
  });
});

describe('suggestions for stale tasks', () => {
  it('nudges a task overdue 3+ days, not a fresh one', () => {
    const day = (d: number) => Date.UTC(2026, 9, d);
    const tasks = [
      { id: 'a', title: 'Call the bank', due: day(2), createdAt: 1 },
      { id: 'b', title: 'Pay rent', due: day(6), createdAt: 2 },
    ];
    const s = run(BASE, { tasks }).filter((x) => x.kind === 'stale');
    expect(s.map((x) => x.phrase)).toEqual(['Move Call the bank to tomorrow']);
    expect(s[0].reason).toContain('Overdue 5 days');
  });
});

describe('habit nudges', () => {
  const gymHabit = { id: 'g', title: 'Gym', color: '#000', kind: 'check' as const, goal: 3, period: 'week' as const, match: 'gym', createdAt: 0 };
  const gyms = [...weekly('Gym', 9, 5, 6, 7, 30)]; // Mondays at 7:30 for 6 weeks, incl. this Monday (Oct 5)
  it('a weekly habit falling behind gets one at your usual time, on the first free day', () => {
    const s = run([...BASE, ...gyms], { habits: [gymHabit], habitLog: {} }).find((x) => x.kind === 'habit');
    expect(s?.phrase).toBe('Gym tomorrow at 7:30am');
    expect(s?.reason).toBe('Gym: 1 of 3 this week · 2 to go');
  });
  it('no nudge once enough are done or booked, before Wednesday, or for archived habits', () => {
    const booked = [ev('Gym', 9, 9, 7, 30), ev('Gym', 9, 10, 9)];
    expect(run([...BASE, ...gyms, ...booked], { habits: [gymHabit] }).some((x) => x.kind === 'habit')).toBe(false);
    const monday = suggest([...BASE, ...gyms], DEFAULT_CALENDARS, { now: new Date(2026, 9, 5, 19), habits: [gymHabit] });
    expect(monday.some((x) => x.kind === 'habit')).toBe(false);
    expect(run([...BASE, ...gyms], { habits: [{ ...gymHabit, archived: true }] }).some((x) => x.kind === 'habit')).toBe(false);
  });
});
