// Viewing the calendar from another time zone (as when travelling). Runs with the clock in Tokyo.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'Asia/Tokyo';
import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { TZDate } from '@date-fns/tz';
import { expand } from './recurrence';
import { decodeDay, encodeDay, fmtOffset, zoneAbbr, zoneCity, zoneOffset } from './zone';
import type { CalEvent } from '../data/types';

const toronto = (m: number, d: number, h: number) => new TZDate(2026, m, d, h, 0, 'America/Toronto').getTime();
const fmt = (t: number) => format(t, 'EEE MMM d HH:mm');

describe('travelling (this machine is in Tokyo)', () => {
  it('a weekly 3 PM Toronto meeting follows Toronto’s clock, including its DST change', () => {
    const alex: CalEvent = {
      id: 'b', calendarId: 'research', title: 'Alex', allDay: false, timeZone: 'America/Toronto',
      start: toronto(9, 9, 15), end: toronto(9, 9, 16), recurrence: { freq: 'weekly', interval: 1, byDay: [5] },
    };
    const occ = expand([alex], new Date(2026, 9, 15).getTime(), new Date(2026, 10, 10).getTime()).map((e) => fmt(e.start));
    // Toronto is UTC−4 until Nov 1, then UTC−5; Tokyo is always UTC+9.
    expect(occ).toEqual(['Sat Oct 17 04:00', 'Sat Oct 24 04:00', 'Sat Oct 31 04:00', 'Sat Nov 7 05:00']);
  });
  it('an all-day event stays on its date, including ones saved by older versions', () => {
    const stored = Date.UTC(2026, 9, 20);
    expect(format(decodeDay(stored), 'MMM d HH:mm')).toBe('Oct 20 00:00');
    const legacyToronto = new Date('2026-10-20T04:00:00Z').getTime(); // "midnight Toronto"
    expect(format(decodeDay(legacyToronto), 'MMM d')).toBe('Oct 20');
    expect(encodeDay(new Date(2026, 9, 20).getTime())).toBe(stored);
  });
  it('names zones', () => {
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneAbbr('America/Toronto', toronto(9, 9, 15))).toBe('EDT');
    expect(zoneAbbr('Europe/Paris', toronto(9, 9, 15))).toBe('CEST');
    expect(fmtOffset(zoneOffset('Asia/Kolkata'))).toBe('UTC+5:30');
    expect(fmtOffset(zoneOffset('America/Toronto', toronto(9, 9, 15)))).toBe('UTC−4');
  });
});
