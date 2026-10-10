// Commands and edits on recurring events.
import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { parseCommand } from './commands';
import { expand } from './recurrence';
import { endSeries, removeEvent, updateEvent } from './mutate';
import { DEFAULT_CALENDARS } from '../data/mock';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 9, 7, 19, 10); // Wed Oct 7 2026, 7:10 PM
const t = (m: number, d: number, h: number, min = 0) => new Date(2026, m, d, h, min).getTime();
const master = (id: string, title: string, start: number, byDay: number[], mins = 60): CalEvent => ({
  id, calendarId: 'research', title, start, end: start + mins * 60_000, allDay: false,
  recurrence: { freq: 'weekly', interval: 1, byDay },
});
const ALEX = master('alex', 'Meeting with Alex', t(8, 4, 15), [5]); // Fridays 3 PM since Sep 4
const PLASMA = master('plasma', 'Plasma meeting', t(8, 3, 11), [4]); // Thursdays 11 AM
const ONE_OFF: CalEvent = { id: 'x', calendarId: 'research', title: 'Alex thesis chat', start: t(9, 12, 10), end: t(9, 12, 11), allDay: false };
const RAW = [ALEX, PLASMA, ONE_OFF];
const window = (raw: CalEvent[]) => expand(raw, NOW.getTime() - 60 * 86_400_000, NOW.getTime() + 400 * 86_400_000);
const run = (s: string, raw = RAW) => parseCommand(s, window(raw), DEFAULT_CALENDARS, NOW, raw.filter((e) => e.recurrence))!;
const fmt = (ms: number) => format(ms, 'EEE MMM d HH:mm');
let n = 0;
const newId = () => `new${n++}`;

describe('commands on recurring series', () => {
  it('“Cancel all recurring events with Alex on Fridays as 3” stops the Alex series', () => {
    const c = run('Cancel all recurring events with Alex on Fridays as 3');
    expect(c.kind).toBe('delete');
    expect(c.series).toBe(true);
    expect(c.matches.map((e) => e.id)).toEqual(['alex']);
  });
  it('“cancel all Alex meetings” without a date also means the series', () => {
    expect(run('cancel all Alex meetings').series).toBe(true);
  });
  it('a wrong weekday or time does not match the series', () => {
    expect(run('cancel recurring Alex meeting on Mondays').series).toBeFalsy();
    expect(run('cancel recurring Alex meeting on Fridays at 10am').series).toBeFalsy();
  });
  it('“skip Alex meeting this week” is just this week’s occurrence', () => {
    const c = run('skip Alex meeting this week');
    expect(c.series).toBeFalsy();
    expect(c.matches[0].id).toBe(`alex@${t(9, 9, 15)}`);
  });
  it('“move weekly Alex meeting to thursdays at 4” changes the series day and time', () => {
    const c = run('move weekly Alex meeting to thursdays at 4');
    expect(c.series).toBe(true);
    const p = c.plan(ALEX)!;
    expect(format(p.start, 'EEE HH:mm')).toBe('Thu 16:00');
    expect(p.recurrence?.byDay).toEqual([4]);
  });
  it('“push all Alex meetings back 30 min” shifts the series', () => {
    const c = run('push all Alex meetings back 30 min');
    expect(c.series).toBe(true);
    expect(format(c.plan(ALEX)!.start, 'HH:mm')).toBe('15:30');
  });
  it('“move Alex meeting to monday at 2” moves one occurrence', () => {
    const c = run('move Alex meeting to monday at 2');
    expect(c.series).toBeFalsy();
    expect(c.matches[0].id).toBe(`alex@${t(9, 9, 15)}`); // this Friday's, nearest to Monday
    expect(fmt(c.plan(c.matches[0])!.start)).toBe('Mon Oct 12 14:00');
  });
});

describe('editing recurring events', () => {
  const occ = `alex@${t(9, 16, 15)}`;
  it('editing one occurrence creates an exception and leaves the rest', () => {
    const r = updateEvent(RAW, occ, { start: t(9, 16, 16), end: t(9, 16, 17) }, 'this', newId);
    const shown = expand(r.events, t(9, 12, 0), t(9, 25, 0)).filter((e) => e.title === 'Meeting with Alex').map((e) => fmt(e.start));
    expect(shown.sort()).toEqual(['Fri Oct 16 16:00', 'Fri Oct 23 15:00']);
    expect(r.id).toMatch(/^new/);
  });
  it('editing “all events” moves the whole series', () => {
    const r = updateEvent(RAW, occ, { start: t(9, 15, 15), end: t(9, 15, 16) }, 'all', newId); // Fri → Thu
    const shown = expand(r.events, t(9, 12, 0), t(9, 25, 0)).filter((e) => e.title === 'Meeting with Alex').map((e) => fmt(e.start));
    expect(shown).toEqual(['Thu Oct 15 15:00', 'Thu Oct 22 15:00']);
  });
  it('deleting one occurrence skips just that date', () => {
    const evs = removeEvent(RAW, occ, 'this');
    const shown = expand(evs, t(9, 12, 0), t(9, 25, 0)).filter((e) => e.title === 'Meeting with Alex').map((e) => fmt(e.start));
    expect(shown).toEqual(['Fri Oct 23 15:00']);
  });
  it('ending a series keeps past meetings and drops future ones', () => {
    const evs = endSeries(RAW, 'alex', NOW.getTime());
    const shown = expand(evs, t(8, 20, 0), t(9, 31, 0)).filter((e) => e.title === 'Meeting with Alex').map((e) => format(e.start, 'MMM d'));
    expect(shown).toEqual(['Sep 25', 'Oct 2']);
  });
});
