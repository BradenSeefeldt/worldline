import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { bestTimes, heat, isFinished, meetingAt, newLink, publicView, stillOpen, type BookingLink } from './booking';
import { epochDay } from './zone';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 9, 7, 19, 10).getTime(); // Wed Oct 7 2026, 7:10 PM (Toronto)
const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const ev = (title: string, d: number, h: number, mins: number, cal = 'research', extra: Partial<CalEvent> = {}): CalEvent => ({
  id: title, calendarId: cal, title, start: t(d, h), end: t(d, h) + mins * 60_000, allDay: false, ...extra,
});
const EVENTS: CalEvent[] = [
  ev('Secret meeting with the dean', 8, 10, 60), // Thu 10–11
  ev('Gym', 8, 13, 60, 'personal'), // Personal calendar
  ev('Birthday', 8, 0, 1440, 'personal', { allDay: true }),
];
const FIVE_WEEKDAYS = [8, 9, 12, 13, 14].map((d) => epochDay(2026, 9, d)); // Thu Oct 8 … Wed Oct 14
const fresh = () => newLink({ id: 'L1', mode: 'book', hostName: 'Sam', calendars: [{ id: 'research', visible: true }, { id: 'personal', visible: true }], calendarId: 'research', timeZone: 'America/Toronto', now: NOW });
const base = (extra: Partial<BookingLink> = {}): BookingLink => ({ ...fresh(), days: FIVE_WEEKDAYS, firstDay: FIVE_WEEKDAYS[0], lastDay: FIVE_WEEKDAYS[4], ...extra });

describe('booking links', () => {
  it('offers open times only, around busy time (+ buffer), on the chosen days', () => {
    const v = publicView(base({ bufferMin: 0, durationMin: 30 }), EVENTS, NOW);
    const thu = v.days.find((d) => format(d.slots[0], 'EEE MMM d') === 'Thu Oct 8')!;
    const times = thu.slots.map((s) => format(s, 'HH:mm'));
    expect(times).not.toContain('10:00');
    expect(times).not.toContain('10:30');
    expect(times).toContain('11:00');
    expect(times).not.toContain('13:00'); // gym (Personal blocks too)
    expect(times).toContain('09:00');
    expect(times).toContain('16:30'); // a 30-min meeting may end exactly at the 17:00 window end
    expect(times).not.toContain('17:00');
  });
  it('the buffer keeps space around events', () => {
    const thu = publicView(base({ bufferMin: 10, durationMin: 30 }), EVENTS, NOW).days[0];
    expect(thu.slots.map((s) => format(s, 'HH:mm'))).not.toContain('09:30'); // ends 10:00, too close to 10:00
  });
  it('only the chosen calendars block; all-day events never do', () => {
    const v = publicView(base({ blockingCalendars: ['research'], bufferMin: 0, durationMin: 30 }), EVENTS, NOW);
    expect(v.days[0].slots.map((s) => format(s, 'HH:mm'))).toContain('13:00');
  });
  it('never reveals what you are doing', () => {
    const json = JSON.stringify(publicView(base(), EVENTS, NOW));
    expect(json).not.toContain('dean');
    expect(json).not.toContain('Gym');
    expect(json).not.toContain('research'); // not even calendar ids
  });
  it('weekends and short notice are excluded', () => {
    const v = publicView(base({ noticeMin: 12 * 60, days: undefined, firstDay: base().firstDay, lastDay: base().firstDay + 13 }), EVENTS, NOW);
    expect(v.days.every((d) => ![0, 6].includes(new Date(d.slots[0]).getDay()))).toBe(true);
    expect(v.days[0].slots.every((s) => s >= NOW + 12 * 3_600_000)).toBe(true);
  });
  it('a slot that got taken in the meantime is no longer open', () => {
    const link = base({ bufferMin: 0, durationMin: 30 });
    expect(stillOpen(link, EVENTS, t(8, 11), NOW)).toBe(true);
    expect(stillOpen(link, [...EVENTS, ev('booked', 8, 11, 30)], t(8, 11), NOW)).toBe(false);
  });
  it('the window is on the host’s clock even for a guest elsewhere', () => {
    const v = publicView(base({ bufferMin: 0, noticeMin: 0 }), [], NOW);
    expect(format(v.days[0].slots[0], 'HH:mm')).toBe('09:00'); // this machine is in Toronto, like the host
  });
  it('defaults: an hour, no buffer, any notice, single use — and no days until you pick them', () => {
    const l = fresh();
    expect(l).toMatchObject({ durationMin: 60, bufferMin: 0, noticeMin: 0, singleUse: true, days: [] });
    expect(publicView(l, [], NOW).days).toEqual([]);
    expect(isFinished(l, NOW)).toBe(false); // an empty new link isn't "finished"
    expect(publicView(base(), [], NOW).days.map((d) => format(d.slots[0], 'EEE d'))).toEqual(['Thu 8', 'Fri 9', 'Mon 12', 'Tue 13', 'Wed 14']);
  });
  it('picked days are exactly the days offered; finished once they have passed', async () => {
    const { isFinished } = await import('./booking');
    const l = base({ days: [base().firstDay + 6, base().firstDay + 1] }); // Wed 14, Fri 9 (any order)
    expect(publicView(l, [], NOW).days.map((d) => format(d.slots[0], 'EEE d'))).toEqual(['Fri 9', 'Wed 14']);
    expect(isFinished(l, NOW)).toBe(false);
    expect(isFinished(l, new Date(2026, 9, 15).getTime())).toBe(true);
    expect(publicView(l, [], NOW, 'Sam').hostName).toBe('Sam'); // name from Settings
  });
  it('a booked link stays in view until its meeting is over', async () => {
    const { isFinished } = await import('./booking');
    const l = base({ closed: true, finalStart: t(9, 14) }); // Fri 2–3 PM
    expect(isFinished(l, NOW)).toBe(false);
    expect(isFinished(l, t(9, 14, 30))).toBe(false);
    expect(isFinished(l, t(9, 15))).toBe(true);
    expect(isFinished(base({ closed: true }), NOW)).toBe(true); // closed by hand
  });
});

describe('group polls', () => {
  const poll = (responses: BookingLink['responses']) => base({ mode: 'poll', durationMin: 60, bufferMin: 0, noticeMin: 0, responses });
  it('best times: most people free for the whole hour, you free too', () => {
    const cells = (h: number, n: number) => Array.from({ length: n }, (_, k) => t(9, h) + k * 30 * 60_000);
    const link = poll([
      { id: 'a', name: 'Ana', cells: [...cells(14, 4)], updatedAt: 0 }, // Fri 2–4
      { id: 'b', name: 'Bo', cells: [...cells(15, 2), ...cells(10, 2)], updatedAt: 0 }, // Fri 3–4, 10–11
    ]);
    const best = bestTimes(link, publicView(link, EVENTS, NOW));
    expect(format(best[0].start, 'EEE HH:mm')).toBe('Fri 15:00');
    expect(best[0].names.sort()).toEqual(['Ana', 'Bo']);
    expect(best.every((b, i) => best.every((c, j) => i === j || Math.abs(b.start - c.start) >= 60 * 60_000))).toBe(true); // distinct options
  });
  it('any start time: whole meeting must be open, and only people free for all of it count', () => {
    const cells = (d: number, h: number, n: number) => Array.from({ length: n }, (_, k) => t(d, h) + k * 30 * 60_000);
    const link = poll([
      { id: 'a', name: 'Ana', cells: cells(9, 14, 4), updatedAt: 0 }, // Fri 2–4
      { id: 'b', name: 'Bo', cells: cells(9, 15, 1), updatedAt: 0 }, // Fri 3–3:30 only
    ]);
    const v = publicView(link, EVENTS, NOW);
    const h = heat(link.responses);
    expect(meetingAt(v, h, t(9, 14, 30), 60)).toMatchObject({ fits: true, names: ['Ana'] });
    expect(meetingAt(v, h, t(9, 15), 60).names).toEqual(['Ana']); // Bo leaves at 3:30
    expect(meetingAt(v, h, t(9, 16, 30), 60).fits).toBe(false); // runs past the 5 PM window
    expect(meetingAt(v, h, t(8, 9, 30), 60).fits).toBe(false); // Thu 10–11 you're busy
  });
  it('poll grid shows every day in range (even full ones) and only open cells are selectable', () => {
    const link = poll([]);
    const v = publicView(link, EVENTS, NOW);
    const thu = v.days.find((d) => d.day === v.days[0].day)!;
    expect(thu.slots.map((s) => format(s, 'HH:mm'))).not.toContain('10:00');
  });
});
