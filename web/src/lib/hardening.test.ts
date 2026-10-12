// What arrives from outside — a calendar feed, a guest on a scheduling link, another device's records — can't hang the
// app, inject lines into an export, or crash it at launch.
import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { parseIcs, MAX_FEED_EVENTS } from './ics';
import { toIcs } from './icsExport';
import { heat, newLink, publicView, type BookingLink } from './booking';
import { MAX_ANSWERS, MAX_BATCH, availToken, cleanName, mergeResponses, newLinkKeys, openGuestMsg, planBookings, refOf, sealGuestMsg, type Decoded } from './schedwire';
import { epochDay, instantOf } from './zone';
import { cleanEvent, cleanLink, cleanList } from '../data/validate';

const DAY = 86_400_000;
const feed = (rule: string, start = '20260101T090000Z') =>
  ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', `DTSTART:${start}`, 'DTEND:20260101T093000Z', 'SUMMARY:Spam', `RRULE:${rule}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

describe('a calendar feed’s repeat rules', () => {
  const from = Date.UTC(2025, 9, 1), to = Date.UTC(2028, 9, 1);
  it('every second / every minute: not expanded (it would take hours)', () => {
    const t0 = performance.now();
    expect(parseIcs(feed('FREQ=SECONDLY'), 'c', from, to).events).toHaveLength(0);
    expect(parseIcs(feed('FREQ=MINUTELY;INTERVAL=1'), 'c', from, to).events).toHaveLength(0);
    expect(parseIcs(feed('FREQ=DAILY;BYHOUR=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23;BYMINUTE=0,15,30,45'), 'c', from, to).events).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(500);
  });
  it('a long daily or hourly series: at most 5,000 occurrences each', () => {
    expect(parseIcs(feed('FREQ=DAILY'), 'c', from, to).events.length).toBeLessThanOrEqual(1100);
    const hourly = parseIcs(feed('FREQ=HOURLY', '20251001T000000Z'), 'c', from, to).events;
    expect(hourly.length).toBe(5000);
    expect(parseIcs(feed('FREQ=HOURLY', '19700101T000000Z'), 'c', from, to).events).toHaveLength(0); // from 1970: refused
  });
  it('at most 50,000 events from one feed', () => {
    const many = ['BEGIN:VCALENDAR', ...Array.from({ length: 12 }, (_, i) => ['BEGIN:VEVENT', `UID:u${i}`, 'DTSTART:20251001T000000Z', 'DTEND:20251001T001000Z', 'RRULE:FREQ=HOURLY', 'END:VEVENT']).flat(), 'END:VCALENDAR'].join('\r\n');
    expect(parseIcs(many, 'c', from, to).events.length).toBe(MAX_FEED_EVENTS);
  });
});

describe('an exported calendar', () => {
  it('keeps a title with a carriage return on one line (no property can be slipped in)', () => {
    const t = Date.UTC(2026, 9, 12, 15);
    const out = toIcs('Mine', [{ id: 'e', calendarId: 'c', title: 'Bob\rRRULE:FREQ=SECONDLY', start: t, end: t + 3_600_000, allDay: false, url: 'https://x.org/a b\r\nX-EVIL:1' }]);
    expect(out).not.toMatch(/\r\nRRULE/);
    expect(out).not.toMatch(/\r\nX-EVIL/);
    const back = parseIcs(out, 'c', t - DAY, t + DAY).events;
    expect(back).toHaveLength(1);
    expect(back[0].title).toBe('Bob\nRRULE:FREQ=SECONDLY');
  });
});

describe('a guest’s name', () => {
  it('is one line, without control characters or text-direction tricks', () => {
    expect(cleanName('  Bob\r\nRRULE:x ')).toBe('Bob RRULE:x');
    expect(cleanName('Ali‮cod.exe')).toBe('Ali cod.exe');
    expect(cleanName('\u0007')).toBe('');
    expect(cleanName('x'.repeat(500))).toHaveLength(80);
  });
  it('is cleaned when the host opens a booking', () => {
    const keys = newLinkKeys();
    const ref = refOf(keys);
    const ev = sealGuestMsg({ t: 'book', start: Date.UTC(2026, 9, 12, 15), name: 'Eve\rX' }, ref, generateSecretKey(), 1);
    const d = openGuestMsg(ev, ref, hexToBytes(keys.sk));
    expect(d?.msg).toMatchObject({ name: 'Eve X' });
  });
});

describe('a flood on a scheduling link', () => {
  const TZ = 'America/Toronto';
  const NOW = instantOf(2026, 9, 7, 19 * 60, TZ);
  const days = Array.from({ length: 40 }, (_, i) => epochDay(2026, 9, 8 + i));
  const keys = newLinkKeys();
  const l = (mode: 'book' | 'poll' = 'book'): BookingLink => ({
    ...newLink({ id: 'L', mode, hostName: 'Sam', calendars: [{ id: 'w', visible: true }], calendarId: 'w', timeZone: TZ, now: NOW }),
    days, firstDay: days[0], lastDay: days[39], singleUse: false, nostr: keys,
  });
  it('1,000 booking requests are decided in well under a second, at most MAX_BATCH at a time', () => {
    const link = l();
    const slots = publicView(link, [], NOW).days.flatMap((d) => d.slots);
    const at = Math.floor(NOW / 1000);
    const msgs: Decoded[] = Array.from({ length: 1000 }, (_, i) => ({ pk: i.toString(16).padStart(64, '0'), id: `r${i}`, at, msg: { t: 'book', start: slots[i % slots.length], av: { at, tok: availToken(keys.sk, at) } } }));
    const t0 = performance.now();
    const { accepts, decisions } = planBookings(link, [], msgs, NOW);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(Object.keys(decisions)).toHaveLength(MAX_BATCH);
    expect(accepts.length).toBe(new Set(accepts.map((a) => a.start)).size); // never two in one time
  });
  it('a poll keeps at most MAX_ANSWERS answers (the earliest), and who’s-free takes linear time', () => {
    const link = l('poll');
    const cells = publicView(link, [], NOW).days.flatMap((d) => d.cells ?? []);
    const msgs: Decoded[] = Array.from({ length: 1000 }, (_, i) => ({ pk: i.toString(16).padStart(64, '0'), id: `p${i}`, at: 1000 + i, msg: { t: 'poll', name: `n${i}`, cells } }));
    const { responses } = mergeResponses(link, msgs, new Set(cells));
    expect(responses).toHaveLength(MAX_ANSWERS);
    expect(responses[0].name).toBe('n0');
    const t0 = performance.now();
    heat(responses);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('records from a backup or another device', () => {
  it('a broken link is repaired, not left to crash the app', () => {
    const [l] = cleanList([{ id: 'x' }, 7, { title: 'no id' }], cleanLink);
    expect(l).toMatchObject({ id: 'x', mode: 'book', bookings: [], responses: [], weekdays: [], blockingCalendars: [] });
    expect(() => publicView(l, [], Date.now())).not.toThrow();
  });
  it('a broken repeat rule is dropped; good events are kept as they are', () => {
    const good = { id: 'a', calendarId: 'c', title: 'A', start: 1, end: 2 };
    expect(cleanEvent(good)).toBe(good);
    expect(cleanEvent({ ...good, recurrence: { freq: 'secondly', interval: 1 } })?.recurrence).toBeUndefined();
    expect(cleanEvent({ ...good, recurrence: { freq: 'weekly', interval: -3, byDay: [1, 9, 'x'] }, exdates: [1, null] })).toMatchObject({ recurrence: { freq: 'weekly', interval: 1, byDay: [1] }, exdates: [1] });
    expect(cleanEvent({ ...good, start: NaN })).toBeNull();
  });
});
