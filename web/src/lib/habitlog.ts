// Logging a habit from the quick-add box: "did gym", "read 20 pages", "meditated", "ran 5k yesterday".
// Deliberately strict and separate from the event parser, so it can never change how anything else is read:
//   • every word must be accounted for (a log verb, the habit's name, one amount + unit, today/yesterday, filler);
//     one leftover word ("tomorrow", "3pm", "with Alex") and it steps aside;
//   • a bare habit name ("gym") is never claimed — it needs a log verb, an amount, or a past tense ("meditated").
// Returns what would be logged, or null (then quick add carries on exactly as before).
import type { Habit } from './habits';
import { dayOf, timeUnit } from './habits';

export interface HabitLogPlan {
  habit: Habit;
  day: number; // epoch day
  amount: number; // to add: 1 for a check habit, in the habit's unit for a count habit
  yesterday: boolean;
}

const VERBS = new Set(['log', 'logged', 'did', 'done', 'finished', 'completed', 'tick', 'ticked', 'track', 'tracked']);
const FILLER = new Set(['i', 'just', 'my', 'a', 'an', 'the', 'some', 'for', 'of', 'today', 'tonight', '+']);
const IRREGULAR: Record<string, string> = { ran: 'run', wrote: 'write', swam: 'swim', rode: 'ride', went: 'go', ate: 'eat', drew: 'draw', sang: 'sing', lifted: 'lift' };
const PAST_ONLY = new Set(Object.keys(IRREGULAR));
const UNITS: [RegExp, string][] = [
  [/^(m|mins?|minutes?)$/, 'min'],
  [/^(h|hrs?|hours?)$/, 'h'],
  [/^(k|km|kms|kilometers?|kilometres?)$/, 'km'],
  [/^(mi|miles?)$/, 'mi'],
  [/^(p|pp|pages?)$/, 'pages'],
];
const canon = (u: string) => UNITS.find(([re]) => re.test(u))?.[1] ?? u.replace(/s$/, '');

/** "meditated" → meditate, "reading" → read, "runs" → run, "ran" → run. Returns the stem and whether it was past tense. */
function forms(word: string): { stems: string[]; past: boolean } {
  if (IRREGULAR[word]) return { stems: [IRREGULAR[word]], past: true };
  const out = [word];
  let past = false;
  if (word.endsWith('ed') && word.length > 4) {
    out.push(word.slice(0, -1), word.slice(0, -2)); // meditated → meditate, lifted → lift
    if (/(.)\1ed$/.test(word)) out.push(word.slice(0, -3)); // jogged → jog
    past = true;
  }
  if (word.endsWith('ing') && word.length > 5) out.push(word.slice(0, -3), `${word.slice(0, -3)}e`); // reading → read, writing → write
  if (word.endsWith('s') && word.length > 3) out.push(word.slice(0, -1));
  return { stems: out, past };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.!,]+$/g, '')
    .replace(/(\d)([a-z])/g, '$1 $2') // 5km → 5 km, 20pages → 20 pages
    .split(/\s+/)
    .filter(Boolean);

export function parseHabitLog(input: string, habits: Habit[], now = new Date()): HabitLogPlan | null {
  const live = habits.filter((h) => !h.archived && h.kind !== 'avoid');
  if (!live.length) return null;
  let ws = words(input);
  if (!ws.length || ws.length > 8) return null;

  let verb = false;
  let yesterday = false;
  // "yesterday" / "last night" / "this morning" — and nothing else about when.
  const rest: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w === 'yesterday') yesterday = true;
    else if (w === 'last' && ws[i + 1] === 'night') (yesterday = true), i++;
    else if (w === 'this' && /^(morning|afternoon|evening)$/.test(ws[i + 1] ?? '')) i++;
    else rest.push(w);
  }
  ws = rest;
  // A log verb at the start ("did gym", "logged 20 pages reading") or "done" at the end ("gym done").
  if (VERBS.has(ws[0])) (verb = true), ws.shift();
  if (ws[ws.length - 1] === 'done') (verb = true), ws.pop();

  // At most one amount, optionally with a unit right after it.
  let amount: number | null = null;
  let unit: string | null = null;
  const left: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (/^\d+(\.\d+)?$/.test(w)) {
      if (amount !== null) return null;
      amount = Number(w);
      const next = ws[i + 1];
      if (next && UNITS.some(([re]) => re.test(next))) (unit = canon(next)), i++;
    } else if (!FILLER.has(w)) left.push(w);
  }
  if (!left.length) return null;

  // What's left must be exactly one habit's name (any order, allowing -ed / -ing / plural forms).
  let found: { h: Habit; past: boolean } | null = null;
  for (const h of live) {
    const title = words(h.title).filter((w) => !FILLER.has(w));
    if (!title.length || title.length !== left.length) continue;
    const used = new Set<number>();
    let past = false;
    const ok = left.every((w) => {
      const f = forms(w);
      const j = title.findIndex((t, k) => !used.has(k) && f.stems.some((s) => s === t || (t.endsWith('ing') && s === t.slice(0, -3))));
      if (j < 0) return false;
      used.add(j);
      past ||= f.past;
      return true;
    });
    if (!ok) continue;
    if (found) return null; // two habits fit: don't guess
    found = { h, past };
  }
  if (!found) return null;
  const { h, past } = found;
  // A bare name is an event title, not a log: it needs a verb, an amount, or a past tense.
  if (!verb && amount === null && !past) return null;
  // "read" alone is ambiguous (present or past) — only the irregular / -ed forms count as past.
  if (!verb && amount === null && past && !PAST_ONLY.has(left[0]) && !left.some((w) => w.endsWith('ed'))) return null;

  let add: number;
  if (h.kind === 'check') {
    if (amount !== null) return null; // "gym 2" means nothing
    add = 1;
  } else {
    const per = h.period === 'day' ? h.goal : Math.ceil(h.goal / 7);
    if (amount === null) add = per; // "did my reading" → the day's goal
    else {
      add = amount;
      const want = canon((h.unit ?? '').toLowerCase());
      if (unit && unit !== want) {
        // minutes ↔ hours is the one conversion worth doing
        const from = timeUnit(unit === 'h' ? 'h' : unit), to = timeUnit(h.unit);
        if (!from || !to) return null;
        add = (amount * from) / to;
      }
    }
  }
  const today = dayOf(now.getTime());
  return { habit: h, day: yesterday ? today - 1 : today, amount: add, yesterday };
}
