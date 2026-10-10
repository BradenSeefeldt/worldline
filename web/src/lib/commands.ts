// Commands that change existing events, typed or dictated into the quick-add box:
//   skip / cancel / delete X [scope]          → delete   ("skip all lunch talks this week")
//   move / reschedule / push X to <when>      → move     ("move Alex's meeting to tues at 3pm")
//   shift / push / delay / pull X by <amount> → shift    ("shift suresh meeting half an hour earlier")
//   extend / shorten X by <amount>            → resize   ("extend thesis writing by 30 min")
// Anything else returns null and is treated as a new event.
//
// The event X is found by forgiving word matching on titles (possessives, plurals, prefixes,
// one-letter typos), optionally narrowed by a scope ("tomorrow", "this week", "the 3pm one").
import { addDays, startOfDay, startOfWeek } from 'date-fns';
import type { CalEvent, CalendarSource, Recurrence } from '../data/types';
import { parseQuick } from './quickparse';
import { MIN, minutesOfDay } from './dates';
import { typoDistance } from './fuzzy';

export type CommandKind = 'delete' | 'move' | 'shift' | 'resize' | 'done';

export interface Change {
  start: number;
  end: number;
  allDay: boolean;
  recurrence?: Recurrence; // series edits may change the repeat days
}

export interface Command {
  kind: CommandKind;
  query: string; // the event description we searched for (for messages)
  matches: CalEvent[]; // best first
  all: boolean; // apply to every match ("skip all …")
  plan: (ev: CalEvent) => Change | null; // new times (null for delete)
  series?: boolean; // matches are whole recurring series (their master events)
  summary: string; // e.g. "30 min earlier", "to Tue Oct 13, 3 PM"
}

// ---------------------------------------------------------------- word matching
const STOP = new Set([
  'the', 'my', 'our', 'a', 'an', 'with', 'w', 'and', 'of', 'for', 'to', 'on', 'at', 'in', 'this', 'that', 'next', 'one', 'event', 'thing',
  'deadline', 'due', 'as', 'task', 'todo',
]);
const SOFT = new Set(['meeting', 'meet', 'call', 'sync', 'session', 'appointment', 'appt', 'chat', 'catchup']);

const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);

/** How well a query word matches a title word: 2 exact, 1 close, 0 no. */
function wordScore(q: string, t: string) {
  if (q === t) return 2;
  if (q.length >= 3 && t.startsWith(q)) return 1; // "sim" → "simulation"
  if (q.length >= 4 && Math.abs(q.length - t.length) <= 2 && typoDistance(q, t) <= (q.length >= 8 ? 2 : 1)) return 1; // typos
  return 0;
}

interface Target {
  query: string;
  all: boolean;
  matches: CalEvent[];
}

/** What a phrase like "all recurring meetings with Alex on Fridays at 3" asks for. */
interface Analysis {
  query: string;
  all: boolean;
  scope?: [number, number]; // a date range ("this week", "tomorrow")
  atTime?: number; // minutes after midnight ("the 3pm meeting")
  weekdays?: number[]; // "on Fridays", "every friday"
  required: string[];
  soft: string[];
  qLen: number;
  series: boolean; // talks about the series itself ("recurring", "every", "all … on Fridays")
}

const SERIES_WORDS = /\b(recurring|repeating|regular|series|future|ongoing)\b/i;

function analyze(phrase: string, calendars: CalendarSource[], now: Date): Analysis {
  let t = ` ${phrase} `;
  let all = false;
  t = t.replace(/^\s*(?:all|every|both|the whole|the entire)\s+(?:of\s+)?(?:the\s+|my\s+|our\s+)?/i, () => ((all = true), ' '));
  const seriesWord = SERIES_WORDS.test(t);
  t = t.replace(new RegExp(SERIES_WORDS.source, 'gi'), ' ').replace(/\bevents?\b/gi, ' ');

  let scope: [number, number] | undefined;
  t = t.replace(/\b(this|next|last)\s+week(?:['’]s)?\b/i, (_, which: string) => {
    const base = addDays(startOfWeek(now, { weekStartsOn: 1 }), which === 'next' ? 7 : which === 'last' ? -7 : 0);
    scope = [base.getTime(), addDays(base, 7).getTime()];
    return ' ';
  });
  const p = parseQuick(t, calendars, now);
  const weekdays = p.repeatDays; // "on Fridays" / "every friday" (named days only)
  if (!scope && p.hasDay && !p.recurrence)
    scope = p.allDay ? [p.start, p.end] : [startOfDay(p.start).getTime(), addDays(startOfDay(p.start), 1).getTime()];
  const atTime = p.hasTime ? minutesOfDay(p.start) : undefined;

  const q = words(`${p.title} ${p.location ?? ''}`).filter((w) => !STOP.has(w));
  let required = q.filter((w) => !SOFT.has(w));
  const soft = q.filter((w) => SOFT.has(w));
  if (!required.length) required = soft; // "skip the meeting tomorrow"
  return {
    query: p.title || phrase.trim(),
    all: all || !!p.recurrence,
    scope,
    atTime,
    weekdays,
    required,
    soft,
    qLen: q.length,
    series: seriesWord || !!p.recurrence || (all && !scope),
  };
}

/** Title match score, or null if a required word is missing. */
function titleScore(a: Analysis, title: string) {
  const tw = words(title);
  let score = 0;
  for (const w of a.required) {
    const best = Math.max(0, ...tw.map((x) => wordScore(w, x)));
    if (!best) return null;
    score += best;
  }
  for (const w of a.soft) score += Math.max(0, ...tw.map((x) => wordScore(w, x))) / 2;
  return score - Math.max(0, tw.length - a.qLen) * 0.1; // prefer titles without many extra words
}

/** Single events / occurrences that match. `near`: prefer the one closest to this time. */
function matchInstances(a: Analysis, events: CalEvent[], now: Date, near?: number): Target {
  const { query, all } = a;
  if (!a.required.length && a.atTime === undefined) return { query, all, matches: [] };
  const nowMs = now.getTime();
  const earliest = near !== undefined ? nowMs - 7 * 86_400_000 : nowMs;
  const scored: { ev: CalEvent; score: number }[] = [];
  for (const ev of events) {
    if (a.scope ? !(ev.start < a.scope[1] && ev.end > a.scope[0]) : ev.end <= earliest) continue;
    if (a.atTime !== undefined && (ev.allDay || minutesOfDay(ev.start) !== a.atTime)) continue;
    if (a.weekdays && !a.weekdays.includes(new Date(ev.start).getDay())) continue;
    const score = titleScore(a, ev.title);
    if (score !== null) scored.push({ ev, score });
  }
  // Best wording first; among equally good matches, upcoming before past, then soonest.
  scored.sort((x, y) => {
    if (Math.abs(x.score - y.score) > 0.5) return y.score - x.score;
    if (near !== undefined) return Math.abs(x.ev.start - near) - Math.abs(y.ev.start - near);
    const ux = x.ev.end > nowMs ? 0 : 1;
    const uy = y.ev.end > nowMs ? 0 : 1;
    return ux - uy || (ux ? y.ev.start - x.ev.start : x.ev.start - y.ev.start);
  });
  let matches = scored.map((s) => s.ev);
  // "skip all X this week" means the ones still ahead, not ones that already happened.
  if (all && matches.some((e) => e.end > nowMs)) matches = matches.filter((e) => e.end > nowMs);
  return { query, all, matches };
}

/** Recurring series (their master events) that match. */
function matchSeries(a: Analysis, masters: CalEvent[], now: Date): CalEvent[] {
  if (!a.required.length && a.atTime === undefined) return [];
  return masters
    .filter((m) => m.recurrence && (m.recurrence.until === undefined || m.recurrence.until > now.getTime()))
    .filter((m) => a.atTime === undefined || minutesOfDay(m.start) === a.atTime)
    .filter((m) => !a.weekdays || (m.recurrence!.byDay ?? [new Date(m.start).getDay()]).some((d) => a.weekdays!.includes(d)))
    .map((m) => ({ m, score: titleScore(a, m.title) }))
    .filter((x) => x.score !== null)
    .sort((x, y) => y.score! - x.score!)
    .map((x) => x.m);
}

/** Find the events a phrase like "all lunch talks this week" refers to. */
export function findEvents(phrase: string, events: CalEvent[], calendars: CalendarSource[], now: Date, near?: number): Target {
  return matchInstances(analyze(phrase, calendars, now), events, now, near);
}

// ---------------------------------------------------------------- durations
const NUM = String.raw`(an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty-?five|half an?|half|a half|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(minutes?|mins?|m|hours?|hrs?|h|days?|weeks?|wks?)`;
const DURATION = new RegExp(
  String.raw`(?:\bby\s+)?(?:\b(\d+)h(\d{1,2})m?\b|\b${NUM}\s*${UNIT}\b(?:\s*(?:and\s*)?(a half|\d+)\s*(?:minutes?|mins?)?\b)?)`,
  'i',
);
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, fifteen: 15, twenty: 20, thirty: 30, fortyfive: 45, 'forty-five': 45,
};

/** "half an hour" → {minutes: 30} ; "2 days" → {days: 2}. Returns the matched text too. */
function takeDuration(s: string): { minutes: number; days: number; text: string } | null {
  const m = s.match(DURATION);
  if (!m) return null;
  const [text, ch, cm, n, unit, extra] = m;
  if (ch) return { minutes: +ch * 60 + +(cm ?? 0), days: 0, text };
  const k = n.toLowerCase();
  const val = /^half/.test(k) || k === 'a half' ? 0.5 : WORD_NUM[k] ?? parseFloat(k);
  const u = unit.toLowerCase();
  if (u.startsWith('d')) return { minutes: 0, days: val, text };
  if (u.startsWith('w')) return { minutes: 0, days: val * 7, text };
  let minutes = val * (u.startsWith('h') ? 60 : 1);
  if (extra) minutes += extra === 'a half' ? 30 : +extra;
  return { minutes, days: 0, text };
}

const fmtAmount = (d: { minutes: number; days: number }) =>
  d.days
    ? `${d.days % 7 === 0 ? d.days / 7 : d.days} ${d.days % 7 === 0 ? 'week' : 'day'}${(d.days % 7 === 0 ? d.days / 7 : d.days) === 1 ? '' : 's'}`
    : d.minutes % 60 === 0
      ? `${d.minutes / 60} hour${d.minutes === 60 ? '' : 's'}`
      : d.minutes > 60
        ? `${Math.floor(d.minutes / 60)}h ${d.minutes % 60}m`
        : `${d.minutes} min`;

// ---------------------------------------------------------------- the commands
const DONE_BEFORE = /^\s*(?:mark\s+)?(?:done|finished|completed?|submitted|sent off|handed in)\s*:?\s+(.+)$/i;
const DONE_AFTER = /^\s*(?:mark\s+)?(.+?)\s+(?:as\s+)?(?:is\s+)?(?:done|finished|complete|completed|submitted|sent off|handed in)\s*$/i;
const DELETE_VERBS = /^\s*(?:please\s+)?(?:skip|cancel|delete|remove|drop|scrap|clear|nix|get rid of|forget)\s+(.+)$/i;
const MOVE_VERBS = /^\s*(?:please\s+)?(?:move|reschedule|change|switch|push|bump|shift|put)\s+(.+)$/i;
const SHIFT_VERBS = /^\s*(?:please\s+)?(shift|move|push|bump|delay|postpone|pull|bring|nudge|slide)\s+(.+)$/i;
const RESIZE_VERBS = /^\s*(?:please\s+)?(extend|lengthen|shorten|cut|trim)\s+(.+)$/i;
const EARLIER = /\b(earlier|early|sooner|forward|up|ahead|before)\b/i;
const LATER = /\b(later|late|back|out|down|after)\b/i;

const clean = (s: string) =>
  s
    .replace(/[.!?]+\s*$/, '')
    .replace(/\bas\s+(?=\d{1,2}(?::\d{2})?\s*(?:[ap]m)?\b)/gi, 'at ') // dictation: "Fridays as 3" → "at 3"
    .trim();

/**
 * `events`: one-off events and occurrences of recurring ones (expanded over a window).
 * `masters`: the recurring series themselves, for series-level commands
 * ("cancel all recurring meetings with Alex on Fridays").
 */
export function parseCommand(
  input: string,
  events: CalEvent[],
  calendars: CalendarSource[],
  now = new Date(),
  masters: CalEvent[] = [],
): Command | null {
  const text = clean(input);
  let m: RegExpMatchArray | null;

  // move X to <when> — try each " to " from the left; take the first split whose right side is a date/time.
  if ((m = text.match(MOVE_VERBS))) {
    const rest = m[1];
    const splits = [...rest.matchAll(/\s(?:to|until|till|for)\s/gi)];
    let fallback: Command | null = null;
    for (const sp of splits) {
      const targetText = rest.slice(0, sp.index);
      const when = rest.slice(sp.index! + sp[0].length);
      const dest = parseQuick(when, calendars, now);
      const nextWeek = /^\s*next week\s*$/i.test(when);
      if (!dest.hasDate && !nextWeek && !dest.recurrence) continue;
      const a = analyze(targetText, calendars, now);
      const timeGiven = dest.hasTime || dest.timeFromWords;
      const destDay = dest.repeatDays?.[0] ?? (dest.hasDay ? new Date(dest.start).getDay() : undefined);
      // The whole series: "move weekly Alex meeting to thursdays at 4"
      if (a.series || dest.recurrence) {
        const ms = matchSeries(a, masters, now);
        if (ms.length) {
          const plan = (m: CalEvent): Change => {
            const s = new Date(m.start);
            if (destDay !== undefined) s.setDate(s.getDate() + (destDay - s.getDay()));
            if (timeGiven) s.setHours(new Date(dest.start).getHours(), new Date(dest.start).getMinutes(), 0, 0);
            const length = dest.hasEnd ? dest.end - dest.start : m.end - m.start;
            const r = m.recurrence!;
            const byDay =
              r.freq === 'weekly' && destDay !== undefined
                ? (r.byDay?.length ?? 1) <= 1 || !a.weekdays
                  ? [destDay]
                  : [...new Set(r.byDay!.map((d) => (a.weekdays!.includes(d) ? destDay : d)))]
                : r.byDay;
            return { start: s.getTime(), end: s.getTime() + length, allDay: m.allDay, recurrence: { ...r, ...(byDay ? { byDay } : {}) } };
          };
          return { kind: 'move', query: a.query, all: true, series: true, matches: ms, plan, summary: `to ${when.trim()}` };
        }
      }
      const target = matchInstances(a, events, now, nextWeek ? undefined : dest.start);
      const plan = (ev: CalEvent): Change => {
        if (nextWeek) return { start: addDays(ev.start, 7).getTime(), end: addDays(ev.end, 7).getTime(), allDay: ev.allDay };
        if (ev.allDay && !timeGiven) {
          const days = Math.round((ev.end - ev.start) / 86_400_000);
          const s = startOfDay(dest.start);
          return { start: s.getTime(), end: addDays(s, days).getTime(), allDay: true };
        }
        const day = dest.hasDay ? startOfDay(dest.start) : startOfDay(ev.start);
        const minutes = timeGiven ? minutesOfDay(dest.start) : minutesOfDay(ev.start);
        const s = new Date(day);
        s.setMinutes(minutes);
        const length = dest.hasEnd ? dest.end - dest.start : ev.allDay ? 60 * MIN : ev.end - ev.start;
        return { start: s.getTime(), end: s.getTime() + length, allDay: false };
      };
      const cmd: Command = { kind: 'move', ...target, plan, summary: nextWeek ? 'to next week' : `to ${when.trim()}` };
      if (target.matches.length) return cmd;
      fallback ??= cmd;
    }
    if (fallback) return fallback;
  }

  // shift X by <amount> earlier/later
  if ((m = text.match(SHIFT_VERBS))) {
    const verb = m[1].toLowerCase();
    const rest = ` ${m[2]} `;
    const dur = takeDuration(rest);
    if (dur && (dur.minutes || dur.days)) {
      // The direction is the word right after the amount ("30 min earlier") or right before it
      // ("back an hour") — not any word in the title ("catch up with Sam").
      const at = rest.indexOf(dur.text);
      let before = rest.slice(0, at);
      let after = rest.slice(at + dur.text.length);
      const dirOf = (w?: string) => (!w ? 0 : EARLIER.test(w) ? -1 : LATER.test(w) ? 1 : 0);
      const nextWord = after.match(/^\s*(\w+)/)?.[1];
      const prevWord = before.match(/(\w+)\s*(?:by\s*)?$/)?.[1];
      let sign = dirOf(nextWord);
      if (sign) after = after.replace(nextWord!, ' ');
      else if ((sign = dirOf(prevWord))) before = before.replace(new RegExp(`${prevWord}(\\s*(?:by\\s*)?)$`), ' ');
      else if (verb === 'delay' || verb === 'postpone' || verb === 'push') sign = 1;
      else if (verb === 'pull') sign = -1;
      const r = `${before} ${after}`;
      if (sign) {
        const a = analyze(r.replace(/\bby\b/gi, ' '), calendars, now);
        const plan = (ev: CalEvent): Change => {
          const shift = (t: number) => addDays(t, sign * dur.days).getTime() + sign * dur.minutes * MIN;
          return { start: shift(ev.start), end: shift(ev.end), allDay: ev.allDay };
        };
        const summary = `${fmtAmount(dur)} ${sign < 0 ? 'earlier' : 'later'}`;
        const ms = a.series ? matchSeries(a, masters, now) : [];
        if (ms.length) return { kind: 'shift', query: a.query, all: true, series: true, matches: ms, plan, summary };
        return { kind: 'shift', ...matchInstances(a, events, now), plan, summary };
      }
    }
  }

  // extend / shorten X by <amount>
  if ((m = text.match(RESIZE_VERBS))) {
    const longer = /^(extend|lengthen)$/i.test(m[1]);
    const rest = ` ${m[2]} `;
    const dur = takeDuration(rest);
    if (dur && dur.minutes) {
      const target = findEvents(rest.replace(dur.text, ' ').replace(/\bby\b/gi, ' '), events, calendars, now);
      const plan = (ev: CalEvent): Change => ({
        start: ev.start,
        end: Math.max(ev.start + 15 * MIN, ev.end + (longer ? 1 : -1) * dur.minutes * MIN),
        allDay: ev.allDay,
      });
      return { kind: 'resize', ...target, plan, summary: `${longer ? 'longer' : 'shorter'} by ${fmtAmount(dur)}` };
    }
  }

  // done / finished / submitted X — tick off a deadline
  if ((m = text.match(DONE_BEFORE) ?? text.match(DONE_AFTER))) {
    const a = analyze(m[1], calendars, now);
    const open = events.filter((e) => (e.kind === 'deadline' || e.kind === 'task') && !e.done);
    // Overdue ones count too: you often tick something off after it was due.
    const t = matchInstances({ ...a, scope: a.scope }, open, new Date(now.getTime() - 60 * 86_400_000));
    return { kind: 'done', ...t, plan: () => null, summary: 'mark done' };
  }

  // skip / cancel / delete X
  if ((m = text.match(DELETE_VERBS))) {
    const a = analyze(m[1], calendars, now);
    // "cancel all recurring events with Alex on Fridays at 3": stop the series (past ones stay)
    const ms = a.series ? matchSeries(a, masters, now) : [];
    if (ms.length) return { kind: 'delete', query: a.query, all: true, series: true, matches: ms, plan: () => null, summary: 'stop repeating' };
    return { kind: 'delete', ...matchInstances(a, events, now), plan: () => null, summary: '' };
  }
  return null;
}
