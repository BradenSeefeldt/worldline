// Every day the app can show gets an integer index counted from ORIGIN.
// Views work in these indices (like grid cells) and convert to real dates at the edges.
import { addDays, differenceInCalendarDays, startOfWeek } from 'date-fns';

export const WEEK_STARTS_ON: 0 | 1 = 1; // 0 = Sunday, 1 = Monday
export const MIN = 60_000;
export const ORIGIN = startOfWeek(new Date(2020, 0, 1), { weekStartsOn: WEEK_STARTS_ON });
export const TOTAL_DAYS = differenceInCalendarDays(new Date(2036, 0, 1), ORIGIN);
export const TOTAL_WEEKS = Math.ceil(TOTAL_DAYS / 7);

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
