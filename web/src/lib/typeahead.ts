// Suggest-as-you-type: complete sentences you might mean, built from your own events.
// They are only offered — nothing is ever filled in unless you pick one.
import { addDays, format, isSameDay } from 'date-fns';
import type { CalEvent, CalendarSource } from '../data/types';
import { parseQuick } from './quickparse';
import { words } from './commands';
import { typoDistance } from './fuzzy';
import { describeRecurrence } from './recurrence';
import type { Suggestion } from './suggest';
import { guessKind, hasTaskPrefix, stripTaskPrefix } from './tasks';
import { fmtTime } from './format';

const DAY = 86_400_000;

/** What a sentence would do if you pressed Enter — decides a suggestion's icon and colour. */
export type PhraseAction = 'event' | 'task' | 'deadline' | 'delete' | 'move' | 'shift' | 'resize' | 'done';
export interface TypeaheadItem {
  phrase: string;
  reason: string;
}

const VERBS: [RegExp, string][] = [
  [/^(skip|cancel|delete|remove|drop)$/i, 'delete'],
  [/^(move|reschedule)$/i, 'move'],
  [/^(push|delay|postpone)$/i, 'push'],
  [/^(shift|bump)$/i, 'shift'],
  [/^(extend|lengthen|shorten)$/i, 'resize'],
  [/^(done|finished|completed?|submitted)$/i, 'done'],
];

/** Every typed word must match a title word; the last one may be a partial word. */
function matches(typed: string[], title: string) {
  if (!typed.length) return true;
  const tw = words(title);
  return typed.every((q, i) => {
    const last = i === typed.length - 1;
    // A partial last word may have a typo too: compare with prefixes one letter shorter/longer ("jorn" ~ "journ").
    const nearPrefix = (t: string) => [-1, 0, 1].some((k) => typoDistance(q, t.slice(0, q.length + k)) <= 1);
    return tw.some((t) => t.startsWith(q) || (q.length >= 4 && (last ? nearPrefix(t) : typoDistance(q, t) <= 1)));
  });
}

function dayWord(t: number, now: Date) {
  if (isSameDay(t, now)) return 'today';
  if (isSameDay(t, addDays(now, 1))) return 'tomorrow';
  if (t - now.getTime() < 6.5 * DAY) return format(t, 'EEEE').toLowerCase();
  return format(t, 'MMM d').toLowerCase();
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function phraseAction(phrase: string, calendars: CalendarSource[], now = new Date()): PhraseAction {
  const first = phrase.trim().split(/\s+/)[0] ?? '';
  for (const [re, verb] of VERBS) if (re.test(first)) return verb === 'push' ? 'shift' : (verb as PhraseAction);
  if (hasTaskPrefix(phrase)) return 'task';
  return guessKind(phrase, parseQuick(stripTaskPrefix(phrase), calendars, now));
}

export function typeahead(
  text: string,
  events: CalEvent[], // one-off events + occurrences over a window
  masters: CalEvent[],
  calendars: CalendarSource[],
  weekAhead: Suggestion[],
  now = new Date(),
): TypeaheadItem[] {
  const raw = text.trim();
  if (raw.length < 2) return [];
  const nowMs = now.getTime();
  const out: TypeaheadItem[] = [];
  const push = (item: TypeaheadItem) => {
    if (item.phrase.toLowerCase() !== raw.toLowerCase() && !out.some((o) => o.phrase === item.phrase)) out.push(item);
  };

  const [first, ...restWords] = raw.split(/\s+/);
  const verb = VERBS.find(([re]) => re.test(first))?.[1];
  if (verb) {
    const rest = restWords.join(' ');
    // Already past the event name ("… to friday", "… back 30") — nothing to add.
    if (/\b(to|by|back|later|earlier|forward|until|for)\b/i.test(rest)) return [];
    const series = /\b(all|every|recurring|repeating)\b/i.test(rest);
    const typed = words(rest.replace(/\b(all|every|recurring|repeating|the|my|this|next|week)\b/gi, ' ')).filter(Boolean);
    const Verb = cap(first.toLowerCase());
    if (series || verb === 'delete') {
      for (const m of masters.filter((m) => m.recurrence && matches(typed, m.title)).slice(0, 2))
        if (verb === 'delete') push({ phrase: `${Verb} all recurring ${m.title}`, reason: `Stops the series · ${describeRecurrence(m.recurrence!, m.start)}` });
    }
    const upcoming = events
      .filter((e) => (verb === 'done' ? (e.kind === 'task' || e.kind === 'deadline') && !e.done : e.kind !== 'deadline' || verb !== 'resize'))
      .filter((e) => (verb === 'done' ? e.start < nowMs + 60 * DAY : e.end > nowMs && e.start < nowMs + 14 * DAY) && matches(typed, e.title))
      .sort((a, b) => a.start - b.start);
    for (const e of upcoming) {
      if (out.length >= 4) break;
      const when = `${format(e.start, 'EEE MMM d')}${e.allDay ? '' : `, ${fmtTime(e.start)}`}`;
      const day = dayWord(e.start, now);
      if (verb === 'done') push({ phrase: `${Verb} ${e.title}`, reason: e.kind === 'task' ? 'Task' : `⚑ due ${format(e.start, 'EEE MMM d')}` });
      else if (verb === 'delete') push({ phrase: e.kind === 'task' ? `${Verb} ${e.title}` : `${Verb} ${e.title} ${day}`, reason: e.kind === 'task' ? 'Task' : when });
      else if (verb === 'move') push({ phrase: `${Verb} ${e.title} ${day} to `, reason: `${when} · then type where to` });
      else if (verb === 'push') push({ phrase: `${Verb} ${e.title} ${day} back 15 min`, reason: when });
      else if (verb === 'shift') push({ phrase: `${Verb} ${e.title} ${day} 30 min later`, reason: when });
      else push({ phrase: `${Verb} ${e.title} ${day} by 30 min`, reason: when });
    }
    return out.slice(0, 4);
  }

  // New event: offer the full names of events you've had, keeping the rest of what you typed.
  const p = parseQuick(raw, calendars, now);
  const typedTitle = p.title.trim();
  const typed = words(typedTitle);
  if (typed.length) {
    const known = new Map<string, { title: string; count: number; last: number; calendarId: string }>();
    for (const e of [...events, ...masters]) {
      if (e.start < nowMs - 120 * DAY) continue;
      const k = e.title.toLowerCase();
      const cur = known.get(k);
      if (cur) {
        cur.count++;
        cur.last = Math.max(cur.last, e.start);
      } else known.set(k, { title: e.title, count: 1, last: e.start, calendarId: e.calendarId });
    }
    const ranked = [...known.values()]
      .filter((k) => k.title.toLowerCase() !== typedTitle.toLowerCase() && matches(typed, k.title))
      .sort((a, b) => b.count - a.count || b.last - a.last);
    const at = raw.toLowerCase().indexOf(typedTitle.toLowerCase());
    for (const k of ranked.slice(0, 3)) {
      if (at < 0) break; // the title isn't one contiguous piece of what was typed
      const tag = calendars.find((c) => c.id === k.calendarId)?.name;
      const tagText = tag && !/#\w/.test(raw) ? ` #${tag.split(/\s+/)[0].toLowerCase()}` : '';
      const phrase = `${raw.slice(0, at)}${k.title}${raw.slice(at + typedTitle.length)}`.replace(/\s+/g, ' ').trim() + tagText;
      push({ phrase, reason: `${k.count > 1 ? `${k.count}× recently` : 'Seen recently'}${tag ? ` · ${tag}` : ''}` });
    }
  }
  // Week-ahead suggestions that match what's typed.
  const all = words(raw);
  for (const s of weekAhead) if (matches(all, s.phrase)) push({ phrase: s.phrase, reason: s.reason });
  return out.slice(0, 4);
}
