// Every day the app can show gets an integer index counted from ORIGIN.
// Views work in these indices (like grid cells) and convert to real dates at the edges.
import { addDays, differenceInCalendarDays, getWeek, startOfWeek } from 'date-fns';

// The first day of the week (0 = Sunday, 1 = Monday) — Settings → General. Day 0 (ORIGIN) is always a week's first
// day, so a month view row is days 7k … 7k+6. Changing it moves ORIGIN; the views redraw (App keys them on it).
let weekStartsOn: 0 | 1 = 1;
export const weekStart = () => weekStartsOn;
export const MIN = 60_000;
export let ORIGIN = startOfWeek(new Date(2020, 0, 1), { weekStartsOn });
export let TOTAL_DAYS = differenceInCalendarDays(new Date(2036, 0, 1), ORIGIN);
export let TOTAL_WEEKS = Math.ceil(TOTAL_DAYS / 7);
export function setWeekStart(ws: 0 | 1) {
  weekStartsOn = ws;
  ORIGIN = startOfWeek(new Date(2020, 0, 1), { weekStartsOn });
  TOTAL_DAYS = differenceInCalendarDays(new Date(2036, 0, 1), ORIGIN);
  TOTAL_WEEKS = Math.ceil(TOTAL_DAYS / 7);
}

export const dayIndex = (t: Date | number) => differenceInCalendarDays(t, ORIGIN);
export const dateAt = (i: number) => addDays(ORIGIN, i);
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

export const isWeekend = (i: number) => {
  const dow = dateAt(i).getDay();
  return dow === 0 || dow === 6;
};

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The week number of a date: ISO weeks (Monday start, week 1 holds Jan 4) or US weeks (Sunday start, week 1 holds Jan 1). */
export const weekNumber = (t: Date | number) => getWeek(t, { weekStartsOn, firstWeekContainsDate: weekStartsOn === 1 ? 4 : 1 });
