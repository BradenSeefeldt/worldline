import { describe, expect, it } from 'vitest';
import { toIcs } from './icsExport';
import { parseIcs } from './ics';
import { encodeEvent } from './recurrence';
import { removeEvent, updateEvent } from './mutate';
import { instantOf } from './zone';
import { isNewer, makeBackup, readBackup } from './backup';
import type { CalEvent } from '../data/types';

const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const to = (d: number, h: number) => instantOf(2026, 9, d, h * 60, 'America/Toronto'); // Toronto's clock
const ev = (x: Partial<CalEvent>): CalEvent => ({ id: 'e', calendarId: 'c', title: 'T', start: t(12, 10), end: t(12, 11), allDay: false, ...x });

describe('exporting a calendar as .ics', () => {
  it('reads back the same events (one-off, all-day, a weekly series with a skipped week and a moved one)', () => {
    // the series repeats on Toronto's clock, wherever this machine is; the skip and the move are made by the real actions
    const series = ev({ id: 's', title: 'Group meeting, weekly', start: to(5, 15), end: to(5, 16), timeZone: 'America/Toronto', recurrence: { freq: 'weekly', interval: 1, byDay: [1] } });
    let events = removeEvent([series], `s@${to(19, 15)}`, 'this');
    events = updateEvent(events, `s@${to(26, 15)}`, { start: to(27, 16), end: to(27, 17) }, 'this', () => 's-x').events;
    const text = toIcs('Research', [
      ev({ id: 'a', title: 'Talk; with notes', location: 'Room 1203', notes: 'line one\nline two' }),
      encodeEvent(ev({ id: 'b', title: 'Conference', allDay: true, start: new Date(2026, 9, 14).getTime(), end: new Date(2026, 9, 16).getTime() })),
      ...events,
      ev({ id: 'task', kind: 'task', title: 'not exported' }),
    ]);
    expect(text).not.toContain('not exported');
    const back = parseIcs(text, 'x', t(1, 0), t(31, 23));
    expect(back.name).toBe('Research');
    const by = (title: string) => back.events.filter((e) => e.title === title).sort((a, b) => a.start - b.start);
    expect(by('Talk; with notes')[0]).toMatchObject({ start: t(12, 10), end: t(12, 11), location: 'Room 1203', notes: 'line one\nline two' });
    expect(by('Conference')[0]).toMatchObject({ allDay: true, start: new Date(2026, 9, 14).getTime(), end: new Date(2026, 9, 16).getTime() });
    expect(by('Group meeting, weekly').map((e) => e.start)).toEqual([to(5, 15), to(12, 15), to(27, 16)]); // the 19th skipped, the 26th moved to the 27th
  });
  it('long lines are folded at 75 characters', () => {
    const text = toIcs('C', [ev({ title: 'x'.repeat(200) })]);
    expect(text.split('\r\n').every((l) => l.length <= 75)).toBe(true);
    expect(parseIcs(text, 'x', t(1, 0), t(31, 0)).events[0].title).toBe('x'.repeat(200));
  });
});

describe('backups', () => {
  it('a backup reads back; other files are refused with a reason', () => {
    const b = makeBackup({ events: [], calendars: [{ id: 'c' }] }, 2, '0.3.0');
    expect(readBackup(JSON.stringify(b), 2)).toMatchObject({ ok: true });
    expect(readBackup('not json', 2)).toMatchObject({ ok: false });
    expect(readBackup(JSON.stringify({ format: 'other' }), 2)).toMatchObject({ ok: false });
    expect(readBackup(JSON.stringify({ ...b, storeVersion: 3 }), 2)).toMatchObject({ ok: false, reason: expect.stringMatching(/newer/) });
  });
  it('version comparison', () => {
    expect(isNewer('v0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(isNewer('0.2.2', '0.3.0')).toBe(false);
  });
});
