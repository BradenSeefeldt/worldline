// Time-zone and daylight-saving regressions, made with the real edit actions (lib/mutate.ts, the quick-add box,
// commands) rather than hand-made data. The clock is pinned to Toronto here — west of UTC, with daylight saving
// (Mar 8 2026 is a 23-hour day, Nov 1 a 25-hour one) — so this file behaves the same on every machine; a few
// tests then travel to Tokyo. (The rest of the suite is written not to depend on the machine's zone.)
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { toIcs } from './icsExport';
import { parseIcs } from './ics';
import { encodeEvent, expand, resolveEvent } from './recurrence';
import { endSeries, removeEvent, updateEvent } from './mutate';
import { parseQuick } from './quickparse';
import { parseCommand } from './commands';
import { upcomingAlerts } from './alerts';
import { TOTAL_DAYS, dayIndex, earliestEnd, shiftWall, weekStart } from './dates';
import { weekdaysOnly } from './slots';
import { DEFAULT_CALENDARS } from '../data/mock';
import type { CalEvent } from '../data/types';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const hostTz = env.TZ;
const setTz = (tz: string) => { env.TZ = tz; };
beforeAll(() => setTz('America/Toronto'));
afterEach(() => setTz('America/Toronto'));
afterAll(() => { if (hostTz === undefined) delete env.TZ; else env.TZ = hostTz; });

const t = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
const day = (y: number, m: number, d: number) => t(y, m, d);
const fmt = (ms: number) => format(ms, 'EEE MMM d HH:mm');
const fmtDay = (ms: number) => format(ms, 'EEE MMM d');
let n = 0;
const newId = () => `x${n++}`;
// what the store does when it adds an event: all-day ones are stored as dates
const add = (e: CalEvent) => encodeEvent(e);

describe('.ics export reads back what the actions made (H7, H8, H9)', () => {
  it('H7: a moved occurrence survives export (the master skips it and the override replaces it)', () => {
    const series = add({ id: 's', calendarId: 'c', title: 'Group meeting', start: t(2026, 9, 5, 15), end: t(2026, 9, 5, 16), allDay: false, timeZone: 'America/Toronto', recurrence: { freq: 'weekly', interval: 1, byDay: [1] } });
    const moved = updateEvent([series], `s@${t(2026, 9, 19, 15)}`, { start: t(2026, 9, 20, 16), end: t(2026, 9, 20, 17) }, 'this', newId).events;
    const back = parseIcs(toIcs('C', moved), 'x', t(2026, 9, 1), t(2026, 10, 1));
    expect(back.events.map((e) => fmt(e.start)).sort()).toEqual(['Mon Oct 12 15:00', 'Mon Oct 26 15:00', 'Mon Oct 5 15:00', 'Tue Oct 20 16:00']);
  });
  it('H8: an all-day series’ skipped and moved days are written on their own dates, west of UTC', () => {
    let evs = [add({ id: 'a', calendarId: 'c', title: 'Gym', start: day(2026, 9, 5), end: day(2026, 9, 6), allDay: true, recurrence: { freq: 'weekly', interval: 1, byDay: [1] } })];
    evs = removeEvent(evs, `a@${Date.UTC(2026, 9, 12)}`, 'this');
    evs = updateEvent(evs, `a@${Date.UTC(2026, 9, 19)}`, { start: day(2026, 9, 20), end: day(2026, 9, 21) }, 'this', newId).events;
    const text = toIcs('C', evs);
    expect(text).toContain('EXDATE;VALUE=DATE:20261012');
    expect(text).toContain('RECURRENCE-ID;VALUE=DATE:20261019');
    expect(text).not.toContain('20261011');
    expect(text).not.toContain('20261018');
    const back = parseIcs(text, 'x', t(2026, 9, 1), t(2026, 10, 1));
    expect(back.events.map((e) => fmtDay(e.start)).sort()).toEqual(['Mon Oct 26', 'Mon Oct 5', 'Tue Oct 20']);
  });
  it('H9: an all-day series made with "until oct 20" ends on Oct 20 — here, in Tokyo, and in its .ics', () => {
    const NOW = new Date(2026, 9, 7, 19, 10);
    const p = parseQuick('Conference daily until oct 20', DEFAULT_CALENDARS, NOW);
    expect(p.allDay).toBe(true);
    const stored = add({ id: 'c', calendarId: 'c', title: p.title, start: +p.start, end: +p.end, allDay: true, recurrence: p.recurrence });
    expect(stored.recurrence!.until).toBe(Date.UTC(2026, 9, 20)); // a date, not an instant
    const last = () => fmtDay(expand([stored], t(2026, 9, 1), t(2026, 10, 1)).pop()!.start);
    expect(last()).toBe('Tue Oct 20');
    for (const tz of ['Asia/Tokyo', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
      setTz(tz);
      expect([tz, last()]).toEqual([tz, 'Tue Oct 20']);
    }
    setTz('America/Toronto');
    const text = toIcs('C', [stored]);
    expect(text).toContain('UNTIL=20261020');
    expect(text).not.toMatch(/UNTIL=\d{8}T/);
    expect(parseIcs(text, 'x', t(2026, 9, 1), t(2026, 10, 1)).events.map((e) => fmtDay(e.start)).pop()).toBe('Tue Oct 20');
  });
  it('H9: an all-day series saved by an older version (until = an instant) still ends on its day; ending one stores a date', () => {
    const legacy: CalEvent = { id: 'l', calendarId: 'c', title: 'Old', start: Date.UTC(2026, 9, 5), end: Date.UTC(2026, 9, 6), allDay: true, recurrence: { freq: 'daily', interval: 1, until: t(2026, 9, 20, 23, 59, ) + 59_999 } };
    expect(fmtDay(expand([legacy], t(2026, 9, 1), t(2026, 10, 1)).pop()!.start)).toBe('Tue Oct 20');
    const ended = endSeries([legacy], 'l', t(2026, 9, 12, 15));
    expect(ended[0].recurrence!.until).toBe(Date.UTC(2026, 9, 12));
    expect(fmtDay(expand(ended, t(2026, 9, 1), t(2026, 10, 1)).pop()!.start)).toBe('Mon Oct 12');
    // an old export's UNTIL (an instant: the end of Oct 20 in Toronto) on a date start reads as Oct 20, not Oct 21/22
    const old = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:o', 'DTSTART;VALUE=DATE:20261015', 'DTEND;VALUE=DATE:20261016', 'RRULE:FREQ=DAILY;UNTIL=20261021T035959Z', 'SUMMARY:Old', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    expect(fmtDay(parseIcs(old, 'x', t(2026, 9, 1), t(2026, 10, 1)).events.pop()!.start)).toBe('Tue Oct 20');
  });
});

describe('"All events" moves count days and wall-clock time (M11, M12)', () => {
  it('M11: a weekly Friday 10:00 series dragged across the DST change to Monday 10:00 stays at 10:00', () => {
    const s: CalEvent = { id: 'f', calendarId: 'c', title: 'Coffee', start: t(2026, 0, 2, 10), end: t(2026, 0, 2, 11), allDay: false, timeZone: 'America/Toronto', recurrence: { freq: 'weekly', interval: 1, byDay: [5] } };
    const r = updateEvent([s], `f@${t(2026, 2, 6, 10)}`, { start: t(2026, 2, 9, 10), end: t(2026, 2, 9, 11) }, 'all', newId);
    expect(expand(r.events, t(2026, 2, 1), t(2026, 2, 24)).map((e) => fmt(e.start))).toEqual(['Mon Mar 2 10:00', 'Mon Mar 9 10:00', 'Mon Mar 16 10:00', 'Mon Mar 23 10:00']);
    expect(resolveEvent(r.events, r.id)?.start).toBe(t(2026, 2, 9, 10)); // still selected
  });
  it('M11: an all-day Sunday series dragged from Mar 8 (a 23-hour day) to Monday stays one day long', () => {
    const s = add({ id: 'g', calendarId: 'c', title: 'Long run', start: day(2026, 2, 1), end: day(2026, 2, 2), allDay: true, recurrence: { freq: 'weekly', interval: 1, byDay: [0] } });
    const r = updateEvent([s], `g@${Date.UTC(2026, 2, 8)}`, { start: day(2026, 2, 9), end: day(2026, 2, 10) }, 'all', newId);
    const occ = expand(r.events, t(2026, 2, 1), t(2026, 2, 24));
    expect(occ.map((e) => fmtDay(e.start))).toEqual(['Mon Mar 2', 'Mon Mar 9', 'Mon Mar 16', 'Mon Mar 23']);
    expect(occ.every((e) => dayIndex(e.end) - dayIndex(e.start) === 1)).toBe(true);
    expect(resolveEvent(r.events, r.id) && fmtDay(resolveEvent(r.events, r.id)!.start)).toBe('Mon Mar 9');
  });
  it('M12: dragging a Mon + Wed series a day later ("all") makes it Tue + Thu', () => {
    const s: CalEvent = { id: 'mw', calendarId: 'c', title: 'Lab', start: t(2026, 9, 5, 9), end: t(2026, 9, 5, 10), allDay: false, recurrence: { freq: 'weekly', interval: 1, byDay: [1, 3] } };
    const r = updateEvent([s], `mw@${t(2026, 9, 12, 9)}`, { start: t(2026, 9, 13, 9), end: t(2026, 9, 13, 10) }, 'all', newId);
    expect(expand(r.events, t(2026, 9, 12), t(2026, 9, 19)).map((e) => fmtDay(e.start))).toEqual(['Tue Oct 13', 'Thu Oct 15']);
  });
  it('M12: “push all gym sessions 1 day later” turns a Monday series into a Tuesday one', () => {
    const NOW = new Date(2026, 9, 7, 19, 10);
    const gym: CalEvent = { id: 'gym', calendarId: 'personal', title: 'Gym', start: t(2026, 8, 7, 7), end: t(2026, 8, 7, 8), allDay: false, recurrence: { freq: 'weekly', interval: 1, byDay: [1] } };
    const shown = expand([gym], NOW.getTime() - 30 * 86_400_000, NOW.getTime() + 60 * 86_400_000);
    const c = parseCommand('push all gym sessions 1 day later', shown, DEFAULT_CALENDARS, NOW, [gym])!;
    expect(c.series).toBe(true);
    const patch = c.plan(gym)!;
    expect(patch.recurrence?.byDay).toEqual([2]);
    const after = updateEvent([gym], 'gym', patch, 'this', newId).events; // what the quick-add box does with it
    expect(expand(after, t(2026, 9, 12), t(2026, 9, 26)).map((e) => fmt(e.start))).toEqual(['Tue Oct 13 07:00', 'Tue Oct 20 07:00']);
  });
});

describe('dragging in the grid (M13), alerts (L7), all-day ends (L11)', () => {
  it('M13: with weekends hidden, Friday’s column → Monday’s is 3 days later', () => {
    const S = weekdaysOnly(TOTAL_DAYS, weekStart()); // the grid's columns, as TimeGrid makes them
    const fri = S.toSlot(dayIndex(t(2026, 9, 16)), 'exact');
    const mon = S.toSlot(dayIndex(t(2026, 9, 19)), 'exact');
    expect(mon - fri).toBe(1); // neighbouring columns…
    const moved = shiftWall(t(2026, 9, 16, 14), S.toDay(mon) - S.toDay(fri), 0); // …as TimeGrid computes the move
    expect(fmt(moved)).toBe('Mon Oct 19 14:00');
  });
  it('M13: a move on a DST day sets the wall clock (1:00 dragged down 3 hours is 4:00, not 5:00)', () => {
    expect(fmt(shiftWall(t(2026, 2, 8, 1), 0, 180))).toBe('Sun Mar 8 04:00');
    expect(fmt(shiftWall(t(2026, 2, 7, 10), 1, 0))).toBe('Sun Mar 8 10:00');
    expect(fmt(shiftWall(t(2026, 9, 31, 22), 1, 60))).toBe('Sun Nov 1 23:00');
  });
  it('L7: all-day alerts are at 9 AM on the wall clock on DST days', () => {
    const D = { alertMin: 10, alertAllDayMin: -540, alertDeadlineMin: 60 };
    const cal = { id: 'c', name: 'P', color: '#000', visible: true, account: 'Local' };
    const onDay = add({ id: 'a', calendarId: 'c', title: 'Spring', start: day(2026, 2, 8), end: day(2026, 2, 9), allDay: true });
    const fall = add({ id: 'b', calendarId: 'c', title: 'Fall', start: day(2026, 10, 1), end: day(2026, 10, 2), allDay: true });
    const dayBefore = add({ id: 'c', calendarId: 'c', title: 'After', start: day(2026, 2, 9), end: day(2026, 2, 10), allDay: true, alert: 900 });
    const at = (e: CalEvent) => fmt(upcomingAlerts([e], [cal], D, t(2026, 1, 25), t(2026, 11, 1))[0].at);
    expect(at(onDay)).toBe('Sun Mar 8 09:00');
    expect(at(fall)).toBe('Sun Nov 1 09:00');
    expect(at(dayBefore)).toBe('Sun Mar 8 09:00');
  });
  it('L11: an all-day event can’t end before it starts — it keeps its one day (a 23-hour one here)', () => {
    const start = day(2026, 2, 8);
    expect(Math.max(day(2026, 2, 5), earliestEnd(start, true))).toBe(day(2026, 2, 9));
    expect(earliestEnd(t(2026, 2, 8, 10), false)).toBe(t(2026, 2, 8, 10, 15));
  });
});
