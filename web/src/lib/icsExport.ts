// Writing a calendar as an .ics file (Settings → Data & Backups → Export), for Apple Calendar, Google, Outlook.
// Repeating events stay one series (RRULE, with skipped days as EXDATE and moved ones as their own RECURRENCE-ID
// event), on the wall clock of their zone, so a weekly 3 PM Toronto meeting is still 3 PM Toronto wherever it's opened.
import type { CalEvent } from '../data/types';
import { decodeEvent } from './recurrence';
import { decodeDay, encodeDay, wallClock } from './zone';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const utc = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const date = (t: number) => { const d = new Date(t); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; };
const local = (t: number, tz: string) => { const w = wallClock(t, tz); return `${w.y}${pad(w.m + 1)}${pad(w.d)}T${pad(w.h)}${pad(w.min)}00`; };
// (any line break, \r included, becomes \n: a raw one would end the line and start a property of its own)
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/([,;])/g, '\\$1');
/** A link as one line (control characters and spaces dropped). */
const oneLine = (s: string) => s.replace(/[\u0000-\u0020\u007f]/g, '');
/** Lines over 75 characters continue on the next line, indented (RFC 5545). */
const fold = (line: string) => line.length <= 75 ? line : line.match(/.{1,74}/g)!.map((p, i) => (i ? ' ' + p : p)).join('\r\n');

// Start and end come decoded (all-day ones at local midnights); the occurrence keys in EXDATE and RECURRENCE-ID are
// stored dates (UTC midnights), so they're decoded here, or west of UTC they'd be written a day early.
function stamp(e: CalEvent, prop: 'DTSTART' | 'DTEND' | 'RECURRENCE-ID' | 'EXDATE', t: number, tz?: string) {
  if (e.allDay) return `${prop};VALUE=DATE:${date(prop === 'DTSTART' || prop === 'DTEND' ? t : decodeDay(t))}`;
  if (tz) return `${prop};TZID=${tz}:${local(t, tz)}`;
  return `${prop}:${utc(t)}`;
}

/** `events`: as stored (all-day ones as dates). Tasks, deadlines and generated occurrences are left out. */
export function toIcs(name: string, events: CalEvent[], color?: string): string {
  const list = events.map(decodeEvent).filter((e) => !e.kind && !(e.seriesId && e.originalStart === undefined));
  const byId = new Map(list.map((e) => [e.id, e]));
  const movedOf = new Map<string, CalEvent[]>(); // series → its moved occurrences
  for (const x of list) if (x.seriesId && x.originalStart !== undefined) movedOf.set(x.seriesId, [...(movedOf.get(x.seriesId) ?? []), x]);
  const zoneOf = (e: CalEvent) => (e.recurrence || e.seriesId) && !e.allDay ? e.timeZone ?? (e.seriesId ? byId.get(e.seriesId)?.timeZone : undefined) : undefined;
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Worldline//Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(name)}`, ...(color ? [`X-APPLE-CALENDAR-COLOR:${color}`] : [])];
  for (const e of list) {
    const tz = zoneOf(e);
    const uid = `${e.seriesId ?? e.id}@worldline`;
    out.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utc(e.createdAt ?? Date.now())}`, stamp(e, 'DTSTART', e.start, tz), stamp(e, 'DTEND', e.end, tz), `SUMMARY:${esc(e.title || 'Untitled')}`);
    if (e.location) out.push(`LOCATION:${esc(e.location)}`);
    if (e.notes) out.push(`DESCRIPTION:${esc(e.notes)}`);
    if (e.url && oneLine(e.url)) out.push(`URL:${oneLine(e.url)}`);
    if (e.recurrence) {
      const r = e.recurrence;
      // (an all-day series ends on a date: UNTIL=YYYYMMDD, as RFC 5545 requires with a DATE start)
      const until = r.until === undefined ? [] : [`UNTIL=${e.allDay ? date(r.until) : utc(r.until)}`];
      const parts = [`FREQ=${r.freq.toUpperCase()}`, ...(r.interval > 1 ? [`INTERVAL=${r.interval}`] : []), ...(r.byDay?.length ? [`BYDAY=${r.byDay.map((d) => DAY_CODES[d]).join(',')}`] : []), ...until];
      out.push(`RRULE:${parts.join(';')}`);
      // A moved occurrence is its own RECURRENCE-ID event below; listing it as skipped too would hide it on reading back.
      const key = (x: number) => (e.allDay ? encodeDay(decodeDay(x)) : x);
      const moved = new Set((movedOf.get(e.id) ?? []).map((x) => key(x.originalStart!)));
      for (const x of e.exdates ?? []) if (!moved.has(key(x))) out.push(stamp(e, 'EXDATE', x, tz));
    }
    if (e.seriesId && e.originalStart !== undefined) {
      // the occurrence it replaces, written as its series writes its days (a date, or a time on the series' clock)
      const master = byId.get(e.seriesId);
      out.push(master ? stamp(master, 'RECURRENCE-ID', e.originalStart, zoneOf(master)) : stamp(e, 'RECURRENCE-ID', e.originalStart, tz));
    }
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}
