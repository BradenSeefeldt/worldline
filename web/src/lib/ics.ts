// Reading calendar files (.ics / iCalendar) — what a "subscribe" link (webcal://…, Google's "iCal address", a
// department or team calendar) serves, and what an exported calendar file contains.
//
// Repeating events are expanded into the occurrences that fall in a window (a year back, two ahead), each one a plain,
// read-only event. A repeat rule runs on the wall clock of its own time zone (a weekly 3 PM Toronto meeting stays at
// 3 PM Toronto across daylight-saving changes): the rule is expanded in wall-clock time, then each occurrence is
// placed in its zone. Overridden occurrences (RECURRENCE-ID), skipped ones (EXDATE) and cancellations are honoured.
import { RRule } from 'rrule';
import type { CalEvent } from '../data/types';
import { instantOf, wallClock } from './zone';

const DAY = 86_400_000;

export interface IcsCalendar {
  name?: string; // X-WR-CALNAME
  color?: string; // X-APPLE-CALENDAR-COLOR (when present)
  events: CalEvent[]; // in local time (all-day ones at local midnights), read for the window
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Undo line folding (a line starting with a space or tab continues the previous one) and split into properties. */
function props(text: string): Prop[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && out.length) out[out.length - 1] += l.slice(1);
    else if (l.trim()) out.push(l);
  }
  return out.map((line) => {
    // NAME;PARAM=VALUE;PARAM="QUOTED:VALUE":the value — the first colon outside quotes ends the name and params
    let i = 0, q = false;
    for (; i < line.length; i++) {
      if (line[i] === '"') q = !q;
      else if (line[i] === ':' && !q) break;
    }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const params: Record<string, string> = {};
    for (const p of ps) {
      const k = p.indexOf('=');
      if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '');
    }
    return { name: name.toUpperCase(), params, value };
  });
}

const unescape = (v: string) => v.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1').trim();

// Outlook and Exchange name zones the Windows way; the commonest, mapped to IANA names.
const WINDOWS: Record<string, string> = {
  'Eastern Standard Time': 'America/Toronto', 'US Eastern Standard Time': 'America/Indiana/Indianapolis', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Edmonton', 'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Vancouver',
  'Atlantic Standard Time': 'America/Halifax', 'Newfoundland Standard Time': 'America/St_Johns', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev', 'Russian Standard Time': 'Europe/Moscow', 'Israel Standard Time': 'Asia/Jerusalem',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'Singapore Standard Time': 'Asia/Singapore', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane', 'Cen. Australia Standard Time': 'Australia/Adelaide', 'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland', 'SA Pacific Standard Time': 'America/Bogota', 'E. South America Standard Time': 'America/Sao_Paulo',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};
const valid = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** A TZID as an IANA zone ("America/Toronto"), or undefined for "this computer's zone". */
export function zoneOfTzid(tzid?: string): string | undefined {
  if (!tzid) return undefined;
  const t = tzid.replace(/^"|"$/g, '').trim();
  if (WINDOWS[t]) return WINDOWS[t];
  if (valid(t) && /\//.test(t)) return t;
  const tail = t.split('/').slice(-2).join('/'); // "/mozilla.org/20050126_1/America/New_York"
  if (valid(tail) && tail.includes('/')) return tail;
  return valid(t) ? t : undefined;
}

/** A DATE or DATE-TIME value: all-day, or a wall-clock time and the zone it's in ('UTC' for a trailing Z). */
interface When {
  allDay: boolean;
  y: number;
  m: number;
  d: number;
  minutes: number;
  tz?: string;
}
function when(p: Prop | undefined, fallbackTz?: string): When | undefined {
  if (!p) return undefined;
  const v = p.value.trim().split(',')[0];
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, , z] = m;
  if (h === undefined || p.params.VALUE === 'DATE') return { allDay: true, y: +y, m: +mo - 1, d: +d, minutes: 0 };
  return { allDay: false, y: +y, m: +mo - 1, d: +d, minutes: +h * 60 + +mi, tz: z ? 'UTC' : zoneOfTzid(p.params.TZID) ?? fallbackTz };
}
/** All the values of a multi-valued date property (EXDATE, RDATE). */
function whens(ps: Prop[], fallbackTz?: string): When[] {
  return ps.flatMap((p) => p.value.split(',').map((v) => when({ ...p, value: v }, fallbackTz)).filter((x): x is When => !!x));
}
const instant = (w: When) => (w.allDay ? new Date(w.y, w.m, w.d).getTime() : instantOf(w.y, w.m, w.d, w.minutes, w.tz));
/** A key for "this occurrence" that doesn't depend on the zone it's written in. */
const keyOf = (w: When) => (w.allDay ? `${w.y}-${w.m}-${w.d}` : String(instant(w)));

/** "P1DT2H30M" → milliseconds. */
function duration(v: string) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return undefined;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+(w ?? 0) * 7 + +(d ?? 0)) * 24 * 3600 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** A short stable hash (event ids from UIDs). */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Read an .ics file into events for `calendarId`, expanding repeats within [from, to). */
export function parseIcs(text: string, calendarId: string, from: number, to: number): IcsCalendar {
  const all = props(text);
  const cal: IcsCalendar = { events: [] };
  const defaultTz = zoneOfTzid(all.find((p) => p.name === 'X-WR-TIMEZONE')?.value);
  const name = all.find((p) => p.name === 'X-WR-CALNAME')?.value;
  if (name) cal.name = unescape(name);
  const color = all.find((p) => p.name === 'X-APPLE-CALENDAR-COLOR')?.value.trim();
  if (color && /^#[0-9a-f]{6}/i.test(color)) cal.color = color.slice(0, 7);

  // group into VEVENTs (skipping VTIMEZONE / VALARM blocks inside)
  const vevents: Prop[][] = [];
  let cur: Prop[] | null = null, depth = 0;
  for (const p of all) {
    if (p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VEVENT') { cur = []; depth = 0; continue; }
    if (!cur) continue;
    if (p.name === 'BEGIN') depth++;
    else if (p.name === 'END' && depth > 0) depth--;
    else if (p.name === 'END' && p.value.trim().toUpperCase() === 'VEVENT') { vevents.push(cur); cur = null; }
    else if (depth === 0) cur.push(p);
  }

  const get = (v: Prop[], n: string) => v.find((p) => p.name === n);
  // Overrides of single occurrences, by UID and the occurrence they replace.
  const overrides = new Map<string, Map<string, Prop[]>>();
  for (const v of vevents) {
    const rid = get(v, 'RECURRENCE-ID');
    if (!rid) continue;
    const uid = get(v, 'UID')?.value ?? '';
    const w = when(rid, defaultTz);
    if (!w) continue;
    if (!overrides.has(uid)) overrides.set(uid, new Map());
    overrides.get(uid)!.set(keyOf(w), v);
  }

  const make = (v: Prop[], start: When, idKey: string): CalEvent | null => {
    if ((get(v, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') return null;
    const s0 = when(get(v, 'DTSTART'), defaultTz);
    const e0 = when(get(v, 'DTEND'), defaultTz);
    const dur = get(v, 'DURATION');
    // length: from DTEND − DTSTART of the series (so moved occurrences keep it), else DURATION, else a day / zero
    let len = s0 && e0 ? instant(e0) - instant(s0) : dur ? duration(dur.value.trim()) ?? 0 : start.allDay ? DAY : 0;
    if (start.allDay) len = Math.max(DAY, Math.round(len / DAY) * DAY);
    const t = instant(start);
    const uid = get(v, 'UID')?.value ?? '';
    return {
      id: `${calendarId}~${hash(uid + (get(v, 'SUMMARY')?.value ?? ''))}~${idKey}`,
      calendarId,
      title: unescape(get(v, 'SUMMARY')?.value ?? '') || '(No title)',
      start: t,
      end: start.allDay ? new Date(start.y, start.m, start.d + Math.round(len / DAY)).getTime() : t + Math.max(0, len),
      allDay: start.allDay,
      ...(get(v, 'LOCATION') ? { location: unescape(get(v, 'LOCATION')!.value) } : {}),
      ...(get(v, 'DESCRIPTION') ? { notes: unescape(get(v, 'DESCRIPTION')!.value) } : {}),
      ...(get(v, 'URL') ? { url: get(v, 'URL')!.value.trim() } : {}),
    };
  };
  const inWindow = (e: CalEvent) => e.end > from && e.start < to;

  for (const v of vevents) {
    if (get(v, 'RECURRENCE-ID')) continue; // placed via its series below (or on its own if the series is missing)
    const start = when(get(v, 'DTSTART'), defaultTz);
    if (!start) continue;
    const uid = get(v, 'UID')?.value ?? '';
    const rule = get(v, 'RRULE')?.value;
    const mine = overrides.get(uid);
    if (!rule) {
      const e = make(v, start, keyOf(start));
      if (e && inWindow(e)) cal.events.push(e);
      continue;
    }
    // Expand in wall-clock time (a "floating" clock: UTC fields = the wall clock in the event's zone).
    const floating = (w: When) => Date.UTC(w.y, w.m, w.d, Math.floor(w.minutes / 60), w.minutes % 60);
    const zone = start.allDay ? undefined : start.tz;
    const toWall = (t: number): When => {
      const c = wallClock(t, zone === 'UTC' ? 'UTC' : zone);
      return { allDay: start.allDay, y: c.y, m: c.m, d: c.d, minutes: c.h * 60 + c.min, tz: start.tz };
    };
    let opts;
    try {
      opts = RRule.parseString(rule.replace(/^RRULE:/i, ''));
    } catch {
      continue;
    }
    if (opts.until) {
      // UNTIL is an instant (…Z) or a date; bring it onto the same floating clock (inclusive)
      const u = opts.until.getTime();
      const untilIsUtc = /UNTIL=\d{8}T\d{6}Z/i.test(rule);
      opts.until = new Date(untilIsUtc && !start.allDay ? floating(toWall(u)) : u + (start.allDay ? DAY - 1 : 0));
    }
    const rr = new RRule({ ...opts, dtstart: new Date(floating(start)) });
    const skip = new Set(whens(v.filter((p) => p.name === 'EXDATE'), defaultTz).map(keyOf));
    const extra = whens(v.filter((p) => p.name === 'RDATE'), defaultTz);
    const a = floating(toWall(from)) - 2 * DAY, b = floating(toWall(to)) + 2 * DAY;
    const occ: When[] = rr.between(new Date(a), new Date(b), true).map((d) => ({
      allDay: start.allDay, y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), tz: start.tz,
    }));
    for (const w of [...occ, ...extra]) {
      const k = keyOf(w);
      if (skip.has(k)) continue;
      const over = mine?.get(k);
      const e = over ? make(over, when(get(over, 'DTSTART'), defaultTz) ?? w, k) : make(v, w, k);
      if (e && inWindow(e)) cal.events.push(e);
    }
  }
  // overrides whose series wasn't in the file: show them on their own
  const seriesUids = new Set(vevents.filter((v) => get(v, 'RRULE')).map((v) => get(v, 'UID')?.value ?? ''));
  for (const [uid, m] of overrides) {
    if (seriesUids.has(uid)) continue;
    for (const [k, v] of m) {
      const s = when(get(v, 'DTSTART'), defaultTz);
      const e = s && make(v, s, k);
      if (e && inWindow(e)) cal.events.push(e);
    }
  }
  return cal;
}

/** webcal:// is just https:// for calendars. */
export const normalizeFeedUrl = (url: string) => url.trim().replace(/^webcals?:\/\//i, 'https://');
