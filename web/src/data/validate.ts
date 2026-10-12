// Records that come from outside this app's own actions — a saved file at load, a backup, another device through
// sync — are checked here before the app uses them. Anything the views rely on is repaired (a missing list becomes
// empty, a broken repeat rule is dropped); a record that can't be repaired is left out. A malformed record must never
// make the app crash on every launch.
import type { CalEvent, Recurrence } from './types';
import type { Booking, BookingLink, PollResponse } from '../lib/booking';

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === 'string';
const nums = (x: unknown) => (Array.isArray(x) ? x.filter(num) : []);
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

/** A repeat rule as the app reads it, or undefined (it's dropped: the event shows once). */
export function cleanRecurrence(r: unknown): Recurrence | undefined {
  if (!isObj(r) || !FREQS.includes(r.freq as string)) return undefined;
  const interval = num(r.interval) && r.interval >= 1 ? Math.min(Math.round(r.interval), 1000) : 1;
  const byDay = Array.isArray(r.byDay) ? [...new Set(r.byDay.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : undefined;
  return { ...(r as unknown as Recurrence), interval, ...(byDay ? { byDay } : {}), ...(r.until !== undefined && !num(r.until) ? { until: undefined } : {}) };
}

/** An event the views can show, or null. */
export function cleanEvent(e: unknown): CalEvent | null {
  if (!isObj(e) || !str(e.id) || !str(e.calendarId) || !num(e.start) || !num(e.end)) return null;
  if (e.recurrence === undefined && e.exdates === undefined && (e.title === undefined || str(e.title))) return e as unknown as CalEvent; // (the usual case: nothing to repair)
  const out = { ...e } as Record<string, unknown>;
  if (out.title !== undefined && !str(out.title)) out.title = String(out.title);
  if (out.recurrence !== undefined) out.recurrence = cleanRecurrence(out.recurrence);
  if (out.exdates !== undefined) out.exdates = nums(out.exdates);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as CalEvent;
}

const cleanBooking = (b: unknown): Booking | null =>
  isObj(b) && str(b.id) && num(b.start) && num(b.end) ? ({ ...b, name: str(b.name) ? b.name : '', createdAt: num(b.createdAt) ? b.createdAt : 0 } as unknown as Booking) : null;
const cleanResponse = (r: unknown): PollResponse | null =>
  isObj(r) && str(r.id) ? { id: r.id, name: str(r.name) ? r.name : '', cells: nums(r.cells), updatedAt: num(r.updatedAt) ? r.updatedAt : 0 } : null;

/** A scheduling link the app can show and answer for, or null. */
export function cleanLink(l: unknown): BookingLink | null {
  if (!isObj(l) || !str(l.id)) return null;
  const n = (k: string, d: number, ok = (x: number) => x >= 0) => (num(l[k]) && ok(l[k] as number) ? (l[k] as number) : d);
  const nostr = isObj(l.nostr) && str(l.nostr.sk) && str(l.nostr.secret) && /^[0-9a-f]{64}$/.test(l.nostr.sk) ? l.nostr : undefined;
  const decisions = isObj(l.decisions) ? Object.fromEntries(Object.entries(l.decisions).filter(([, d]) => isObj(d) && str(d.id) && str(d.status) && num(d.start))) : undefined;
  return {
    ...(l as unknown as BookingLink),
    mode: l.mode === 'poll' ? 'poll' : 'book',
    title: str(l.title) ? l.title : '',
    hostName: str(l.hostName) ? l.hostName : '',
    durationMin: n('durationMin', 30, (x) => x >= 5 && x <= 24 * 60),
    ...(l.days !== undefined ? { days: nums(l.days).filter(Number.isInteger) } : {}),
    firstDay: n('firstDay', 0, () => true),
    lastDay: n('lastDay', 0, () => true),
    weekdays: nums(l.weekdays).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    windowStart: n('windowStart', 9 * 60, (x) => x >= 0 && x <= 1440),
    windowEnd: n('windowEnd', 17 * 60, (x) => x >= 0 && x <= 2 * 1440),
    timeZone: str(l.timeZone) && l.timeZone ? l.timeZone : 'UTC',
    blockingCalendars: Array.isArray(l.blockingCalendars) ? l.blockingCalendars.filter(str) : [],
    calendarId: str(l.calendarId) ? l.calendarId : '',
    bufferMin: n('bufferMin', 0),
    noticeMin: n('noticeMin', 0),
    createdAt: n('createdAt', 0),
    bookings: Array.isArray(l.bookings) ? (l.bookings.map(cleanBooking).filter(Boolean) as Booking[]) : [],
    responses: Array.isArray(l.responses) ? (l.responses.map(cleanResponse).filter(Boolean) as PollResponse[]) : [],
    nostr: nostr as BookingLink['nostr'],
    decisions: decisions as BookingLink['decisions'],
  };
}

/** Clean a list (keeping each record as it is when nothing needs repairing, so unchanged records stay the same). */
export const cleanList = <T,>(list: unknown, clean: (x: unknown) => T | null): T[] =>
  Array.isArray(list) ? (list.map(clean).filter((x) => x !== null) as T[]) : [];
