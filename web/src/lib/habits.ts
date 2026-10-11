// Habits: small things you want to do regularly ("Gym 3× a week", "Read 20 pages a day").
// Progress is a forgiving "strength" score, not just a streak: an exponential moving average of how
// well you met the goal each day, s ← s + α·(x − s). One missed day barely dents it; a lazy fortnight
// drains it. Your calendar counts too: a "Gym" event that happened ticks "Gym".
// Rest days (sick, travelling) are logged as SKIP: they neither help nor hurt — strength holds, streaks pass through.
// Three kinds: done / not done ("check"), an amount ("count"), and things to cut down on ("avoid": logged slips,
// met while you stay at or under the limit — a clean day is a success without touching anything).
import type { CalEvent } from '../data/types';
import { epochDay, fromEpochDay } from './zone';
import { prefs } from './prefs';

export interface Habit {
  id: string;
  title: string;
  emoji?: string; // older habits had one; no longer shown
  color: string;
  kind: 'check' | 'count' | 'avoid'; // done / not done, an amount ("20 pages"), or something to avoid
  goal: number; // times (check) or amount (count) per period; avoid: the most slips allowed (usually 0)
  period: 'day' | 'week';
  unit?: string; // count habits: "pages", "min", "km"…
  match?: string; // calendar events whose title contains this count: done (check), or their length (count in min / h)
  archived?: boolean; // finished with: hidden from the sidebar, history kept
  createdAt: number;
}

/** Logged by hand: habit id → day (epoch day, local) → amount (check: 1, avoid: slips), or SKIP for a rest day. */
export type HabitLog = Record<string, Record<number, number>>;
/** A note per day: habit id → day → text. */
export type HabitNotes = Record<string, Record<number, string>>;
/** What your calendar did for a habit: day → amount (1 for a check habit; minutes or hours for a timed count habit). */
export type Credit = Map<number, number>;
export const SKIP = -1;

export const TAU_DAYS = 14; // the score's memory: about two weeks
const ALPHA = 1 - Math.exp(-1 / TAU_DAYS);

export const dayOf = (t: number) => {
  const d = new Date(t);
  return epochDay(d.getFullYear(), d.getMonth(), d.getDate());
};
export const dateOfDay = (day: number) => {
  const { y, m, d } = fromEpochDay(day);
  return new Date(y, m, d);
};
/** Monday of the week containing `day`. */
export const weekStart = (day: number) => day - ((day + 3) % 7); // epoch day 0 (1 Jan 1970) was a Thursday

/** A count habit measured in time ("min", "minutes", "h", "hours") — its calendar blocks can count by length. */
export const timeUnit = (unit?: string): 60 | 1 | null => {
  const u = (unit ?? '').trim().toLowerCase();
  if (/^(m|mins?|minutes?)$/.test(u)) return 1;
  if (/^(h|hrs?|hours?)$/.test(u)) return 60;
  return null;
};
/** Can this habit be credited by calendar events? (check habits, or count habits measured in time) */
export const canMatch = (h: Pick<Habit, 'kind' | 'unit'>) => h.kind === 'check' || (h.kind === 'count' && timeUnit(h.unit) !== null);

/** What finished calendar events with the habit's word in their title did: a check per day, or their total length. */
export function calendarCredit(h: Habit, events: CalEvent[], now = Date.now()): Credit {
  const out: Credit = new Map();
  const q = (h.match ?? '').trim().toLowerCase();
  if (!q || !canMatch(h) || !prefs.habitsFromCalendar) return out; // off in Settings → Habits
  const per = timeUnit(h.unit);
  for (const e of events) {
    if (e.kind === 'deadline' || e.kind === 'task' || e.allDay || e.end > now || !e.title.toLowerCase().includes(q)) continue;
    const d = dayOf(e.start);
    out.set(d, h.kind === 'check' ? 1 : (out.get(d) ?? 0) + Math.round((e.end - e.start) / 60_000) / per!);
  }
  return out;
}

/** A rest day: only daily habits have them (weekly goals already leave room). */
export const isSkipped = (h: Habit, log: HabitLog, day: number) => h.period === 'day' && (log[h.id]?.[day] ?? 0) < 0;

/** How much was done on a day. What you log wins; with nothing logged, your calendar's credit counts. Avoid: slips. */
export function amountOn(h: Habit, log: HabitLog, auto: Credit, day: number) {
  const v = log[h.id]?.[day];
  if (v !== undefined) return v < 0 ? 0 : h.kind === 'check' ? (v > 0 ? 1 : 0) : v;
  return h.kind === 'avoid' ? 0 : auto.get(day) ?? 0;
}
/** Is the goal met by this much? (avoid: staying at or under the limit) */
const meets = (h: Habit, done: number, goal = h.goal) => (h.kind === 'avoid' ? done <= goal : done >= goal);

/** Progress in the period containing `day` (this day, or Mon–Sun), as { done, goal }. */
export function periodProgress(h: Habit, log: HabitLog, auto: Credit, day: number) {
  if (h.period === 'day') return { done: amountOn(h, log, auto, day), goal: h.goal };
  const w = weekStart(day);
  let done = 0;
  for (let d = w; d < w + 7; d++) done += amountOn(h, log, auto, d);
  return { done, goal: h.goal };
}

/** How well the goal was met on `day`, 0–1 (null = rest day): a day habit by that day, a week habit by the 7 days ending then. */
function credit(h: Habit, log: HabitLog, auto: Credit, day: number): number | null {
  if (isSkipped(h, log, day)) return null;
  const span = h.period === 'day' ? 1 : 7;
  let sum = 0;
  for (let d = day - span + 1; d <= day; d++) sum += amountOn(h, log, auto, d);
  if (h.kind === 'avoid') return sum <= h.goal ? 1 : 0;
  return Math.min(1, sum / Math.max(h.goal, 1e-9));
}

/** The first day the habit has anything to say about: created, or the earliest record. */
export function firstDay(h: Habit, log: HabitLog, auto: Credit) {
  let f = dayOf(h.createdAt);
  for (const k in log[h.id] ?? {}) f = Math.min(f, Number(k));
  for (const d of auto.keys()) f = Math.min(f, d);
  return f;
}

/** Strength at the end of every day from the first through yesterday (index 0 = first day). */
export function strengthSeries(h: Habit, log: HabitLog, auto: Credit, today: number) {
  const first = Math.min(firstDay(h, log, auto), today);
  const values = new Float64Array(Math.max(0, today - first));
  let s = 0;
  for (let d = first; d < today; d++) {
    const x = credit(h, log, auto, d);
    if (x !== null) s += ALPHA * (x - s);
    values[d - first] = s;
  }
  return { first, values };
}

/** Habit strength 0–1. Today only counts once you've done something (the day isn't over). */
export function strength(h: Habit, log: HabitLog, auto: Credit, today: number) {
  const { values } = strengthSeries(h, log, auto, today);
  const s = values.length ? values[values.length - 1] : 0;
  const x = credit(h, log, auto, today);
  return x ? Math.max(s, s + ALPHA * (x - s)) : s;
}

/** Was the goal met for the period starting at `start`? (null = a rest day: neither met nor missed) */
function periodMet(h: Habit, log: HabitLog, auto: Credit, start: number): boolean | null {
  if (isSkipped(h, log, start)) return null;
  const p = periodProgress(h, log, auto, start);
  return meets(h, p.done);
}

/** Periods in a row the goal was met, counting the current one if it's met (else ending with the last). Rest days pass through. */
export function streak(h: Habit, log: HabitLog, auto: Credit, today: number) {
  const step = h.period === 'day' ? 1 : 7;
  let d = h.period === 'day' ? today : weekStart(today);
  if (periodMet(h, log, auto, d) !== true) d -= step; // the current period isn't over
  const first = h.period === 'day' ? firstDay(h, log, auto) : weekStart(firstDay(h, log, auto)); // nothing before the habit began
  let n = 0;
  for (; d >= first; d -= step) {
    const m = periodMet(h, log, auto, d);
    if (m === false) break;
    if (m) n++;
  }
  return n;
}

/** The longest run of periods met, ever, and the period it ended on. */
export function bestStreak(h: Habit, log: HabitLog, auto: Credit, today: number) {
  const step = h.period === 'day' ? 1 : 7;
  const start = h.period === 'day' ? firstDay(h, log, auto) : weekStart(firstDay(h, log, auto));
  let best = { n: 0, end: start };
  let run = 0;
  for (let d = start; d <= today; d += step) {
    const m = periodMet(h, log, auto, d);
    if (m === false) {
      run = 0;
      continue;
    }
    if (m) run++;
    if (run > best.n) best = { n: run, end: d };
  }
  return best;
}

/** One tap in the sidebar: mark today done, or clear it if it already is. */
export function tapAmount(h: Habit, log: HabitLog, auto: Credit, today: number) {
  const now = log[h.id]?.[today] ?? 0;
  if (h.kind === 'check' || h.kind === 'avoid') return now > 0 ? 0 : 1; // avoid: a tap logs a slip
  const perDay = h.period === 'day' ? h.goal : Math.ceil(h.goal / 7);
  return amountOn(h, log, auto, today) >= perDay ? 0 : perDay;
}

/** A day's fullness for heat maps: 0–1, or SKIP for a rest day. */
export function dayValue(h: Habit, log: HabitLog, auto: Credit, day: number) {
  if (isSkipped(h, log, day)) return SKIP;
  if (h.kind === 'avoid') return amountOn(h, log, auto, day) > 0 ? 0 : 1; // clean days fill in
  const perDay = h.period === 'day' ? h.goal : h.kind === 'check' ? 1 : h.goal / 7;
  return Math.min(1, amountOn(h, log, auto, day) / perDay);
}

/** The last `weeks` weeks, Monday-first columns ending with this week (null = future, or before the habit began). */
export function yearGrid(h: Habit, log: HabitLog, auto: Credit, today: number, weeks = 53) {
  const start = weekStart(today) - (weeks - 1) * 7;
  const first = firstDay(h, log, auto);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const d = start + w * 7 + i;
      return d > today || d < first ? null : dayValue(h, log, auto, d);
    }),
  );
}

/** One calendar year as Monday-first week columns: each cell is its day number, or null outside the year. */
export function yearWeeks(year: number) {
  const jan1 = epochDay(year, 0, 1);
  const end = epochDay(year + 1, 0, 1);
  const out: (number | null)[][] = [];
  for (let w = weekStart(jan1); w < end; w += 7) out.push(Array.from({ length: 7 }, (_, i) => (w + i >= jan1 && w + i < end ? w + i : null)));
  return out;
}

export type Bucket = 'week' | 'month' | 'year';
/** Totals per week / month / year from the first day through today: days done, amount, or clean days (avoid). */
export function totals(h: Habit, log: HabitLog, auto: Credit, bucket: Bucket, today: number) {
  const keyOf = (d: number) => {
    if (bucket === 'week') return weekStart(d);
    const { y, m } = fromEpochDay(d);
    return bucket === 'month' ? epochDay(y, m, 1) : epochDay(y, 0, 1);
  };
  const out: { start: number; value: number }[] = [];
  for (let d = keyOf(firstDay(h, log, auto)); d <= today; d++) {
    const k = keyOf(d);
    if (!out.length || out[out.length - 1].start !== k) out.push({ start: k, value: 0 });
    out[out.length - 1].value += unitOf(h, log, auto, d);
  }
  return out;
}
/** What a day adds to a total: days done, the amount, or 1 for a clean day (avoid). */
const unitOf = (h: Habit, log: HabitLog, auto: Credit, d: number) =>
  h.kind === 'avoid' ? (isSkipped(h, log, d) || amountOn(h, log, auto, d) > 0 ? 0 : 1) : amountOn(h, log, auto, d);

/** Sum between two days (inclusive): days done, amount, or clean days. */
export function sumBetween(h: Habit, log: HabitLog, auto: Credit, from: number, to: number) {
  let s = 0;
  for (let d = from; d <= to; d++) s += unitOf(h, log, auto, d);
  return s;
}

/** For each weekday (Mon…Sun), the share of those days something was done (rest days left out). */
export function weekdayRates(h: Habit, log: HabitLog, auto: Credit, today: number) {
  const done = Array(7).fill(0), all = Array(7).fill(0);
  for (let d = firstDay(h, log, auto); d <= today; d++) {
    if (isSkipped(h, log, d)) continue;
    const i = d - weekStart(d);
    all[i]++;
    if (h.kind === 'avoid' ? amountOn(h, log, auto, d) === 0 : amountOn(h, log, auto, d) > 0) done[i]++;
  }
  return done.map((n, i) => (all[i] ? n / all[i] : 0));
}

export const describeGoal = (h: Pick<Habit, 'kind' | 'goal' | 'period' | 'unit'>) =>
  h.kind === 'avoid'
    ? h.goal === 0
      ? h.period === 'day' ? 'Avoid every day' : 'Avoid all week'
      : `At most ${h.goal}× a ${h.period}`
    : h.kind === 'check'
    ? h.period === 'day'
      ? 'Every day'
      : `${h.goal}× a week`
    : `${h.goal} ${h.unit || ''}`.trim() + (h.period === 'day' ? ' a day' : ' a week');

/** "412 days" / "8,340 pages" — what a total means for this habit. */
export const describeAmount = (h: Pick<Habit, 'kind' | 'unit'>, n: number) =>
  h.kind === 'count'
    ? `${(Math.round(n * 10) / 10).toLocaleString()}${h.unit ? ` ${h.unit}` : ''}`
    : `${n.toLocaleString()} ${h.kind === 'avoid' ? 'clean ' : ''}${n === 1 ? 'day' : 'days'}`;

/** Everything as a CSV: one row per habit per day with anything recorded (date, habit, kind, amount, status, note). */
export function habitsCsv(habits: Habit[], log: HabitLog, notes: HabitNotes, credit: (h: Habit) => Credit) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [['date', 'habit', 'kind', 'amount', 'unit', 'status', 'note']];
  const iso = (d: number) => dateOfDay(d).toLocaleDateString('en-CA'); // YYYY-MM-DD
  for (const h of habits) {
    const auto = credit(h);
    const days = new Set<number>([...Object.keys(log[h.id] ?? {}).map(Number), ...auto.keys(), ...Object.keys(notes[h.id] ?? {}).map(Number)]);
    for (const d of [...days].sort((a, b) => a - b)) {
      const v = log[h.id]?.[d];
      const status = v !== undefined && v < 0 ? 'rest' : v === undefined && auto.has(d) ? 'calendar' : 'logged';
      const amt = status === 'rest' ? '' : String(amountOn(h, log, auto, d));
      rows.push([iso(d), h.title, h.kind, amt, h.kind === 'count' ? h.unit ?? '' : '', status, notes[h.id]?.[d] ?? '']);
    }
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

export const HABIT_TEMPLATES: Omit<Habit, 'id' | 'createdAt' | 'color'>[] = [
  { title: 'Gym', kind: 'check', goal: 3, period: 'week', match: 'gym' },
  { title: 'Read', kind: 'count', goal: 20, period: 'day', unit: 'pages' },
  { title: 'Meditate', kind: 'check', goal: 1, period: 'day' },
  { title: 'Run', kind: 'count', goal: 15, period: 'week', unit: 'km' },
  { title: 'Write', kind: 'count', goal: 30, period: 'day', unit: 'min', match: 'writing' },
  { title: 'Climb', kind: 'check', goal: 2, period: 'week', match: 'climb' },
  { title: 'No phone in bed', kind: 'avoid', goal: 0, period: 'day' },
];
