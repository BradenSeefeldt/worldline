// Turns a typed or dictated sentence into an event, e.g.
//   "Lunch with Sam tomorrow 12:30 at Fran's #social for 90 min"
//
// Pipeline:
//   1. normalize   — clean dictation quirks and rewrite phrasings chrono-node misses
//                    ("sat 7", "11-1", "half past 3", "the 15th", "three pm", …)
//   2. extract     — #calendar, "for 2h" duration, "all day"
//   3. find dates  — chrono-node, ignoring weak matches (a bare month name like "June"
//                    is far more often a person); a separate date and time are combined
//   4. resolve     — apply human defaults: bare 1–7 means PM, "morning" means 9 AM,
//                    "lunch" means noon, a date with no time is all-day
//   5. location    — "at/in <Capitalized place>" or "@ place"; the rest is the title
import * as chrono from 'chrono-node';
import { addDays, addMonths, startOfDay } from 'date-fns';
import type { CalendarSource, Recurrence } from '../data/types';
import { MIN, dayIndex } from './dates';
import { fixDateTypos } from './fuzzy';

export interface Parsed {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  calendarId?: string;
  hasDate: boolean;
  // Which parts the sentence actually specified (used when moving existing events):
  hasDay: boolean; // a date or weekday
  hasTime: boolean; // an explicit clock time
  timeFromWords: boolean; // a time implied by "morning", "lunch", …
  hasEnd: boolean; // an explicit end ("3-4pm") or length ("for 2h")
  recurrence?: Recurrence; // "every friday", "weekly", "every other tue and thu until dec 15"
  repeatDays?: number[]; // weekdays actually named in a repeat phrase ("on Fridays")
  deadline?: { leadDays: number }; // "due", "deadline", "by friday", "needs 3 weeks"
}

// ---- deadlines ---------------------------------------------------------------------------
const LEAD_NUM = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|ten)';
const LEAD_UNIT = '(days?|weeks?|wks?|months?)';
const LEAD_RES = [
  new RegExp(`\\b(?:needs?|takes?|requires?|allow|give (?:it|myself|me))\\s+(?:about\\s+|~\\s*)?${LEAD_NUM}\\s*${LEAD_UNIT}(?:\\s+(?:of work|ahead|lead(?:\\s*time)?|runway))?\\b`, 'i'),
  new RegExp(`\\b(?:start|begin)\\s+${LEAD_NUM}\\s*${LEAD_UNIT}\\s+(?:before|ahead|early|out)\\b`, 'i'),
  new RegExp(`\\b${LEAD_NUM}\\s*${LEAD_UNIT}\\s+(?:of work|lead(?:\\s*time)?|runway)\\b`, 'i'),
];
const WORD_N: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10 };

/** "needs 3 weeks" → 21 (days of runway), removed from the text. */
function takeLead(t: string): [string, number | undefined] {
  for (const re of LEAD_RES) {
    const m = t.match(re);
    if (!m) continue;
    const n = WORD_N[m[1].toLowerCase()] ?? +m[1];
    const u = m[2].toLowerCase();
    return [t.replace(m[0], ' '), n * (u.startsWith('w') ? 7 : u.startsWith('m') ? 30 : 1)];
  }
  return [t, undefined];
}

// ---- repeats ----------------------------------------------------------------------------
const WD_NAMES: [RegExp, number][] = [
  [/^sun/i, 0], [/^mon/i, 1], [/^tue/i, 2], [/^wed/i, 3], [/^thu/i, 4], [/^fri/i, 5], [/^sat/i, 6],
];
const wdOf = (w: string) => WD_NAMES.find(([re]) => re.test(w))?.[1];
const WD = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?';
const WD_LIST = `${WD}s?(?:\\s*(?:,|and|&|\\+)\\s*${WD}s?)*`;
const UNIT_FREQ: Record<string, Recurrence['freq']> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' };

interface RepeatInfo {
  text: string;
  rule?: Recurrence;
  byDayGiven: boolean;
  untilText?: string;
  times?: number; // "for 10 weeks" / "10 times"
  timesUnit?: 'occurrence' | 'week' | 'month' | 'day' | 'year';
}

/** Pull repeat phrases out of the sentence. Only words that clearly mean "repeat" are taken. */
function takeRepeat(input: string): RepeatInfo {
  let t = ` ${input} `;
  let rule: Recurrence | undefined;
  let byDayGiven = false;
  const set = (freq: Recurrence['freq'], interval = 1, byDay?: number[]) => {
    rule = { freq, interval, ...(byDay ? { byDay } : {}) };
    if (byDay) byDayGiven = true;
  };
  const days = (list: string) => [...new Set(list.split(/\s*(?:,|and|&|\+)\s*/).map((w) => wdOf(w.trim())).filter((d): d is number => d !== undefined))];
  const take = (re: RegExp, fn: (...m: string[]) => void) => {
    t = t.replace(re, (...m) => (fn(...(m as string[])), ' '));
  };

  take(/\b(?:every|each|on)\s+weekdays?\b|\bweekdays\b/i, () => set('weekly', 1, [1, 2, 3, 4, 5]));
  if (!rule)
    take(new RegExp(`\\b(?:every|each)\\s+(other\\s+|second\\s+|2nd\\s+)?(${WD_LIST})\\b`, 'i'), (_, other, list) =>
      set('weekly', other ? 2 : 1, days(list)),
    );
  if (!rule)
    take(/\b(?:every|each)\s+(other|second|2nd|third|3rd|\d+)?\s*(day|week|month|year)s?\b/i, (_, n, unit) => {
      const k = !n ? 1 : /other|second|2nd/i.test(n) ? 2 : /third|3rd/i.test(n) ? 3 : +n;
      set(UNIT_FREQ[unit.toLowerCase()], k);
    });
  if (!rule) take(/\b(bi-?weekly|fortnightly)\b/i, () => set('weekly', 2));
  if (!rule)
    take(/\b(daily|weekly|monthly|yearly|annually|annual)\b/i, (_, w) =>
      set(({ daily: 'daily', weekly: 'weekly', monthly: 'monthly' } as Record<string, Recurrence['freq']>)[w.toLowerCase()] ?? 'yearly'),
    );
  // Plural weekdays mean a repeat too: "Alex meeting fridays at 3", "on mondays and wednesdays"
  const FULL = '(?:mon|tues|wednes|thurs|fri|satur|sun)days'; // only full names: "tues" alone is not a plural
  const plural = new RegExp(`\\b(?:on\\s+)?(${FULL}(?:\\s*(?:,|and|&)\\s*${FULL})*)\\b`, 'i');
  if (!rule || (rule.freq === 'weekly' && !rule.byDay)) {
    const m = t.match(plural);
    if (m) {
      const interval = rule?.interval ?? 1;
      t = t.replace(m[0], ' ');
      set('weekly', interval, days(m[1].replace(/s\b/gi, '')));
    }
  }
  if (!rule) return { text: input, byDayGiven: false };

  let untilText: string | undefined;
  take(/\b(?:until|till|til|through|thru|ending(?:\s+on)?|ends?)\s+((?:the\s+)?[\w/]+(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+\d{4})?)/i, (_, d) => {
    untilText = d;
  });
  let times: number | undefined;
  let timesUnit: RepeatInfo['timesUnit'];
  take(/\bfor\s+(\d+|two|three|four|five|six|ten|twelve)\s+(weeks?|months?|days?|years?|times|sessions|occurrences)\b/i, (_, n, u) => {
    times = NUMBER_WORDS[n.toLowerCase()] ?? +n;
    timesUnit = /^(times|sessions|occurrences)$/i.test(u) ? 'occurrence' : (u.toLowerCase().replace(/s$/, '') as RepeatInfo['timesUnit']);
  });
  take(/\b(x|×)\s*(\d+)\b|\b(\d+)\s*(x|×)\b/i, (_, _a, n1, n2) => {
    times = +(n1 ?? n2);
    timesUnit = 'occurrence';
  });
  t = t.replace(/\b(?:starting|beginning|from)\s+(?=\S)/i, ' ');
  return { text: t, rule, byDayGiven, untilText, times, timesUnit };
}

const WEEKDAY = '(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const TIME = '\\d{1,2}(?::\\d{2})?';
const SEP = 'Zsep';
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const PART_OF_DAY: [RegExp, number][] = [
  [/\bmorning\b/i, 9 * 60],
  [/\bafternoon\b/i, 14 * 60],
  [/\bevening\b/i, 18 * 60],
  [/\b(tonight|night)\b/i, 19 * 60],
];
const MEALS: [RegExp, number][] = [
  [/\bbreakfast\b/i, 8 * 60 + 30],
  [/\bbrunch\b/i, 11 * 60],
  [/\blunch\b/i, 12 * 60],
  [/\b(dinner|supper)\b/i, 18 * 60 + 30],
];

// A month name with no day number beside it ("coffee with June", "May's talk") is a name,
// not a date. Hide it from the date parser behind a placeholder and restore it afterwards.
// "June 10/22" is June + a slash date, so a day number only counts if no slash follows it.
const LONE_MONTH =
  /(?<!\d\s*)\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b(?!\.?\s*\d{1,2}(?:st|nd|rd|th)?\b(?!\/\d))/gi;
// Room numbers etc. ("MP 1318") must not be read as years; "at 1530" (24-hour time) and 20xx years are kept.
const LONG_NUMBER = /(?<![:/\d]|\bat\s)\b(?!20\d\d\b)\d{3,}\b(?![:/])/g;
// "Cottage weekend" is a name; only "this/next/the weekend" (or "on/over the weekend") is a date.
const LONE_WEEKEND = /(?<!\b(?:this|next|the|coming)\s+)\bweekend\b/gi;
function shieldNames(t: string): [string, (x: string) => string] {
  const saved: string[] = [];
  const hide = (m: string) => `Zqx${saved.push(m) - 1}x`;
  const out = t.replace(LONE_MONTH, hide).replace(LONG_NUMBER, hide).replace(LONE_WEEKEND, hide);
  return [out, (x) => x.replace(/Zqx(\d+)x/g, (_, i: string) => saved[+i])];
}

/** Step 1: rewrite the sentence into a form chrono parses reliably. */
function normalize(input: string, now: Date) {
  let t = ` ${input.trim()} `;
  t = t.replace(/[.!?]+\s*$/, ' '); // dictation adds a final period
  t = t.replace(/^\s*(?:please\s+)?(?:add|schedule|create|book|put in|set up|make|new event:?|remind me to|remind me|i have|i've got|there's|there is)\s+(?:an?\s+)?/i, ' ');
  t = t.replace(/\btues\b/gi, 'tuesday').replace(/\bthurs?\b/gi, 'thursday').replace(/\bweds\b/gi, 'wednesday');
  t = t.replace(/\b(tmrw|tmrrw|tmr|tmw|tomoz)\b/gi, 'tomorrow').replace(/\btonite\b/gi, 'tonight');
  t = t.replace(/\b(lunchtime|midday)\b/gi, 'noon').replace(/\b(eod|end of (?:the )?day)\b/gi, '5pm');
  t = t.replace(/(\d)\s*(a|p)\.\s?m\.?/gi, '$1$2m'); // "3 p.m." → "3pm"
  t = t.replace(/(\d)\s+([ap]m)\b/gi, '$1$2'); // "3 PM" → "3PM"

  // Number words when clearly a time: "at three", "three pm", "seven thirty"
  const nw = Object.keys(NUMBER_WORDS).join('|');
  t = t.replace(new RegExp(`\\b(at|from|to|until|till|-)\\s+(${nw})\\b`, 'gi'), (_, p: string, w: string) => `${p} ${NUMBER_WORDS[w.toLowerCase()]}`);
  t = t.replace(new RegExp(`\\b(${nw})(?=\\s*(?:am|pm|o'?clock|thirty|fifteen|forty-?five)\\b)`, 'gi'), (w) => String(NUMBER_WORDS[w.toLowerCase()]));
  t = t.replace(/\b(\d{1,2})\s+thirty\b/gi, '$1:30').replace(/\b(\d{1,2})\s+fifteen\b/gi, '$1:15').replace(/\b(\d{1,2})\s+forty-?five\b/gi, '$1:45');
  t = t.replace(/(?:\bat\s+)?\b(\d{1,2})\s*o'?clock\b/gi, 'at $1');
  t = t.replace(/\bhalf past (\d{1,2})\b/gi, '$1:30').replace(/\bquarter past (\d{1,2})\b/gi, '$1:15');
  t = t.replace(/\bquarter (?:to|of) (\d{1,2})\b/gi, (_, h: string) => `${((+h + 10) % 12) + 1}:45`);

  // 24-hour "at 1530" → "at 15:30"
  t = t.replace(/\bat ([01]\d|2[0-3])([0-5]\d)\b/g, 'at $1:$2');
  // "at 7" → "at 7:00": otherwise "at 7 nov 2" reads as 7 November
  t = t.replace(/\bat (1[0-2]|0?[1-9])(?![:\d])(\s*[ap]m\b)?/gi, (_, h: string, ap = '') => `at ${h}:00${ap}`);
  // "thursday after next" → "next thursday"
  t = t.replace(new RegExp(`\\b(${WEEKDAY}) after next\\b`, 'gi'), 'next $1');
  // "the 15th" (no month) → this month, or next month if already past
  t = t.replace(new RegExp(`(?<!${MONTH}\\s*)\\b(?:on\\s+)?the (\\d{1,2})(?:st|nd|rd|th)\\b`, 'gi'), (m, d: string) => {
    const day = +d;
    if (day < 1 || day > 31) return m;
    const month = day >= now.getDate() ? now : addMonths(now, 1);
    return ` ${month.toLocaleString('en', { month: 'short' })} ${day} `;
  });

  // Bare time ranges: "11-1", "2 to 4", "between 2 and 3" → "from 11 to 1" (not after a month: "oct 3-5")
  const range = new RegExp(
    `(?<![\\w/:])(?:between\\s+|from\\s+)?(${TIME})\\s*([ap]m)?\\s*(?:-|–|—|to|until|till|and)\\s*(${TIME})\\s*([ap]m)?(?![\\w/:])`,
    'gi',
  );
  t = t.replace(range, (m, a: string, ap = '', b: string, bp = '', offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    if (new RegExp(`${MONTH}\\s*$`, 'i').test(before)) return m; // a date range like "oct 3-5"
    if (/\band\b/i.test(m) && !/between/i.test(m)) return m; // plain "2 and 3"
    const ok = (x: string) => x.includes(':') || +x <= 12;
    if (!ok(a) || !ok(b)) return m;
    const hm = (x: string) => (x.includes(':') ? x : `${x}:00`);
    return ` from ${hm(a)}${ap} to ${hm(b)}${bp} `;
  });

  // "sat 7", "tomorrow 3:30", "friday 11am": a bare time right after a day word
  t = t.replace(new RegExp(`\\b(${WEEKDAY}|today|tonight|tomorrow)\\s+(${TIME}\\s*(?:[ap]m)?)(?=[\\s,]|$)`, 'gi'), '$1 at $2');
  // A time directly followed by a date ("at 9:00 Oct 20") confuses chrono; a separator makes it
  // parse them as two pieces, which are combined later. The separator is removed afterwards.
  t = t.replace(/(\bat \d{1,2}:\d{2}(?:\s*[ap]m)?|\bto \d{1,2}:\d{2}(?:\s*[ap]m)?)(?=\s+(?![ap]m\b)\S)/gi, `$1 ${SEP} `);
  return t;
}

const DURATION =
  /\s(?:for\s+(?:(an?|one|half an?|\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*(?:and\s*)?(a half|\d+)\s*(?:minutes?|mins?|m)?\b)?)|(\d+)h(\d{1,2})?m?\b|(\d+)\s?(?:min|mins)\b(?<!\bin\s+\d+\s?mins?))/i;

function takeDuration(t: string): [string, number | undefined] {
  let minutes: number | undefined;
  const out = t.replace(DURATION, (m, q, unit, extra, ch, cm, cmin) => {
    if (/\bin\s+\d+\s?mins?\b/i.test(m)) return m; // "in 30 min" is a start time, not a length
    if (ch) minutes = +ch * 60 + (cm ? +cm : 0);
    else if (cmin) minutes = +cmin;
    else {
      const n = q === 'a' || q === 'an' || q === 'one' ? 1 : /^half/i.test(q) ? 0.5 : parseFloat(q);
      minutes = n * (unit[0].toLowerCase() === 'h' ? 60 : 1);
      if (extra) minutes += extra === 'a half' ? 30 : +extra;
    }
    return ' ';
  });
  return [out, minutes];
}

/** A chrono match is trusted only if it names a day, a weekday or a time — not just a month. */
const isSpecific = (r: chrono.ParsedResult) =>
  r.start.isCertain('hour') || r.start.isCertain('day') || r.start.isCertain('weekday');

const at = (day: Date, minutes: number) => {
  const d = startOfDay(day);
  d.setMinutes(minutes);
  return d;
};

export function parseQuick(input: string, calendars: CalendarSource[], now = new Date()): Parsed {
  const [shielded, unshield] = shieldNames(fixDateTypos(input));
  const repeat = takeRepeat(shielded);
  const [afterLead, lead] = takeLead(repeat.text);
  let isDeadline = lead !== undefined || /\b(due|deadline)\b/i.test(afterLead);
  let text = normalize(afterLead, now);

  // ---- 2. calendar, duration, all-day -------------------------------------------------
  let calendarId: string | undefined;
  text = text.replace(/\s#(\w+)/g, (m, tag: string) => {
    const cal = calendars.find((c) => c.name.toLowerCase().startsWith(tag.toLowerCase()));
    if (!cal || calendarId) return m;
    calendarId = cal.id;
    return ' ';
  });
  let durMin: number | undefined;
  [text, durMin] = takeDuration(text);
  let forceAllDay = false;
  text = text.replace(/\ball[- ]day\b/i, () => ((forceAllDay = true), ' '));

  // ---- 3. dates & times ---------------------------------------------------------------
  const results = chrono.parse(text, now, { forwardDate: true }).filter(isSpecific);
  const dateRes = results.find((r) => r.start.isCertain('day') || r.start.isCertain('weekday'));
  const timeRes = results.find((r) => r.start.isCertain('hour'));
  // "finish slides by thursday": "by" right before the date makes it a deadline
  const first = [dateRes, timeRes].filter(Boolean).sort((a, b) => a!.index - b!.index)[0];
  if (first && /\bby\s*$/i.test(text.slice(0, first.index))) isDeadline = true;
  const context = text; // keep for part-of-day / morning checks before removing date words
  for (const r of [...new Set([dateRes, timeRes])].filter(Boolean).sort((a, b) => b!.index - a!.index))
    text = text.slice(0, r!.index) + ' ' + text.slice(r!.index + r!.text.length);

  // ---- 4. resolve ---------------------------------------------------------------------
  const meal = MEALS.find(([re]) => re.test(text));
  const morning = /\b(morning|breakfast)\b/i.test(context);
  let start: Date;
  let end: Date;
  let allDay = false;
  let timeFromWords = false;
  let hasEnd = durMin !== undefined;

  if (timeRes && !forceAllDay) {
    const c = timeRes.start;
    let h = c.get('hour')!;
    const m = c.get('minute') ?? 0;
    if (!c.isCertain('meridiem') && h >= 1 && h <= 7 && !morning) h += 12; // "at 7" → 7 PM
    if (dateRes && dateRes !== timeRes) start = at(dateRes.start.date(), h * 60 + m);
    else if (dateRes) start = c.isCertain('meridiem') ? c.date() : at(c.date(), h * 60 + m);
    else {
      start = at(now, h * 60 + m); // time only: today, or tomorrow if it has passed
      if (start < now) start = addDays(start, 1);
    }
    end = new Date(start.getTime() + (durMin ?? 60) * MIN);
    const e = timeRes.end;
    if (e?.isCertain('hour')) {
      hasEnd = true;
      end = at(start, e.get('hour')! * 60 + (e.get('minute') ?? 0));
      if (e.isCertain('meridiem')) { if (end <= start) end = addDays(end, 1); }
      else while (end <= start) end = new Date(end.getTime() + 12 * 60 * MIN); // "11-1" → 11 AM–1 PM
    }
  } else if (dateRes || meal) {
    const day = dateRes ? dateRes.start.date() : now;
    const part = PART_OF_DAY.find(([re]) => re.test(context));
    const minutes = part?.[1] ?? meal?.[1];
    if (minutes !== undefined && !forceAllDay) {
      timeFromWords = true;
      start = at(day, minutes);
      if (!dateRes && start < now) start = addDays(start, 1); // "lunch with Sam" after noon → tomorrow
      end = new Date(start.getTime() + (durMin ?? 60) * MIN);
    } else {
      allDay = true;
      start = startOfDay(day);
      end = addDays(startOfDay(dateRes?.end?.date() ?? day), 1);
      if (dateRes && /\bweekend\b/i.test(dateRes.text)) end = addDays(start, 2); // Sat + Sun
    }
  } else {
    start = new Date(now); // nothing said about when: the next full hour
    start.setHours(start.getHours() + 1, 0, 0, 0);
    end = new Date(start.getTime() + (durMin ?? 60) * MIN);
    if (forceAllDay) {
      allDay = true;
      start = startOfDay(now);
      end = addDays(start, 1);
    }
  }

  text = text.replace(new RegExp(`\\s*${SEP}\\s*`, 'g'), ' ');

  // ---- 4b. repeats: line the first occurrence up with the rule, work out the end ----------
  let recurrence: Recurrence | undefined;
  if (repeat.rule) {
    recurrence = { ...repeat.rule };
    const timed = !!timeRes || timeFromWords;
    if (!timed && !forceAllDay && !allDay) {
      // "gym every monday" with no time → all-day on those days
      allDay = true;
      start = startOfDay(start);
      end = addDays(start, 1);
    }
    if (recurrence.byDay && recurrence.byDay.length) {
      // First occurrence: the first matching weekday from the given date (or from today).
      const len = end.getTime() - start.getTime();
      let d = dateRes ? new Date(start) : at(now, timed ? start.getHours() * 60 + start.getMinutes() : 0);
      if (allDay) d = startOfDay(d);
      for (let k = 0; k < 8 && (!recurrence.byDay.includes(d.getDay()) || (!dateRes && timed && d < now)); k++) d = addDays(d, 1);
      start = d;
      end = new Date(d.getTime() + len);
    } else if (recurrence.freq === 'weekly') recurrence.byDay = [start.getDay()];
    if (repeat.untilText) {
      const u = chrono.parse(normalize(repeat.untilText, now), now, { forwardDate: true })[0];
      if (u) recurrence.until = addDays(startOfDay(u.start.date()), 1).getTime() - 1; // through the end of that day
    }
    if (repeat.times) {
      const n = repeat.times;
      const lastStart =
        repeat.timesUnit === 'occurrence'
          ? null
          : repeat.timesUnit === 'week' ? addDays(start, 7 * n - 1)
          : repeat.timesUnit === 'day' ? addDays(start, n - 1)
          : repeat.timesUnit === 'month' ? addDays(addMonths(start, n), -1)
          : addDays(addMonths(start, 12 * n), -1);
      if (lastStart) recurrence.until = addDays(startOfDay(lastStart), 1).getTime() - 1;
      else {
        // N occurrences: walk the rule forward.
        let d = startOfDay(start);
        let count = 0;
        for (let k = 0; k < 3700 && count < n; k++, d = addDays(d, 1)) {
          const diffDays = Math.round((d.getTime() - startOfDay(start).getTime()) / 86_400_000);
          const r = recurrence;
          const hit =
            r.freq === 'daily' ? diffDays % r.interval === 0
            : r.freq === 'weekly'
              ? r.byDay!.includes(d.getDay()) && (Math.floor(dayIndex(d) / 7) - Math.floor(dayIndex(start) / 7)) % r.interval === 0
            : r.freq === 'monthly' ? d.getDate() === start.getDate()
            : d.getDate() === start.getDate() && d.getMonth() === start.getMonth();
          if (hit && ++count === n) recurrence.until = addDays(d, 1).getTime() - 1;
        }
      }
    }
  }

  // ---- 4c. deadlines: a moment (5 PM unless a time is given), not a span ----------------------
  if (isDeadline) {
    const timed = !!timeRes || timeFromWords;
    if (!timed) {
      start = at(start, 17 * 60);
      if (!dateRes && !recurrence && start < now) start = addDays(start, 1);
    }
    end = new Date(start);
    allDay = false;
    hasEnd = false;
  }

  // ---- 5. location & title --------------------------------------------------------------
  // "at noon Friday Coffee…" leaves a stranded leading "at" once the date is gone.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/^[\s,:;\-–]*(?:on|at|from|by|this|next)\b[\s,:;\-–]*/i, ' ');
  }
  let location: string | undefined;
  const stop = String.raw`(?=\s+(?:with|about|re|regarding|to discuss|for|and)\b|\s*[,;]|\s*$)`;
  const locRes = [
    new RegExp(String.raw`\s@\s*(.+?)${stop}`),
    new RegExp(String.raw`\s(?:[Aa]t|[Ii]n)\s+((?:the\s+)?[A-Z0-9][^,;]*?)${stop}`),
    new RegExp(String.raw`\s[Aa]t\s+(home|work|the gym|the office|the lab|school|campus)${stop}`, 'i'),
  ];
  for (const re of locRes) {
    const m = text.match(re);
    if (m) {
      location = unshield(m[1].trim());
      text = text.replace(m[0], ' ');
      break;
    }
  }

  const DANGLING = /^(?:on|at|from|for|by|in|this|next|the|and|to|,)\s+|\s+(?:on|at|from|for|by|in|this|next|the|and|to|,)$/i;
  if (isDeadline) {
    // "Deadline for X" → "X"; "X due" / "X deadline" → "X" unless only one word would be left ("Tax deadline")
    text = text.replace(/^\s*(?:the\s+)?(?:deadline|due)(?:\s+(?:for|of|on|date))?\s*:?\s+/i, ' ');
    const stripped = text.replace(/\b(?:is\s+)?due(?:\s+(?:on|by|at|date))?\b|\bdeadline(?:\s+(?:for|of|on))?\b|:/gi, ' ');
    if (stripped.trim().split(/\s+/).filter((w) => !/^(on|at|by|the|for)$/i.test(w)).length >= 2) text = stripped;
  }
  let title = unshield(text).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  for (let prev = ''; prev !== title; ) {
    prev = title;
    title = title.replace(DANGLING, '').replace(/^[,:;\-–\s]+|[,:;\-–\s]+$/g, '').trim();
  }
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return {
    title,
    start: start.getTime(),
    end: end.getTime(),
    allDay,
    location,
    calendarId,
    hasDate: !!(dateRes || timeRes),
    hasDay: !!dateRes,
    hasTime: !!timeRes && !forceAllDay,
    timeFromWords,
    hasEnd,
    recurrence,
    repeatDays: repeat.byDayGiven ? repeat.rule?.byDay : undefined,
    deadline: isDeadline ? { leadDays: lead ?? (recurrence ? 2 : 14) } : undefined,
  };
}
