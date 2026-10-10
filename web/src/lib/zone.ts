// Time zones. The calendar is always drawn in this computer's current zone; these helpers
// name zones, compare them, and convert all-day dates so they don't shift when you travel.
import { TZDate } from '@date-fns/tz';

const DAY = 86_400_000;

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "America/Toronto" → "Toronto", "America/Argentina/Buenos_Aires" → "Buenos Aires" */
export const zoneCity = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ');

/** Short name at instant t: "EDT", "CET", or "GMT+5:30" when there is no common abbreviation. */
export function zoneAbbr(tz: string, t = Date.now()) {
  const part = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(t).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const us = part('en-US');
  if (!us.startsWith('GMT')) return us;
  const gb = part('en-GB'); // Europe: "CET", "BST"
  return gb.startsWith('GMT') || gb.startsWith('UTC') ? us.replace('GMT', 'UTC') : gb;
}

/** Offset from UTC in minutes at instant t (e.g. Toronto in summer → -240). */
export function zoneOffset(tz: string, t = Date.now()) {
  const z = new TZDate(t, tz);
  return Math.round((Date.UTC(z.getFullYear(), z.getMonth(), z.getDate(), z.getHours(), z.getMinutes()) - Math.floor(t / 60_000) * 60_000) / 60_000);
}

/** "UTC−4", "UTC+5:30" */
export function fmtOffset(minutes: number) {
  const sign = minutes < 0 ? '−' : '+';
  const a = Math.abs(minutes);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

/** Wall-clock parts of instant t in zone tz (this computer's zone if tz is missing). */
export function wallClock(t: number, tz?: string) {
  const d = tz && tz !== localZone() ? new TZDate(t, tz) : new Date(t);
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), min: d.getMinutes(), wd: d.getDay() };
}

/** The instant of a wall-clock time in zone tz. */
export function instantOf(y: number, m: number, d: number, minutes: number, tz?: string) {
  if (tz && tz !== localZone()) return new TZDate(y, m, d, Math.floor(minutes / 60), minutes % 60, tz).getTime();
  const x = new Date(y, m, d);
  x.setHours(0, minutes, 0, 0);
  return x.getTime();
}

// ---- all-day events are dates, not instants ---------------------------------------------
// Stored as UTC midnight of the date ("floating"), shown as local midnight of the same date,
// so "Oct 20 all-day" stays Oct 20 in Toronto, Paris or Tokyo.

/** Local midnight → stored date. */
export function encodeDay(localMidnight: number) {
  const d = new Date(localMidnight);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Stored date → local midnight. Also accepts old values saved as a local midnight (±12 h). */
export function decodeDay(t: number) {
  const d = new Date(t + DAY / 2);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

export const epochDay = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m, d) / DAY);
export const fromEpochDay = (e: number) => {
  const d = new Date(e * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
};
