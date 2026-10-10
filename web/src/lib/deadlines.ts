// Deadlines: zero-width moments with a "runway" of work before them. The runway is what the
// calendar draws ahead of time, so a due date is visible in the weeks you should be working on it.
import { addDays, differenceInCalendarDays, format, isSameDay, startOfDay } from 'date-fns';
import type { CalEvent } from '../data/types';

export const DEFAULT_LEAD_DAYS = 14;
export const DEFAULT_DUE_MINUTES = 17 * 60; // 5 PM unless a time is given

export const isDeadline = (e: CalEvent) => e.kind === 'deadline';
export const leadDays = (e: CalEvent) => e.leadDays ?? DEFAULT_LEAD_DAYS;
/** First day of the runway (local midnight). */
export const runwayStart = (e: CalEvent) => startOfDay(addDays(e.start, -leadDays(e))).getTime();

/** Calendar days from today until it's due (0 = today, negative = overdue). */
export const daysLeft = (e: CalEvent, now = Date.now()) => differenceInCalendarDays(e.start, now);

/** Fraction of the runway still ahead: 1 (or more) before work should start, 0 at the due moment. */
export const runwayLeft = (e: CalEvent, now = Date.now()) => (e.start - now) / (leadDays(e) * 86_400_000);

// Colour says how much runway is left: green > 60%, yellow 25–60%, orange < 25%, red overdue.
export type Urgency = 'plenty' | 'halfway' | 'closing' | 'overdue';
export function urgency(e: CalEvent, now = Date.now()): Urgency {
  if (e.start < now) return 'overdue';
  const f = runwayLeft(e, now);
  return f < 0.25 ? 'closing' : f < 0.6 ? 'halfway' : 'plenty';
}

/** Mon–Fri days from tomorrow through the due date. */
export function workingDays(e: CalEvent, now = Date.now()) {
  let n = 0;
  for (let d = addDays(startOfDay(now), 1); d <= startOfDay(e.start); d = addDays(d, 1)) if (d.getDay() % 6 !== 0) n++;
  return n;
}

/** "Overdue · 2 days", "in 3 h", "Today 5 PM", "Tomorrow", "16 days" */
export function countdown(e: CalEvent, now = Date.now()) {
  const ms = e.start - now;
  if (ms < 0) {
    const late = -daysLeft(e, now);
    return late === 0 ? `Overdue · ${Math.max(1, Math.round(-ms / 3_600_000))} h` : `Overdue · ${late} day${late === 1 ? '' : 's'}`;
  }
  if (ms < 6 * 3_600_000) return ms < 3_600_000 ? `in ${Math.max(1, Math.round(ms / 60_000))} min` : `in ${Math.round(ms / 3_600_000)} h`;
  if (isSameDay(e.start, now)) return `Today ${format(e.start, 'h:mm a').replace(':00', '')}`;
  const d = daysLeft(e, now);
  return d === 1 ? 'Tomorrow' : `${d} days`;
}

/** 0 at the start of the runway → 1 at the due moment (for colour strength). */
export function strengthAt(e: CalEvent, t: number) {
  const a = runwayStart(e);
  return Math.min(1, Math.max(0, (t - a) / Math.max(1, e.start - a)));
}

export const URGENCY_COLOR: Record<Urgency, string> = {
  plenty: '#20b26b', // green
  halfway: '#e0ae00', // yellow
  closing: '#f2801d', // orange
  overdue: '#ef4b4b', // red
};
