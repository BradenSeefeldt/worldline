// Stress test: build thousands of phrases from parts whose meaning is known, in different
// word orders and dictation styles, and check every one. A seeded random generator makes
// the run reproducible: a failure always shows up again with the same phrase.
import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { parseQuick } from './quickparse';
import { DEFAULT_CALENDARS } from '../data/mock';

const NOW = new Date(2026, 9, 7, 19, 10); // Wed Oct 7 2026, 7:10 PM

const TITLES = [
  'Coffee with Sam', 'Group meeting', 'Call Jan', 'Review flux tube paper', 'Dentist',
  'Sync w/ Alex', 'Meeting with May', 'Check cluster jobs', 'Telecon with June', 'Pick up keys',
  'Thesis committee', 'Coffee with April',
];
const DATES: [string, string][] = [
  ['tomorrow', '2026-10-08'], ['friday', '2026-10-09'], ['Friday', '2026-10-09'], ['next tuesday', '2026-10-13'],
  ['oct 20', '2026-10-20'], ['October 20th', '2026-10-20'], ['on the 15th', '2026-10-15'], ['Monday', '2026-10-12'],
  ['in 3 days', '2026-10-10'], ['10/22', '2026-10-22'], ['on Thursday', '2026-10-08'], ['nov 2', '2026-11-02'],
];
// [phrase, start "HH:mm", end "HH:mm" | null (= start + duration)]
const TIMES: [string, string, string | null][] = [
  ['at 3pm', '15:00', null], ['at 10:30am', '10:30', null], ['at 7', '19:00', null], ['at noon', '12:00', null],
  ['at 9', '09:00', null], ['from 2 to 4', '14:00', '16:00'], ['11-1', '11:00', '13:00'], ['at 4:15 p.m.', '16:15', null],
  ['3-4pm', '15:00', '16:00'], ['at 2 PM', '14:00', null], ['at half past 3', '15:30', null], ['at 1530', '15:30', null],
];
const PLACES: [string, string | undefined][] = [
  ['', undefined], ["at Fran's", "Fran's"], ['in MP 1318', 'MP 1318'], ['@ the lab', 'the lab'], ['at the Fields Institute', 'the Fields Institute'],
];
const DURATIONS: [string, number | undefined][] = [['', undefined], ['for 2h', 120], ['for 45 min', 45], ['for half an hour', 30]];
const WRAPPERS: ((s: string) => string)[] = [
  (s) => s,
  (s) => `${s}.`,
  (s) => `Schedule ${s[0].toLowerCase()}${s.slice(1)}.`,
  (s) => s.toLowerCase().replace(/\b(mp|fran's|fields|institute|alex|sam|jan|may|june|april)\b/g, (w) => w), // all lowercase typing
];

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** One realistic typo in the first long date word: swapped, doubled or dropped letter. */
function misspell(phrase: string, r: () => number) {
  return phrase.replace(/\b(tomorrow|friday|tuesday|monday|thursday|october)\b/i, (w) => {
    const i = 1 + Math.floor(r() * (w.length - 2));
    const op = Math.floor(r() * 3);
    if (op === 0) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); // swap
    if (op === 1) return w.slice(0, i) + w[i] + w.slice(i); // double
    return w.length >= 8 ? w.slice(0, i) + w.slice(i + 1) : w.slice(0, i) + w[i] + w.slice(i); // drop (long words)
  });
}

interface Case { input: string; title: string; start: string; end: string; loc?: string }

function makeCases(n: number, seed: number): Case[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out: Case[] = [];
  for (let k = 0; k < n; k++) {
    const title = pick(TITLES);
    const [dp0, day] = pick(DATES);
    const dp = r() < 0.33 ? misspell(dp0, r) : dp0;
    const [tp, t0, t1] = pick(TIMES);
    const [pp, loc] = pick(PLACES);
    const [durp, dur] = t1 ? ['', undefined] : pick(DURATIONS); // a range already sets the end
    const wrap = pick(WRAPPERS);
    const lower = wrap === WRAPPERS[3];
    const order = Math.floor(r() * 4);
    const parts = [
      [title, pp, dp, tp, durp],
      [title, dp, tp, pp, durp],
      [dp, tp, title, pp, durp],
      [tp, dp, title, durp, pp],
    ][order];
    const input = wrap(parts.filter(Boolean).join(' '));
    // Lowercase typing loses capitals: only "@" and known places are still recognisable as places.
    const keepsLoc = !lower || pp.startsWith('@');
    const start = `${day} ${t0}`;
    const startMs = new Date(`${day}T${t0}`).getTime();
    const end = t1 ? `${day} ${t1}` : format(startMs + (dur ?? 60) * 60_000, 'yyyy-MM-dd HH:mm');
    if (!keepsLoc) continue; // ambiguous by design ("at fran's" lowercase); skip
    out.push({ input, title: lower ? title[0] + title.slice(1).toLowerCase() : title, start, end, loc: lower ? loc?.toLowerCase() : loc });
  }
  return out;
}

describe('parseQuick — combinatorial stress test', () => {
  it.each([42, 7, 2026, 31337])('seed %i: every generated phrase is right', (seed) => {
    const CASES = makeCases(4000, seed);
    const failures: string[] = [];
    for (const c of CASES) {
      const r = parseQuick(c.input, DEFAULT_CALENDARS, NOW);
      const got = {
        title: r.title,
        start: format(r.start, 'yyyy-MM-dd HH:mm'),
        end: format(r.end, 'yyyy-MM-dd HH:mm'),
        loc: r.location,
      };
      const want = { title: c.title, start: c.start, end: c.end, loc: c.loc };
      if (JSON.stringify(got) !== JSON.stringify(want))
        failures.push(`${c.input}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
    }
    if (failures.length) console.log(`${failures.length} failures\n` + failures.slice(0, 40).join('\n'));
    expect(failures.length).toBe(0);
  });
});
