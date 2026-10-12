// Reminders: which alerts are due when. Pure (no timers, no notifications) — data/alerts.ts delivers them.
//
// Each event can carry `alert`: minutes before it starts (0 = when it starts), or null for none. Left unset, the default
// applies (Settings → Alerts): one for timed events, one for all-day events (counted from the start of the day, so
// −540 = 9 AM on the day, 420 = 5 PM the day before), one for deadlines (before the due moment). Subscribed calendars
// and calendars on the Mac (the Calendar app has its own alerts) only alert when that calendar has alerts turned on (its ⋯ card) or the event has its own. Hidden calendars, done
// deadlines and tasks never alert.
import { format } from 'date-fns';
import type { CalEvent, CalendarSource } from '../data/types';
import { expand } from './recurrence';
import { fmtTime } from './format';

export interface AlertDefaults {
  alertMin: number | null; // timed events
  alertAllDayMin: number | null; // all-day events (from the start of the day)
  alertDeadlineMin: number | null; // deadlines
}

export interface Alert {
  key: string; // the same alert always has the same key (so it's delivered once)
  at: number; // when to show it
  title: string;
  body: string;
  eventId: string;
}

/** Choices for an event's alert (minutes before). */
export const TIMED_CHOICES: [number, string][] = [
  [0, 'When it starts'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'],
  [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before'],
];
export const ALL_DAY_CHOICES: [number, string][] = [[-540, 'On the day, at 9 AM'], [900, 'The day before, at 9 AM'], [420, 'The day before, at 5 PM'], [2340, '2 days before, at 9 AM']];

/** "10 minutes before", "On the day, at 9 AM", "None". */
export function describeAlert(min: number | null, allDay: boolean): string {
  if (min === null) return 'None';
  const hit = (allDay ? ALL_DAY_CHOICES : TIMED_CHOICES).find(([m]) => m === min);
  if (hit) return hit[1];
  if (allDay) return `${min} min before the day`;
  return min >= 60 && min % 60 === 0 ? `${min / 60} hours before` : `${min} minutes before`;
}

/** The alert an event gets (minutes before), or null for none. */
export function alertFor(ev: CalEvent, cal: CalendarSource | undefined, d: AlertDefaults): number | null {
  if (ev.alert === null) return null;
  if (typeof ev.alert === 'number') return ev.alert;
  if ((cal?.url || cal?.mac) && !cal.alerts) return null; // subscribed, or on the Mac (its Calendar app reminds you): off unless turned on
  if (cal && cal.alerts === false) return null;
  return ev.kind === 'deadline' ? d.alertDeadlineMin : ev.allDay ? d.alertAllDayMin : d.alertMin;
}

const MAX_LEAD = 3 * 1440 * 60_000; // the longest alert offered is 2 days before (at 9 AM): look this far past `to`

/** Alerts that fall in [from, to), soonest first. */
export function upcomingAlerts(events: CalEvent[], calendars: CalendarSource[], d: AlertDefaults, from: number, to: number): Alert[] {
  const cals = new Map(calendars.map((c) => [c.id, c]));
  const out: Alert[] = [];
  for (const ev of expand(events, from, to + MAX_LEAD)) {
    if (ev.kind === 'task' || (ev.kind === 'deadline' && ev.done)) continue;
    const cal = cals.get(ev.calendarId);
    if (ev.kind !== 'deadline' && cal && !cal.visible) continue;
    const min = alertFor(ev, cal, d);
    if (min === null) continue;
    // all-day: on the wall clock from the start of the day (9 AM is 9 AM on a daylight-saving day too)
    const at = ev.allDay && ev.kind !== 'deadline' ? new Date(ev.start).setMinutes(-min) : ev.start - min * 60_000;
    if (at < from || at >= to) continue;
    const when = ev.kind === 'deadline'
      ? `Due ${format(ev.start, 'EEE MMM d')} at ${fmtTime(ev.start)}`
      : ev.allDay
        ? format(ev.start, 'EEEE MMMM d') + (ev.end - ev.start > 86_400_000 + 3_600_000 ? ` – ${format(ev.end - 1, 'MMMM d')}` : '')
        : `${relative(min)}${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
    out.push({
      key: `${ev.id}|${ev.start}|${min}`,
      at,
      title: (ev.kind === 'deadline' ? '⚑ ' : '') + (ev.title || 'New Event'),
      body: [when, ev.location].filter(Boolean).join(' · '),
      eventId: ev.seriesId ?? ev.id,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

const relative = (min: number) => (min === 0 ? 'Now · ' : min < 60 ? `In ${min} min · ` : min < 1440 ? `In ${min / 60 === Math.round(min / 60) ? min / 60 : (min / 60).toFixed(1)} h · ` : 'Tomorrow · ');
