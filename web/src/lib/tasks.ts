// Tasks: small actions you tick off. Kept deliberately simple — a title, an optional due date,
// done or not, and optionally a parent deadline (a checklist step). No priorities, tags or projects.
import { addDays, differenceInCalendarDays, startOfDay, startOfWeek } from 'date-fns';
import type { CalEvent } from '../data/types';
import type { Parsed } from './quickparse';
import { decodeDay } from './zone';
import { weekStart } from './dates';

export interface Task {
  id: string;
  title: string;
  due?: number; // a date, stored like all-day events (UTC midnight) so it never shifts when you travel
  done?: boolean;
  doneAt?: number;
  createdAt: number;
  parentId?: string; // a deadline this is a step of
}

/** Due date as local midnight (or undefined). */
export const dueOf = (t: Task) => (t.due === undefined ? undefined : decodeDay(t.due));

export interface Buckets {
  today: Task[]; // overdue first, then due today
  upcoming: Task[]; // dated, after today
  anytime: Task[]; // no date
  doneToday: Task[];
}

/**
 * The three lists the sidebar shows. Checklist steps without a date stay inside their deadline.
 * `scheduled`: task id → start of a block of time made for it; a task blocked for today is in Today.
 */
export function bucketTasks(tasks: Task[], now = Date.now(), scheduled: Map<string, number> = new Map()): Buckets {
  const today0 = startOfDay(now).getTime();
  const tomorrow0 = addDays(today0, 1).getTime();
  const open = tasks.filter((t) => !t.done);
  const blockedToday = (t: Task) => {
    const s = scheduled.get(t.id);
    return s !== undefined && s >= today0 && s < tomorrow0;
  };
  const isToday = (t: Task) => (t.due !== undefined && dueOf(t)! <= today0) || blockedToday(t);
  const byDue = (a: Task, b: Task) => (dueOf(a) ?? today0) - (dueOf(b) ?? today0) || a.createdAt - b.createdAt;
  return {
    today: open.filter(isToday).sort(byDue),
    upcoming: open.filter((t) => !isToday(t) && t.due !== undefined && dueOf(t)! > today0).sort(byDue),
    anytime: open.filter((t) => !isToday(t) && t.due === undefined && !t.parentId).sort((a, b) => a.createdAt - b.createdAt),
    doneToday: tasks.filter((t) => t.done && t.doneAt !== undefined && t.doneAt >= today0).sort((a, b) => b.doneAt! - a.doneAt!),
  };
}

/** Tasks finished today, this week, and per day of this week (from the week's first day — Settings → General). */
export function doneStats(tasks: Task[], now = Date.now()) {
  const today0 = startOfDay(now).getTime();
  const monday = startOfWeek(now, { weekStartsOn: weekStart() }).getTime(); // the week's first day
  const perDay = [0, 0, 0, 0, 0, 0, 0];
  let today = 0;
  let week = 0;
  for (const t of tasks) {
    if (!t.done || t.doneAt === undefined || t.doneAt < monday) continue;
    const k = differenceInCalendarDays(t.doneAt, monday);
    if (k > 6) continue;
    perDay[k]++;
    week++;
    if (t.doneAt >= today0) today++;
  }
  return { today, week, perDay, todayIndex: differenceInCalendarDays(today0, monday) };
}

/** Days overdue (0 = due today or later). */
export const overdueDays = (t: Task, now = Date.now()) => (t.due === undefined ? 0 : Math.max(0, differenceInCalendarDays(now, dueOf(t)!)));

/** A task as a calendar item (for drawing on its date and for commands). */
export function taskAsEvent(t: Task, now = Date.now()): CalEvent {
  const d = dueOf(t) ?? startOfDay(now).getTime();
  return {
    id: t.id,
    calendarId: '',
    title: t.title,
    start: d,
    end: addDays(d, 1).getTime(),
    allDay: true,
    kind: 'task',
    done: t.done,
  };
}

/** Open tasks as command targets. Overdue and undated ones count as "today" so you can still act on them. */
export function tasksForCommands(tasks: Task[], now = Date.now()): CalEvent[] {
  const today0 = startOfDay(now).getTime();
  return tasks
    .filter((t) => !t.done)
    .map((t) => {
      const e = taskAsEvent(t, now);
      return e.start < today0 ? { ...e, start: today0, end: addDays(today0, 1).getTime() } : e;
    });
}

// ---- what a typed sentence is: event, task or deadline ------------------------------------
export type ItemKind = 'event' | 'task' | 'deadline';

const TASK_PREFIX = /^\s*(?:(?:todo|to-do|task)\s*:?\s+|\[\s?\]\s*|-\s+)/i;
export const hasTaskPrefix = (s: string) => TASK_PREFIX.test(s);
export const stripTaskPrefix = (s: string) => s.replace(TASK_PREFIX, '');

// Sentences that start with an action are to-dos even when they have a date ("pay rent friday").
const ACTION =
  /^(?:e-?mail|call|phone|text|message|reply|respond|ask|tell|remind|buy|get|grab|order|pick up|drop off|return|send|mail|post|ship|pay|book|renew|cancel|submit|apply|register|sign|file|finish|write|draft|edit|read|review|revise|proofread|fix|debug|update|upgrade|install|backup|back up|clean|tidy|wash|water|feed|print|scan|upload|download|prepare|prep|plan|organi[sz]e|check|look into|follow up|research|make|bring|take|move|pack|charge|refill|test|run|merge|push|commit)\b/i;

export function guessKind(input: string, p: Parsed): ItemKind {
  if (hasTaskPrefix(input)) return 'task';
  if (p.deadline) return 'deadline';
  if (p.recurrence) return 'event';
  if (!p.hasDate && !p.timeFromWords) return 'task'; // nothing said about when: a to-do, not an event at the next hour
  if (p.hasDay && !p.hasTime && !p.timeFromWords && ACTION.test(p.title)) return 'task';
  return 'event';
}

/** The task a parsed sentence describes (title keeps any place: "pick up package at Shoppers"). */
export function taskFromParsed(p: Parsed): Pick<Task, 'title' | 'due'> {
  const title = (p.location ? `${p.title} at ${p.location}` : p.title) || 'New task';
  return { title, due: p.hasDay ? startOfDay(p.start).getTime() : undefined };
}
