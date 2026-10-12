// Every day the app can show gets an integer index counted from day 0 (a week's first day at the start of 2020).
// Views work in these indices (like grid cells) and convert to real dates at the edges. Day 0 is a calendar date, not
// an instant: the indices count calendar days in whatever zone the Mac is in now, so they stay right after the zone
// changes (travelling) while the app is open.
import { getWeek } from 'date-fns';

// The first day of the week (0 = Sunday, 1 = Monday) — Settings → General. Day 0 is always a week's first day, so a
// month view row is days 7k … 7k+6. Changing it moves day 0; the views redraw (App keys them on it).
let weekStartsOn: 0 | 1 = 1;
export const weekStart = () => weekStartsOn;
export const MIN = 60_000;
const DAY = 86_400_000;
const LAST = Date.UTC(2041, 0, 1); // the views end here
const origin = () => {
  const jan1 = Date.UTC(2020, 0, 1);
  return jan1 - ((new Date(jan1).getUTCDay() - weekStartsOn + 7) % 7) * DAY; // (as a UTC date: no daylight saving)
};
let ORIGIN_UTC = origin();
let O = new Date(ORIGIN_UTC); // its year, month and day (UTC fields)
export let TOTAL_DAYS = (LAST - ORIGIN_UTC) / DAY;
export let TOTAL_WEEKS = Math.ceil(TOTAL_DAYS / 7);
export function setWeekStart(ws: 0 | 1) {
  weekStartsOn = ws;
  ORIGIN_UTC = origin();
  O = new Date(ORIGIN_UTC);
  TOTAL_DAYS = (LAST - ORIGIN_UTC) / DAY;
  TOTAL_WEEKS = Math.ceil(TOTAL_DAYS / 7);
}

/** The day (index) a moment falls on, in this device's zone now. */
export const dayIndex = (t: Date | number) => {
  const d = new Date(t);
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - ORIGIN_UTC) / DAY);
};
/** Local midnight starting day `i` (01:00 where a clock change skips midnight). */
export const dateAt = (i: number) => new Date(O.getUTCFullYear(), O.getUTCMonth(), O.getUTCDate() + i);
export const dayStart = (i: number) => dateAt(i).getTime();
export const todayIndex = () => dayIndex(Date.now());

/** Minutes since local midnight (DST-safe: reads the wall clock). */
export const minutesOfDay = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};

/** Timestamp of `minutes` past midnight on day `i` (minutes may exceed 1440). */
export const atMinutes = (i: number, minutes: number) => {
  const d = dateAt(i);
  d.setHours(0, minutes, 0, 0);
  return d.getTime();
};

/** t moved by `days` calendar days and `minutes` on the wall clock: 9:00 + 1 day is 9:00 the next day, even across a
 *  daylight-saving change (when a day is 23 or 25 hours long). */
export const shiftWall = (t: number, days: number, minutes = 0) => atMinutes(dayIndex(t) + days, minutesOfDay(t) + minutes);

/** The earliest an event can end: a day after it starts (all-day) or 15 minutes after (timed). */
export const earliestEnd = (start: number, allDay?: boolean) => (allDay ? shiftWall(start, 1) : start + 15 * MIN);

export const isWeekend = (i: number) => {
  const dow = dateAt(i).getDay();
  return dow === 0 || dow === 6;
};

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The week number of a date: ISO weeks (Monday start, week 1 holds Jan 4) or US weeks (Sunday start, week 1 holds Jan 1). */
export const weekNumber = (t: Date | number) => getWeek(t, { weekStartsOn, firstWeekContainsDate: weekStartsOn === 1 ? 4 : 1 });
