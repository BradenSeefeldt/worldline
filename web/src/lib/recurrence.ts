// Recurring events. A series is stored once (its "master" event carries the rule); the
// individual occurrences are generated for whatever date range is on screen.
//
// Time zones: a timed series repeats on the clock of the zone it was created in (`timeZone`),
// so a weekly 3 PM Toronto meeting stays at 3 PM Toronto while you're in Paris or Tokyo —
// even across the weeks when the two places change daylight-saving time on different dates.
// All-day events are dates (see zone.ts), so they never shift between days.
//
// Occurrence ids are "<masterId>@<key>", where key is the occurrence's start instant (timed) or
// its stored date (all-day). Editing one occurrence makes an *exception*: the master lists that
// key in `exdates` and a normal event with `seriesId`/`originalStart` takes its place.
import { format } from 'date-fns';
import type { CalEvent, Recurrence } from '../data/types';
import { decodeDay, encodeDay, epochDay, fromEpochDay, instantOf, wallClock } from './zone';

const DAY = 86_400_000;

export const isOccurrenceId = (id: string) => id.includes('@');
export const occurrenceId = (masterId: string, key: number) => `${masterId}@${key}`;
export function splitOccurrenceId(id: string) {
  const i = id.lastIndexOf('@');
  return { masterId: id.slice(0, i), start: +id.slice(i + 1) };
}

/** All-day events as stored → as shown (local midnights). Timed events are unchanged. */
export const decodeEvent = (e: CalEvent): CalEvent => (e.allDay ? { ...e, start: decodeDay(e.start), end: decodeDay(e.end) } : e);
/** As shown → as stored. Only ever call on decoded (local) values. */
export const encodeEvent = (e: CalEvent): CalEvent => (e.allDay ? { ...e, start: encodeDay(e.start), end: encodeDay(e.end) } : e);

const weekdayOf = (e: number) => (((e + 4) % 7) + 7) % 7; // epoch day 0 (1970-01-01) was a Thursday
const weekOf = (e: number) => Math.floor((e + 3) / 7); // Monday-based weeks

/** Everything needed to generate a series' occurrences. */
function basis(master: CalEvent) {
  if (master.allDay) {
    const s = decodeDay(master.start);
    const w = wallClock(s);
    return { tz: undefined, m0: epochDay(w.y, w.m, w.d), minutes: 0, first: w, days: Math.max(1, Math.round((decodeDay(master.end) - s) / DAY)), span: 0 };
  }
  const tz = master.timeZone;
  const w = wallClock(master.start, tz);
  return { tz, m0: epochDay(w.y, w.m, w.d), minutes: w.h * 60 + w.min, first: w, days: 0, span: master.end - master.start };
}

function occursOn(r: Recurrence, b: ReturnType<typeof basis>, e: number) {
  if (e < b.m0) return false;
  switch (r.freq) {
    case 'daily':
      return (e - b.m0) % r.interval === 0;
    case 'weekly': {
      const days = r.byDay?.length ? r.byDay : [weekdayOf(b.m0)];
      return days.includes(weekdayOf(e)) && (weekOf(e) - weekOf(b.m0)) % r.interval === 0;
    }
    case 'monthly': {
      const x = fromEpochDay(e);
      return x.d === b.first.d && ((x.y - b.first.y) * 12 + x.m - b.first.m) % r.interval === 0;
    }
    case 'yearly': {
      const x = fromEpochDay(e);
      return x.m === b.first.m && x.d === b.first.d && (x.y - b.first.y) % r.interval === 0;
    }
  }
}

function makeOccurrence(master: CalEvent, b: ReturnType<typeof basis>, e: number) {
  const { y, m, d } = fromEpochDay(e);
  const start = master.allDay ? new Date(y, m, d).getTime() : instantOf(y, m, d, b.minutes, b.tz);
  const end = master.allDay ? new Date(y, m, d + b.days).getTime() : start + b.span;
  const key = master.allDay ? Date.UTC(y, m, d) : start;
  const occ: CalEvent = { ...master, id: occurrenceId(master.id, key), start, end, seriesId: master.id, exdates: undefined };
  return { occ, key };
}

/** The occurrence keys a series skips, tolerant of keys saved by older versions. */
const skipSet = (master: CalEvent) => new Set((master.exdates ?? []).map((x) => (master.allDay ? encodeDay(decodeDay(x)) : x)));

/** Occurrences of one series that overlap [from, to). */
export function occurrences(master: CalEvent, from: number, to: number): CalEvent[] {
  const r = master.recurrence;
  if (!r) return [];
  const b = basis(master);
  const day = (t: number) => {
    const w = wallClock(t, b.tz);
    return epochDay(w.y, w.m, w.d);
  };
  const a = Math.max(b.m0, day(from - Math.max(b.span, b.days * DAY)) - 1);
  const z = day(to) + 1;
  const skip = skipSet(master);
  const out: CalEvent[] = [];
  for (let e = a; e <= z; e++) {
    if (!occursOn(r, b, e)) continue;
    const { occ, key } = makeOccurrence(master, b, e);
    if (r.until !== undefined && occ.start > r.until) break;
    if (skip.has(key) || occ.end <= from || occ.start >= to) continue;
    out.push(occ);
  }
  return out;
}

/** Everything to show in [from, to): one-off events plus generated occurrences, in local time. */
export function expand(events: CalEvent[], from: number, to: number): CalEvent[] {
  const out: CalEvent[] = [];
  for (const raw of events) {
    if (raw.recurrence) out.push(...occurrences(raw, from, to));
    else {
      const e = decodeEvent(raw);
      if (e.start < to && e.end > from) out.push(e);
    }
  }
  return out;
}

/** Look up any event id, including a generated occurrence (returned in local time). */
export function resolveEvent(events: CalEvent[], id: string | null): CalEvent | undefined {
  if (!id) return undefined;
  if (!isOccurrenceId(id)) {
    const e = events.find((x) => x.id === id);
    return e && decodeEvent(e);
  }
  const { masterId, start: key } = splitOccurrenceId(id);
  const master = events.find((e) => e.id === masterId);
  if (!master?.recurrence || skipSet(master).has(key)) return undefined;
  const b = basis(master);
  const w = master.allDay ? fromEpochDay(Math.round(key / DAY)) : wallClock(key, b.tz);
  const e = epochDay(w.y, w.m, w.d);
  return occursOn(master.recurrence, b, e) ? makeOccurrence(master, b, e).occ : undefined;
}

/** The weekday a series repeats on, in its own zone (for weekly rules). */
export const seriesWeekday = (master: CalEvent) => weekdayOf(basis(master).m0);

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const listDays = (days: number[]) => {
  const sorted = [...days].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)); // Monday first
  if (sorted.join() === '1,2,3,4,5') return 'weekdays';
  const names = sorted.map((d) => WEEKDAY[d]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
};

/** "Weekly on Friday", "Every 2 weeks on Tuesday and Thursday", "Monthly on the 1st · until Dec 15" */
export function describeRecurrence(r: Recurrence, start: number) {
  const n = r.interval;
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  const every = n === 1 ? { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[r.freq] : `Every ${n} ${unit}s`;
  let s = every;
  if (r.freq === 'weekly') {
    const days = r.byDay?.length ? r.byDay : [new Date(start).getDay()];
    const list = listDays(days);
    s = list === 'weekdays' && n === 1 ? 'Every weekday' : `${every} on ${list}`;
  }
  if (r.freq === 'monthly') s += ` on the ${format(start, 'do')}`;
  if (r.freq === 'yearly') s += ` on ${format(start, 'MMM d')}`;
  if (r.until !== undefined) s += ` · until ${format(r.until, 'MMM d')}`;
  return s;
}
