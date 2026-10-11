// Suggestions shown in the empty quick-add box, learned from your own calendar:
//   add   — a regular meeting (weekly / every other week) that's missing this week
//   move  — two upcoming events overlap; move one to the nearest free slot
//   late  — something starts soon; push it back 15 min
//   skip  — the next occurrence of a regular meeting
//   habit — a weekly habit falling behind (Gym 3×/week, 1 done by Thursday): book one at your usual time
// Each suggestion is an ordinary quick-add sentence. Before it is shown, the sentence is run
// through the real parser and kept only if it does exactly what the suggestion says.
import { addDays, differenceInCalendarDays, format, isSameDay, startOfDay, startOfWeek } from 'date-fns';
import type { CalEvent, CalendarSource } from '../data/types';
import { parseQuick } from './quickparse';
import { parseCommand, words } from './commands';
import { MIN, minutesOfDay } from './dates';
import { overdueDays, tasksForCommands, type Task } from './tasks';
import { calendarCredit, dayOf, periodProgress, weekStart, type Habit, type HabitLog } from './habits';
import { fmtTime } from './format';

const DAY = 86_400_000;
const HISTORY_DAYS = 70; // look back 10 weeks for patterns
const HORIZON_DAYS = 7; // look ahead one week

export type SuggestionKind = 'add' | 'move' | 'late' | 'skip' | 'focus' | 'stale' | 'habit';
export interface Suggestion {
  id: string; // stable, so a dismissal sticks
  kind: SuggestionKind;
  phrase: string; // what gets typed into the box
  reason: string; // why it's suggested
}

export interface Skip {
  key: string; // seriesKey of the deleted event
  at: number; // its start
}

const STOP = new Set(['the', 'a', 'an', 'with', 'w', 'and', 'of', 'for', 'to', 'on', 'at', 'in', 'meeting', 'meet', 'call', 'sync']);
/** Events with the same significant title words belong to the same series. */
export const seriesKey = (title: string) =>
  [...new Set(words(title).filter((w) => !STOP.has(w)))].sort().join(' ') || title.toLowerCase();

interface Series {
  key: string;
  title: string;
  calendarId: string;
  weekday: number;
  minutes: number; // usual start, minutes after midnight
  duration: number; // usual length, minutes
  period: 7 | 14;
  last: number; // most recent past occurrence
}

const mode = <T,>(xs: T[]) => {
  const counts = new Map<T, number>();
  xs.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Regular meetings that are still active. */
export function findSeries(events: CalEvent[], now: Date): Series[] {
  const nowMs = now.getTime();
  const groups = new Map<string, CalEvent[]>();
  for (const e of events) {
    if (e.allDay || e.start >= nowMs || e.start < nowMs - HISTORY_DAYS * DAY) continue;
    const k = `${seriesKey(e.title)}|${new Date(e.start).getDay()}`; // a series per weekday ("lunch talk" Tue + Thu)
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  const out: Series[] = [];
  for (const [k, list] of groups) {
    list.sort((a, b) => a.start - b.start);
    const days = [...new Set(list.map((e) => startOfDay(e.start).getTime()))];
    if (days.length < 2) continue;
    const gaps = days.slice(1).map((d, i) => Math.round((d - days[i]) / DAY));
    const g = median(gaps);
    const period = Math.abs(g - 7) <= 1 ? 7 : Math.abs(g - 14) <= 2 ? 14 : null;
    if (!period) continue;
    if (days.length < (period === 7 ? 3 : 2)) continue; // a pattern, not a coincidence
    const last = list[list.length - 1];
    if (nowMs - last.start > 2 * period * DAY + 2 * DAY) continue; // gone quiet: don't suggest
    out.push({
      key: k.split('|')[0],
      title: last.title,
      calendarId: last.calendarId,
      weekday: new Date(last.start).getDay(),
      minutes: mode(list.map((e) => minutesOfDay(e.start)))!,
      duration: mode(list.map((e) => Math.round((e.end - e.start) / MIN)))!,
      period,
      last: last.start,
    });
  }
  return out;
}

// ---- phrasing helpers ----------------------------------------------------------------
const timeWord = (t: number) => format(t, new Date(t).getMinutes() ? 'h:mmaaa' : 'haaa'); // "2pm", "2:30pm"
const lengthWord = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${m} min`);
function dayWord(t: number, now: Date) {
  if (isSameDay(t, now)) return 'today';
  if (isSameDay(t, addDays(now, 1))) return 'tomorrow';
  return format(t, 'EEEE').toLowerCase();
}
const plural = (d: number) => format(addDays(startOfWeek(new Date(2026, 0, 4)), d), 'EEEE') + 's';

// ---- the suggestions ------------------------------------------------------------------
export function suggest(
  allEvents: CalEvent[],
  calendars: CalendarSource[],
  opts: { skipped?: Skip[]; dismissed?: string[]; now?: Date; tasks?: Task[]; habits?: Habit[]; habitLog?: HabitLog } = {},
): Suggestion[] {
  let events = allEvents;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const horizon = nowMs + HORIZON_DAYS * DAY;
  const skipped = opts.skipped ?? [];
  const dismissed = new Set(opts.dismissed ?? []);
  const visible = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
  const deadlines = events.filter((e) => e.kind === 'deadline' && !e.done);
  events = events.filter((e) => e.kind !== 'deadline'); // patterns and clashes are about meetings
  const calName = (id: string) => calendars.find((c) => c.id === id)?.name;
  const upcoming = events.filter((e) => e.end > nowMs && e.start < horizon && visible.has(e.calendarId));
  const series = findSeries(events.filter((e) => visible.has(e.calendarId)), now);
  const out: Suggestion[] = [];

  // 1. Regular meetings missing from the coming week
  const weekdaysByKey = new Map<string, Set<number>>();
  series.forEach((s) => weekdaysByKey.set(s.key, (weekdaysByKey.get(s.key) ?? new Set()).add(s.weekday)));
  const adds: Suggestion[] = [];
  for (const s of series) {
    for (let k = 1; k <= 3; k++) {
      const d = addDays(startOfDay(s.last), k * s.period);
      d.setMinutes(s.minutes);
      const expected = d.getTime();
      if (expected <= nowMs) continue;
      if (expected > horizon) break;
      const id = `add|${s.key}|${format(expected, 'yyyy-MM-dd')}`;
      const covered = events.some((e) => {
        if (seriesKey(e.title) !== s.key || Math.abs(e.start - expected) > 2 * DAY) return false;
        const wd = new Date(e.start).getDay();
        return wd === s.weekday || !weekdaysByKey.get(s.key)!.has(wd); // moved to another day still counts
      });
      const wasSkipped = skipped.some((x) => x.key === s.key && Math.abs(x.at - expected) <= 3 * DAY);
      if (covered || wasSkipped || dismissed.has(id)) continue;
      const tag = calName(s.calendarId);
      const phrase = `${s.title} ${dayWord(expected, now)} at ${timeWord(expected)}${s.duration !== 60 ? ` for ${lengthWord(s.duration)}` : ''}${tag ? ` #${tag.split(/\s+/)[0].toLowerCase()}` : ''}`;
      // Keep it only if the sentence really creates this event.
      const p = parseQuick(phrase, calendars, now);
      const ok =
        p.start === expected &&
        p.end === expected + s.duration * MIN &&
        seriesKey(p.title) === s.key &&
        (!tag || p.calendarId === s.calendarId);
      if (!ok) continue;
      const usual = s.period === 7 ? `Usually ${plural(s.weekday)}` : `Every other ${format(s.last, 'EEEE')}`;
      adds.push({ id, kind: 'add', phrase, reason: `${usual} at ${timeWord(expected)} · not on your calendar this week` });
    }
  }
  out.push(...adds.slice(0, 3));

  // 1b. A deadline inside its runway with no time set aside for it: offer a focus block.
  const focus: Suggestion[] = [];
  const taken: { start: number; end: number }[] = []; // slots already offered above
  for (const d of deadlines.filter((x) => x.start > nowMs && x.start - nowMs <= (x.leadDays ?? 14) * DAY).sort((a, b) => a.start - b.start)) {
    if (focus.length >= 2) break;
    const key = seriesKey(d.title);
    const planned = events.some(
      (e) => e.start > nowMs && e.start < d.start && (e.linkedTo === d.id || seriesKey(e.title).split(' ').some((w) => key.split(' ').includes(w))),
    );
    if (planned) continue;
    // First free 3-hour (or 2-hour) slot between 9 and 5, starting tomorrow, before it's due.
    let slot: { t: number; h: number } | null = null;
    for (let k = 1; k <= 7 && !slot; k++) {
      const day = addDays(startOfDay(now), k);
      if (day.getDay() % 6 === 0) continue; // weekdays only
      for (const h of [3, 2]) {
        for (let m = 9 * 60; m + h * 60 <= 17 * 60 && !slot; m += 30) {
          const t = day.getTime() + m * MIN;
          if (t + h * 60 * MIN > d.start) break;
          const free = (x: { start: number; end: number }) => !(x.start < t + h * 60 * MIN && x.end > t);
          if (events.every((e) => e.allDay || free(e)) && taken.every(free)) slot = { t, h };
        }
        if (slot) break;
      }
    }
    if (!slot) continue;
    const id = `focus|${d.id}|${format(slot.t, 'yyyy-MM-dd')}`;
    if (dismissed.has(id)) continue;
    const phrase = `Work on ${d.title} ${dayWord(slot.t, now)} at ${timeWord(slot.t)} for ${slot.h}h`;
    const p = parseQuick(phrase, calendars, now);
    if (p.start !== slot.t || p.end !== slot.t + slot.h * 60 * MIN || p.deadline) continue;
    taken.push({ start: slot.t, end: slot.t + slot.h * 60 * MIN });
    const left = differenceInCalendarDays(d.start, now); // same count as the sidebar countdown
    focus.push({ id, kind: 'focus', phrase, reason: `⚑ Due in ${left} day${left === 1 ? '' : 's'} · nothing scheduled for it yet` });
  }
  out.push(...focus);

  // 1d. A weekly habit your calendar can tick, short for the week (counting what's already booked):
  //     from Wednesday on, offer one at your usual time on the first day it's free.
  const today = dayOf(nowMs);
  const dayIdx = today - weekStart(today); // 0 = Monday
  for (const h of opts.habits ?? []) {
    if (h.archived || h.kind !== 'check' || h.period !== 'week' || !h.match?.trim() || dayIdx < 2) continue;
    const q = h.match.trim().toLowerCase();
    const matching = events.filter((e) => !e.allDay && e.title.toLowerCase().includes(q));
    const done = periodProgress(h, opts.habitLog ?? {}, calendarCredit(h, events, nowMs), today).done;
    const sunday = addDays(startOfDay(now), 6 - dayIdx);
    const booked = matching.filter((e) => e.start > nowMs && e.start < addDays(sunday, 1).getTime()).length;
    const needed = h.goal - done - booked;
    if (needed <= 0) continue;
    // Your usual time and length, from the last 10 weeks (else 5:30 PM for an hour).
    const past = matching.filter((e) => e.end <= nowMs && e.start > nowMs - HISTORY_DAYS * DAY);
    const minutes = past.length ? mode(past.map((e) => minutesOfDay(e.start)))! : 17 * 60 + 30;
    const length = past.length ? mode(past.map((e) => Math.round((e.end - e.start) / MIN)))! : 60;
    for (let k = 1; startOfDay(addDays(now, k)) <= sunday; k++) {
      const t = startOfDay(addDays(now, k)).getTime() + minutes * MIN;
      const free = events.every((e) => e.allDay || e.end <= t || e.start >= t + length * MIN) && !matching.some((e) => isSameDay(e.start, t));
      if (!free) continue;
      const id = `habit|${h.id}|${format(t, 'yyyy-MM-dd')}`;
      if (dismissed.has(id)) break;
      const phrase = `${h.title} ${dayWord(t, now)} at ${timeWord(t)}${length !== 60 ? ` for ${lengthWord(length)}` : ''}`;
      const p = parseQuick(phrase, calendars, now);
      if (p.start !== t || p.end !== t + length * MIN || !p.title.toLowerCase().includes(q)) break; // must do exactly this
      out.push({ id, kind: 'habit', phrase, reason: `${h.title}: ${done} of ${h.goal} this week${booked ? ` (+${booked} booked)` : ''} · ${needed} to go` });
      break;
    }
  }

  // 1c. Tasks overdue 3+ days: one nudge each, so nothing quietly rots (do it / move it / drop it).
  const allTasks = opts.tasks ?? [];
  const stale = allTasks
    .filter((t) => !t.done && overdueDays(t, nowMs) >= 3)
    .sort((a, b) => overdueDays(b, nowMs) - overdueDays(a, nowMs));
  const taskTargets = tasksForCommands(allTasks, nowMs);
  let staleCount = 0;
  for (const t of stale) {
    if (staleCount >= 2) break;
    const id = `stale|${t.id}`;
    const phrase = `Move ${t.title} to tomorrow`;
    if (dismissed.has(id)) continue;
    const c = parseCommand(phrase, taskTargets, calendars, now);
    if (c?.kind !== 'move' || c.matches[0]?.id !== t.id) continue;
    const d = overdueDays(t, nowMs);
    out.push({ id, kind: 'stale', phrase, reason: `Overdue ${d} days · or say “done ${t.title}” / “drop ${t.title}”` });
    staleCount++;
  }

  // 2. Upcoming clashes: move the later-starting (or shorter) event to the nearest free slot that day
  const timed = upcoming.filter((e) => !e.allDay && e.start > nowMs).sort((a, b) => a.start - b.start);
  const moves: Suggestion[] = [];
  for (let i = 0; i < timed.length && moves.length < 2; i++)
    for (let j = i + 1; j < timed.length && moves.length < 2; j++) {
      const a = timed[i];
      const b = timed[j];
      if (b.start >= a.end) break;
      const isRegular = (e: CalEvent) => series.some((s) => s.key === seriesKey(e.title));
      const mover = isRegular(b) && !isRegular(a) ? a : b; // keep regular meetings where they are
      const other = mover === a ? b : a;
      const len = mover.end - mover.start;
      const day = startOfDay(mover.start);
      const busy = events.filter((e) => e.id !== mover.id && !e.allDay && isSameDay(e.start, day));
      let best: number | null = null;
      for (let m = 8 * 60; m + len / MIN <= 20 * 60; m += 30) {
        const t = day.getTime() + m * MIN;
        if (t <= nowMs || busy.some((e) => e.start < t + len && e.end > t)) continue;
        if (best === null || Math.abs(t - mover.start) < Math.abs(best - mover.start)) best = t;
      }
      if (best === null) continue;
      const id = `move|${mover.id}|${best}`;
      if (dismissed.has(id)) continue;
      const phrase = `Move ${mover.title} to ${dayWord(best, now)} at ${timeWord(best)}`;
      const c = parseCommand(phrase, events, calendars, now);
      const plan = c?.matches[0] && c.matches[0].id === mover.id ? c.plan(mover) : null;
      if (!plan || plan.start !== best || plan.end !== best + len) continue;
      moves.push({ id, kind: 'move', phrase, reason: `Overlaps “${other.title}” ${dayWord(other.start, now)} at ${timeWord(other.start)}` });
    }
  out.push(...moves);

  // 3. Starting soon: offer to push it back
  const soon = timed.find((e) => e.start - nowMs <= 90 * MIN);
  if (soon) {
    const id = `late|${soon.id}|${soon.start}`;
    const phrase = `Push ${soon.title} back 15 min`;
    const c = parseCommand(phrase, events, calendars, now);
    if (!dismissed.has(id) && c?.matches[0]?.id === soon.id)
      out.push({ id, kind: 'late', phrase, reason: `Starts in ${Math.round((soon.start - nowMs) / MIN)} min` });
  }

  // 4. Skip the next occurrence of a regular meeting
  const skips: Suggestion[] = [];
  for (const e of timed) {
    if (skips.length >= 2) break;
    const s = series.find((x) => x.key === seriesKey(e.title));
    if (!s || e.start - nowMs > 3 * DAY) continue;
    if (e.createdAt && nowMs - e.createdAt < DAY) continue; // you just added it
    const id = `skip|${e.id}`;
    const phrase = `Skip ${e.title} ${dayWord(e.start, now)}`;
    if (dismissed.has(id) || skips.some((x) => x.phrase === phrase)) continue;
    const c = parseCommand(phrase, events, calendars, now);
    if (c?.kind !== 'delete' || c.matches[0]?.id !== e.id) continue;
    skips.push({ id, kind: 'skip', phrase, reason: `${s.period === 7 ? 'Weekly' : 'Every other week'} · next one ${format(e.start, 'EEE')} ${fmtTime(e.start)}` });
  }
  out.push(...skips);

  return out.slice(0, 6);
}
