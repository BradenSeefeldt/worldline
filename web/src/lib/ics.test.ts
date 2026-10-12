import { describe, expect, it } from 'vitest';
import { normalizeFeedUrl, parseIcs, zoneOfTzid } from './ics';
import { instantOf } from './zone';

const FROM = Date.UTC(2026, 0, 1), TO = Date.UTC(2027, 0, 1);
const cal = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Physics Dept', ...lines, 'END:VCALENDAR'].join('\r\n');
const toronto = (y: number, m: number, d: number, h: number, mi = 0) => instantOf(y, m, d, h * 60 + mi, 'America/Toronto');

describe('reading .ics calendars', () => {
  it('a single timed event in a named zone, with escaped text and a folded line', () => {
    const c = parseIcs(cal(
      'BEGIN:VEVENT', 'UID:a1', 'DTSTART;TZID=America/Toronto:20261014T150000', 'DTEND;TZID=America/Toronto:20261014T163000',
      'SUMMARY:Colloquium: the galactic centre flares\\, revisited', 'LOCATION:MP 102', 'DESCRIPTION:Speaker: Alex\\nCoffee befo', ' re.', 'END:VEVENT',
    ), 'dept', FROM, TO);
    expect(c.name).toBe('Physics Dept');
    expect(c.events).toHaveLength(1);
    expect(c.events[0]).toMatchObject({ calendarId: 'dept', title: 'Colloquium: the galactic centre flares, revisited', location: 'MP 102', notes: 'Speaker: Alex\nCoffee before.', allDay: false });
    expect(c.events[0].start).toBe(toronto(2026, 9, 14, 15));
    expect(c.events[0].end).toBe(toronto(2026, 9, 14, 16, 30));
  });
  it('UTC times, all-day events (and multi-day ones), DURATION instead of DTEND', () => {
    const c = parseIcs(cal(
      'BEGIN:VEVENT', 'UID:u', 'DTSTART:20261014T190000Z', 'DURATION:PT45M', 'SUMMARY:Telecon', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261023', 'SUMMARY:Conference', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:d1', 'DTSTART;VALUE=DATE:20261101', 'SUMMARY:Holiday', 'END:VEVENT',
    ), 'c', FROM, TO);
    const [t, conf, hol] = c.events;
    expect(t.start).toBe(Date.UTC(2026, 9, 14, 19));
    expect(t.end - t.start).toBe(45 * 60_000);
    expect(conf).toMatchObject({ allDay: true, start: new Date(2026, 9, 20).getTime(), end: new Date(2026, 9, 23).getTime() });
    expect(hol).toMatchObject({ allDay: true, start: new Date(2026, 10, 1).getTime(), end: new Date(2026, 10, 2).getTime() });
  });
  it('a weekly series: stays at 7 PM Toronto across the DST change; a skipped week, a moved week and a cancelled week', () => {
    const c = parseIcs(cal(
      'BEGIN:VEVENT', 'UID:vb', 'DTSTART;TZID=America/Toronto:20261021T190000', 'DTEND;TZID=America/Toronto:20261021T210000',
      'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6', 'EXDATE;TZID=America/Toronto:20261028T190000', 'SUMMARY:Volleyball', 'END:VEVENT',
      // week 3 moved to Thursday 8 PM
      'BEGIN:VEVENT', 'UID:vb', 'RECURRENCE-ID;TZID=America/Toronto:20261104T190000', 'DTSTART;TZID=America/Toronto:20261105T200000',
      'DTEND;TZID=America/Toronto:20261105T220000', 'SUMMARY:Volleyball (moved)', 'END:VEVENT',
      // week 4 cancelled
      'BEGIN:VEVENT', 'UID:vb', 'RECURRENCE-ID;TZID=America/Toronto:20261111T190000', 'DTSTART;TZID=America/Toronto:20261111T190000', 'STATUS:CANCELLED', 'SUMMARY:Volleyball', 'END:VEVENT',
    ), 'vb', FROM, TO);
    expect(c.events.map((e) => [e.title, e.start])).toEqual([
      ['Volleyball', toronto(2026, 9, 21, 19)],
      ['Volleyball (moved)', toronto(2026, 10, 5, 20)],
      ['Volleyball', toronto(2026, 10, 18, 19)], // after Nov 1 (EST): still 7 PM on the wall
      ['Volleyball', toronto(2026, 10, 25, 19)],
    ]);
    expect(new Set(c.events.map((e) => e.id)).size).toBe(4);
  });
  it('UNTIL ends a series; only the window is expanded', () => {
    const c = parseIcs(cal(
      'BEGIN:VEVENT', 'UID:s', 'DTSTART;TZID=America/Toronto:20260105T100000', 'DTEND;TZID=America/Toronto:20260105T110000',
      'RRULE:FREQ=WEEKLY;UNTIL=20260126T150000Z', 'SUMMARY:Seminar', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:f', 'DTSTART;VALUE=DATE:20200101', 'RRULE:FREQ=YEARLY', 'SUMMARY:New Year', 'END:VEVENT',
    ), 's', new Date(2026, 0, 1).getTime(), new Date(2027, 0, 1).getTime()); // (the year on this machine's clock, where all-day days are)
    expect(c.events.filter((e) => e.title === 'Seminar')).toHaveLength(4); // Jan 5, 12, 19, 26
    expect(c.events.filter((e) => e.title === 'New Year').map((e) => new Date(e.start).getFullYear())).toEqual([2026]);
  });
  it('a date-only UNTIL on a timed series includes that day (L9)', () => {
    const c = parseIcs(cal(
      'BEGIN:VEVENT', 'UID:s', 'DTSTART;TZID=America/Toronto:20260105T100000', 'DTEND;TZID=America/Toronto:20260105T110000',
      'RRULE:FREQ=WEEKLY;UNTIL=20260126', 'SUMMARY:Seminar', 'END:VEVENT',
    ), 's', FROM, TO);
    expect(c.events.map((e) => e.start)).toEqual([5, 12, 19, 26].map((d) => toronto(2026, 0, d, 10)));
  });
  it('an occurrence moved into the window from outside the stretch read is kept (L9)', () => {
    const c = parseIcs(cal(
      'BEGIN:VEVENT', 'UID:w', 'DTSTART;TZID=America/Toronto:20250106T100000', 'DTEND;TZID=America/Toronto:20250106T110000',
      'RRULE:FREQ=WEEKLY;UNTIL=20251222T150000Z', 'SUMMARY:Weekly', 'END:VEVENT',
      // the Dec 22 2025 meeting, moved to Jan 7 2026 (the series itself ended before the window)
      'BEGIN:VEVENT', 'UID:w', 'RECURRENCE-ID;TZID=America/Toronto:20251222T100000', 'DTSTART;TZID=America/Toronto:20260107T160000',
      'DTEND;TZID=America/Toronto:20260107T170000', 'SUMMARY:Weekly (moved)', 'END:VEVENT',
    ), 'w', FROM, TO);
    expect(c.events.map((e) => [e.title, e.start])).toEqual([['Weekly (moved)', toronto(2026, 0, 7, 16)]]);
  });
  it('a zone known only by its VTIMEZONE (an unknown name) is read from that description (L9)', () => {
    const c = parseIcs(cal(
      'BEGIN:VTIMEZONE', 'TZID:Customized Time Zone',
      'BEGIN:STANDARD', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3', 'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VTIMEZONE', 'TZID:India time (custom)',
      'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID="Customized Time Zone":20260302T150000', 'DTEND;TZID="Customized Time Zone":20260302T160000',
      'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Call', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'DTSTART;TZID=India time (custom):20260302T090000', 'DTEND;TZID=India time (custom):20260302T100000', 'SUMMARY:Standup', 'END:VEVENT',
    ), 'v', FROM, TO);
    const by = (t: string) => c.events.filter((e) => e.title === t).map((e) => e.start);
    expect(by('Call')).toEqual([toronto(2026, 2, 2, 15), toronto(2026, 2, 9, 15)]); // EST, then EDT
    expect(by('Standup')).toEqual([Date.UTC(2026, 2, 2, 3, 30)]);
  });
  it("Outlook's Windows zone names and Mozilla-style TZIDs are understood; webcal links become https", () => {
    expect(zoneOfTzid('Eastern Standard Time')).toBe('America/Toronto');
    expect(zoneOfTzid('/mozilla.org/20050126_1/America/New_York')).toBe('America/New_York');
    expect(zoneOfTzid('"Europe/Paris"')).toBe('Europe/Paris');
    expect(zoneOfTzid('Not/A_Zone')).toBeUndefined();
    expect(normalizeFeedUrl(' webcal://calendar.google.com/x/basic.ics')).toBe('https://calendar.google.com/x/basic.ics');
  });
});
