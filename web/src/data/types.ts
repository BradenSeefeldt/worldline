export type ViewMode = 'day' | '3day' | 'week' | 'month';

export interface CalendarSource {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  account: string; // e.g. "Local", "Subscribed"
  /** A subscribed calendar (a department's, a team's, a Google "iCal address"): its .ics link. Read-only here;
   *  refreshed from the link. */
  url?: string;
  lastSync?: number; // last successful refresh
  syncError?: string; // why the last refresh failed
  autoName?: boolean; // named from the feed (until you rename it)
}

/**
 * Times are epoch milliseconds. All-day events run from local midnight to the
 * following midnight(s); `end` is exclusive (a one-day event ends at the next midnight).
 */
export interface CalEvent {
  id: string;
  calendarId: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  notes?: string;
  url?: string;
  createdAt?: number; // when it was added in this app
  // Recurring events (same model as Google Calendar / iCalendar RRULE):
  recurrence?: Recurrence; // set on the series' "master" event
  exdates?: number[]; // master only: occurrence starts that were skipped or replaced
  seriesId?: string; // on generated occurrences and on one-off exceptions: the master's id
  originalStart?: number; // on an exception: the occurrence it replaces
  timeZone?: string; // timed series: the zone whose clock it repeats on ("America/Toronto")
  // Deadlines: a moment something is due (start = end = due), with a runway of work before it.
  kind?: 'deadline' | 'task'; // 'task' only on items drawn from the task list
  leadDays?: number; // runway length (default 14)
  done?: boolean;
  linkedTo?: string; // a block of time made for a task or deadline (dragged from the sidebar)
  bookedVia?: string; // made by someone booking through one of your scheduling links
}

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface Recurrence {
  freq: Freq;
  interval: number; // every N days/weeks/months/years
  byDay?: number[]; // weekly: weekdays (0 = Sunday … 6 = Saturday)
  until?: number; // last possible start (inclusive)
}

export interface Range {
  start: number;
  end: number; // exclusive
}
