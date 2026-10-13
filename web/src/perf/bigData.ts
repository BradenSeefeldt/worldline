// A realistic, deterministic "ten years of use" dataset for the performance tests (perf.test.ts).
// Same seed + same `now` → byte-identical state. Shapes are the app's real ones (data/types.ts, lib/projects.ts,
// lib/habits.ts, lib/tasks.ts, lib/booking.ts); subscription calendars come from a generated .ics feed read by the
// app's own parser (lib/ics.ts), all-day events are stored through encodeEvent, Mac-calendar events carry `ext` and a
// `macKnown` fingerprint as data/macCalendars.ts leaves them.
//
// Rough shape (defaults): ~31k events — 2 subscriptions × ~5k, ~5k Mac-calendar occurrences, ~13k one-offs over ten
// years, 200 repeating series with skipped days and ~1k edited occurrences, ~1k all-day / multi-day, 300 deadlines and
// 300 blocks of time made for tasks; 20 habits with daily history; 60 projects + 440 threads (long pages: headings,
// lists, to-dos, code blocks, equations) + ~3k dated notes; 5k tasks; 30 scheduling links with bookings and decisions.
import type { CalEvent, CalendarSource } from '../data/types';
import type { Habit, HabitLog, HabitNotes } from '../lib/habits';
import type { DocNode, LogEntry, Project, Thread } from '../lib/projects';
import type { Task } from '../lib/tasks';
import type { BookingLink } from '../lib/booking';
import type { Skip } from '../lib/suggest';
import { encodeEvent } from '../lib/recurrence';
import { encodeDay } from '../lib/zone';
import { dayOf } from '../lib/habits';
import { parseIcs } from '../lib/ics';
import { fingerprint, keyOf } from '../lib/macCalendars';

const DAY = 86_400_000;
const MIN = 60_000;

/** mulberry32: a small, fast, seedable PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    hex: (n: number) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(''),
  };
}
type R = ReturnType<typeof rng>;

const WORDS = ('the experiment measurement signal sample data set instrument calibration model prediction theory effect ' +
  'temperature density spectrum resolution grid checkpoint server node restart output analysis figure paper draft ' +
  'referee comment section method result discussion appendix error bar fit model parameter sample survey archive ' +
  'time series event rate timescale variability noise baseline control trial group comparison estimate uncertainty ' +
  'review student course lecture grant budget meeting image frame pipeline script python julia notebook plot histogram').split(' ');
const NAMES = ['Alex', 'Sam', 'Jordan', 'Kai', 'Robin', 'Morgan', 'Taylor', 'Priya', 'Lena', 'Omar'];
const sentence = (r: R, n = r.int(8, 22)) => {
  const w = Array.from({ length: n }, () => r.pick(WORDS));
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return w.join(' ') + '.';
};

// ---------------------------------------------------------------- documents (ProseMirror JSON, as TipTap saves it)
const text = (t: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });
const para = (...c: DocNode[]): DocNode => ({ type: 'paragraph', ...(c.length ? { content: c } : {}) });
const heading = (level: number, t: string): DocNode => ({ type: 'heading', attrs: { level }, content: [text(t)] });
const CODE = [
  ['python', 'import numpy as np\nimport h5py\n\ndef load(path, field="b2"):\n    with h5py.File(path) as f:\n        return np.asarray(f[field])\n\nfor step in range(0, 5000, 500):\n    b2 = load(f"out/data{step:05d}.h5")\n    print(step, b2.mean(), b2.max())\n'],
  ['bash', '#!/bin/bash\n#SBATCH --nodes=64\n#SBATCH --time=24:00:00\nmodule load hdf5/1.14 openmpi\nsrun ./model -i params.par --resume checkpoint_0042.dat\n'],
  ['julia', 'using Statistics\nfunction waiting_times(t::Vector{Float64})\n    dt = diff(sort(t))\n    return mean(dt), std(dt)\nend\n'],
  ['cpp', '#include <cmath>\ndouble lorentz(double v2) { return 1.0 / std::sqrt(1.0 - v2); }\n'],
] as const;
const codeBlock = (r: R): DocNode => {
  const [language, src] = r.pick(CODE);
  return { type: 'codeBlock', attrs: { language }, content: [text(src.repeat(r.int(1, 3)))] };
};
const todo = (r: R, checked: boolean, nested?: DocNode): DocNode => ({
  type: 'taskItem', attrs: { checked },
  content: [para(text(sentence(r, r.int(3, 8)).slice(0, -1) + (r.chance(0.15) ? ` @${r.pick(NAMES)}` : ''))), ...(nested ? [nested] : [])],
});
const taskList = (r: R, n: number): DocNode => ({ type: 'taskList', content: Array.from({ length: n }, () => todo(r, r.chance(0.6), r.chance(0.2) ? { type: 'taskList', content: [todo(r, false)] } : undefined)) });
const bullets = (r: R, n: number): DocNode => ({ type: 'bulletList', content: Array.from({ length: n }, () => ({ type: 'listItem', content: [para(text(sentence(r)))] })) });
const richPara = (r: R): DocNode => {
  const k = r.next();
  if (k < 0.1) return para(text('Idea: ' + sentence(r)));
  if (k < 0.18) return para(text('Q: ' + sentence(r)), ...(r.chance(0.3) ? [] : []));
  if (k < 0.24) return para(text('Decided: ' + sentence(r)));
  if (k < 0.34) return para(text(sentence(r) + ' With '), { type: 'inlineMath', attrs: { latex: '\\bar x = \\frac{1}{N}\\sum_i x_i' } }, text(' ' + sentence(r)));
  if (k < 0.44) return para(text(sentence(r) + ' '), text(r.pick(WORDS), [{ type: 'bold' }]), text(' see '), text('~/runs/big', [{ type: 'code' }]), text('.'));
  return para(text(Array.from({ length: r.int(1, 4) }, () => sentence(r)).join(' ')));
};
/** A page of roughly `kb` kilobytes of JSON. */
export function page(r: R, kb: number): DocNode {
  const content: DocNode[] = [];
  let size = 0;
  while (size < kb * 1024) {
    const k = r.next();
    const b = k < 0.08 ? heading(r.int(2, 3), sentence(r, 4).slice(0, -1)) : k < 0.18 ? taskList(r, r.int(2, 6)) : k < 0.25 ? bullets(r, r.int(2, 5)) : k < 0.31 ? codeBlock(r) : k < 0.34 ? { type: 'blockMath', attrs: { latex: '\\chi^2 = \\sum_i \\frac{(y_i - f(x_i))^2}{\\sigma_i^2}' } } : richPara(r);
    content.push(b);
    size += JSON.stringify(b).length;
  }
  return { type: 'doc', content };
}

// ---------------------------------------------------------------- subscription feeds
const pad = (n: number) => String(n).padStart(2, '0');
const icsUtc = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsDate = (t: number) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; };
/** A department-style .ics feed: an absolute timeline of events (seminars, talks, holidays) plus weekly series, the
 *  same on every fetch except that `week` advances and ~1% of titles change (an edited title = a new id here). The
 *  app's parser keeps one year back and two ahead of `now`. */
export function feedIcs(name: string, seed: number, now: number, week = 0): string {
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//perf//EN', `X-WR-CALNAME:${name}`, 'X-WR-TIMEZONE:America/Toronto'];
  const anchor = Date.UTC(2015, 0, 5, 14); // the feed's timeline starts here (absolute: independent of `now`)
  const from = now - 370 * DAY, to = now + 735 * DAY;
  const perDay = 2.9;
  const k0 = Math.max(0, Math.floor(((from - anchor) / DAY) * perDay)), k1 = Math.ceil(((to - anchor) / DAY) * perDay);
  for (let k = k0; k <= k1; k++) {
    const r = rng(seed * 1_000_003 + k);
    const start = anchor + Math.floor(k / perDay) * DAY + r.int(0, 8) * 30 * MIN;
    const allDay = r.chance(0.04);
    const renamed = (k * 7 + week) % 97 === 0 ? ' (room change)' : '';
    out.push('BEGIN:VEVENT', `UID:${name.replace(/\W/g, '')}-${k}@feed`, `DTSTAMP:${icsUtc(anchor)}`);
    if (allDay) out.push(`DTSTART;VALUE=DATE:${icsDate(start)}`, `DTEND;VALUE=DATE:${icsDate(start + DAY)}`);
    else out.push(`DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(start + r.int(1, 4) * 30 * MIN)}`);
    out.push(`SUMMARY:${r.pick(['Seminar', 'Colloquium', 'Journal club', 'Lunch talk', 'Thesis defence', 'Group meeting'])}: ${sentence(r, 5).slice(0, -1)}${renamed}`);
    if (r.chance(0.6)) out.push(`LOCATION:MP ${r.int(100, 1500)}`);
    if (r.chance(0.3)) out.push(`DESCRIPTION:${sentence(r, 30)}`);
    out.push('END:VEVENT');
  }
  for (let s = 0; s < 12; s++) {
    const r = rng(seed * 7 + s);
    const start = anchor + r.int(0, 6) * DAY + r.int(18, 34) * 30 * MIN;
    out.push('BEGIN:VEVENT', `UID:${name.replace(/\W/g, '')}-series-${s}@feed`, `DTSTAMP:${icsUtc(anchor)}`, `DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(start + 60 * MIN)}`,
      'RRULE:FREQ=WEEKLY;INTERVAL=1', `SUMMARY:Weekly ${sentence(r, 3).slice(0, -1)}`, 'END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}
export const feedWindow = (now: number) => ({ from: now - 365 * DAY, to: now + 2 * 365 * DAY }); // as store.ts refreshCalendar

// ---------------------------------------------------------------- the whole state
export interface BigOptions {
  now: number;
  seed?: number;
  years?: number;
  localEvents?: number;
  macEvents?: number;
  series?: number;
  habits?: number;
  projects?: number;
  threads?: number;
  logEntries?: number;
  tasks?: number;
  links?: number;
}

export const SUBS = [
  { id: 'sub-dept', name: 'Department events', seed: 11 },
  { id: 'sub-astro', name: 'Astro seminars', seed: 23 },
] as const;
export const MAC_CALS = ['mac:ICLOUD-HOME', 'mac:GOOGLE-WORK'] as const;

export function bigState(o: BigOptions) {
  const r = rng(o.seed ?? 42);
  const now = o.now;
  const years = o.years ?? 10;
  const t0 = now - years * 365 * DAY;
  const span = (now + 365 * DAY) - t0; // events reach a year ahead
  let n = 0;
  const id = (p: string) => `${p}${(n++).toString(36)}${r.hex(4)}`;
  const at = (t: number, h: number, m = 0) => { const d = new Date(t); d.setHours(h, m, 0, 0); return d.getTime(); };
  const midnight = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  const calendars: CalendarSource[] = [
    { id: 'personal', name: 'Personal', color: '#20b26b', visible: true, account: 'Local' },
    { id: 'research', name: 'Research', color: '#2f7cf6', visible: true, account: 'Local' },
    { id: 'teaching', name: 'Teaching', color: '#8e5cf7', visible: true, account: 'Local' },
    { id: 'social', name: 'Social', color: '#f29a1d', visible: true, account: 'Local' },
    { id: 'travel', name: 'Travel', color: '#14a8b8', visible: false, account: 'Local' },
    ...SUBS.map((s, i) => ({ id: s.id, name: s.name, color: i ? '#ef4b4b' : '#7a8a99', visible: true, account: 'Subscribed', url: `https://example.invalid/${s.id}.ics`, lastSync: now })),
    ...MAC_CALS.map((c, i) => ({ id: c, name: i ? 'Work (Google)' : 'Home (iCloud)', color: i ? '#5b6ef0' : '#e45db0', visible: true, account: i ? 'Google' : 'iCloud', mac: { id: c.slice(4), host: 'host-abc', writable: true } })),
  ];
  const events: CalEvent[] = [];
  const local = ['personal', 'research', 'teaching', 'social'];
  const TITLES = ['Gym', 'Run', 'Piano practice', 'Meditation', 'Read', 'Meeting with Morgan', 'Meeting with Taylor', 'Group meeting', 'Lunch with Sam', 'Telecon', 'Office hours', 'Lecture', 'Dentist', 'Climbing', 'Coffee with Priya', 'Write paper', 'Code review', 'Seminar prep', 'Call home', 'Groceries'];

  // one-offs, over the whole span
  const nLocal = o.localEvents ?? 13_000;
  for (let i = 0; i < nLocal; i++) {
    const t = t0 + Math.floor((i / nLocal) * span);
    const h = r.int(7, 20), m = r.pick([0, 15, 30, 45]);
    const start = at(t, h, m);
    const ev: CalEvent = { id: id('e'), calendarId: r.pick(local), title: r.pick(TITLES), start, end: start + r.int(1, 6) * 15 * MIN, allDay: false, createdAt: start - r.int(1, 30) * DAY };
    if (r.chance(0.3)) ev.location = `Room ${r.int(100, 1600)}`;
    if (r.chance(0.15)) ev.notes = sentence(r, r.int(10, 60));
    if (r.chance(0.05)) ev.alert = r.pick([0, 5, 10, 60, null]);
    events.push(ev);
  }
  // all-day and multi-day
  for (let i = 0; i < 1000; i++) {
    const d0 = midnight(t0 + Math.floor(r.next() * span));
    const days = i % 5 === 0 ? r.int(2, 14) : 1;
    events.push(encodeEvent({ id: id('a'), calendarId: i % 5 === 0 ? 'travel' : r.pick(local), title: i % 5 === 0 ? `Trip: ${r.pick(['Berkeley', 'Leiden', 'Garching', 'Princeton', 'Kyoto'])}` : r.pick(['Birthday', 'Holiday', 'Conference', 'Deadline week', 'Visit']), start: d0, end: midnight(d0 + days * DAY + 3 * 3_600_000), allDay: true, createdAt: d0 - 10 * DAY }));
  }
  // repeating series with skipped days and edited occurrences
  const nSeries = o.series ?? 200;
  for (let i = 0; i < nSeries; i++) {
    const begin = at(t0 + Math.floor(r.next() * (span - 400 * DAY)), r.int(8, 17));
    const freq = r.pick(['weekly', 'weekly', 'weekly', 'daily', 'monthly', 'yearly'] as const);
    const step = freq === 'daily' ? DAY : freq === 'weekly' ? 7 * DAY : freq === 'monthly' ? 30 * DAY : 365 * DAY;
    const ends = r.chance(0.7) ? begin + r.int(10, 150) * step : undefined;
    const master: CalEvent = {
      id: id('s'), calendarId: r.pick(local), title: r.pick(['Journal club', 'Group meeting', 'Gym', 'Piano practice', 'Meditation', '1:1 with Kai', 'Reading group', 'Run']), start: begin, end: begin + 60 * MIN, allDay: false,
      recurrence: { freq, interval: freq === 'weekly' && r.chance(0.2) ? 2 : 1, ...(freq === 'weekly' && r.chance(0.3) ? { byDay: [1, 3] } : {}), ...(ends ? { until: ends } : {}) },
      timeZone: 'America/Toronto', createdAt: begin - DAY,
    };
    // skipped and edited occurrences: keys are the occurrence's start (timed series in its zone; DST makes a few
    // approximate, which only means some exdates don't match an occurrence — still stored, still costs)
    const nEx = r.int(0, 25);
    const ex: number[] = [];
    for (let k = 0; k < nEx; k++) {
      const occ = begin + r.int(1, 100) * step;
      ex.push(occ);
      if (k % 3 === 0) events.push({ id: id('x'), calendarId: master.calendarId, title: master.title + ' (moved)', start: occ + 2 * 3_600_000, end: occ + 3 * 3_600_000, allDay: false, seriesId: master.id, originalStart: occ, createdAt: occ - DAY });
    }
    if (ex.length) master.exdates = ex;
    events.push(master);
  }
  // Mac-calendar events: occurrences (a repeating one on the Mac is one event per occurrence here), tied by `ext`
  const macKnown: Record<string, string> = {};
  const nMac = o.macEvents ?? 5_000;
  for (let i = 0; i < nMac; i++) {
    const t = t0 + Math.floor((i / nMac) * span);
    const start = at(t, r.int(8, 19), r.pick([0, 30]));
    const recurring = r.chance(0.4);
    const ext = { id: `${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}`.toUpperCase(), occ: recurring ? start : 0, ...(recurring ? { recurring: true } : {}) };
    const ev: CalEvent = { id: `mac-${r.hex(8)}`, calendarId: r.pick(MAC_CALS), title: r.pick(['Standup', 'Family dinner', 'Doctor', 'Haircut', 'Call with Mom', 'Flight', 'Interview', 'Webinar']), start, end: start + r.int(1, 4) * 30 * MIN, allDay: false, ext };
    if (r.chance(0.4)) ev.location = `${r.int(1, 999)} ${r.pick(['Bloor St', 'College St', 'Spadina Ave'])}`;
    if (r.chance(0.2)) ev.notes = sentence(r, r.int(10, 80));
    events.push(ev);
    macKnown[keyOf(ext)] = fingerprint(ev);
  }
  // subscriptions, as the app's parser makes them from the feed
  for (const s of SUBS) {
    const w = feedWindow(now);
    events.push(...parseIcs(feedIcs(s.name, s.seed, now), s.id, w.from, w.to).events.map(encodeEvent));
  }

  // tasks, deadlines with checklists, and blocks of time made for them
  const tasks: Task[] = [];
  const deadlines: CalEvent[] = [];
  for (let i = 0; i < 300; i++) {
    const due = at(t0 + Math.floor(((i + 0.5) / 300) * span), 17);
    deadlines.push({ id: id('d'), calendarId: 'research', title: `Due: ${sentence(r, 4).slice(0, -1)}`, start: due, end: due, allDay: false, kind: 'deadline', leadDays: r.pick([7, 14, 21, 30]), done: due < now - 7 * DAY ? true : r.chance(0.2), createdAt: due - 40 * DAY });
  }
  events.push(...deadlines);
  const nTasks = o.tasks ?? 5_000;
  for (let i = 0; i < nTasks; i++) {
    const created = t0 + Math.floor((i / nTasks) * span * 0.92);
    const t: Task = { id: `t-${id('')}`, title: sentence(r, r.int(3, 9)).slice(0, -1), createdAt: created };
    if (r.chance(0.35)) t.due = encodeDay(midnight(created + r.int(0, 30) * DAY));
    if (i % 8 === 0) t.parentId = deadlines[Math.min(deadlines.length - 1, Math.floor((i / nTasks) * deadlines.length))].id;
    if (created < now - 30 * DAY ? r.chance(0.97) : r.chance(0.3)) {
      t.done = true;
      t.doneAt = created + r.int(0, 20) * DAY;
    }
    tasks.push(t);
  }
  for (let i = 0; i < 300; i++) {
    const tk = tasks[r.int(0, tasks.length - 1)];
    const start = at(tk.createdAt + r.int(0, 5) * DAY, r.int(9, 16));
    events.push({ id: id('b'), calendarId: 'research', title: tk.title, start, end: start + 3_600_000, allDay: false, linkedTo: tk.id, createdAt: start - DAY });
  }

  // habits with ten years of history
  const habits: Habit[] = [];
  const habitLog: HabitLog = {};
  const habitNotes: HabitNotes = {};
  const H: [string, Habit['kind'], number, Habit['period'], string?, string?][] = [
    ['Gym', 'check', 3, 'week', undefined, 'gym'], ['Run', 'count', 20, 'week', 'km'], ['Read', 'count', 20, 'day', 'pages'], ['Meditate', 'check', 1, 'day', undefined, 'meditation'],
    ['Piano', 'count', 30, 'day', 'min', 'piano'], ['No phone in bed', 'avoid', 0, 'day'], ['Write', 'count', 500, 'day', 'words'], ['Stretch', 'check', 1, 'day'],
    ['Climb', 'check', 1, 'week', undefined, 'climbing'], ['Journal', 'check', 1, 'day'], ['Vitamins', 'check', 1, 'day'], ['Language', 'count', 15, 'day', 'min'],
    ['Walk', 'count', 8000, 'day', 'steps'], ['Code', 'count', 2, 'day', 'h', 'code review'], ['Floss', 'check', 1, 'day'], ['No sugar', 'avoid', 1, 'week'],
    ['Call family', 'check', 1, 'week', undefined, 'call home'], ['Cook', 'check', 4, 'week'], ['Sleep by 11', 'check', 1, 'day'], ['Inbox zero', 'check', 1, 'day'],
  ];
  const today = dayOf(now);
  H.slice(0, o.habits ?? 20).forEach(([title, kind, goal, period, unit, match], i) => {
    const createdAt = t0 + i * 20 * DAY;
    const h: Habit = { id: `h-${i}`, title, color: '#2f7cf6', kind, goal, period, createdAt, ...(unit ? { unit } : {}), ...(match ? { match } : {}), ...(i === 17 ? { archived: true } : {}) };
    habits.push(h);
    const log: Record<number, number> = {};
    for (let d = dayOf(createdAt); d <= today; d++) {
      const x = r.next();
      if (x < 0.03) log[d] = -1; // rest day
      else if (kind === 'avoid') { if (x < 0.1) log[d] = 1; }
      else if (x < 0.7) log[d] = kind === 'check' ? 1 : Math.max(1, Math.round(goal * (0.5 + r.next())));
    }
    habitLog[h.id] = log;
    const notes: Record<number, string> = {};
    for (let k = 0; k < 100; k++) notes[dayOf(createdAt) + r.int(0, today - dayOf(createdAt))] = sentence(r, r.int(4, 20));
    habitNotes[h.id] = notes;
  });

  // projects, threads, notes
  const projects: Project[] = [];
  const threads: Thread[] = [];
  const projectLog: LogEntry[] = [];
  const nP = o.projects ?? 60, nT = o.threads ?? 440, nL = o.logEntries ?? 3_000;
  for (let i = 0; i < nP; i++) {
    const createdAt = t0 + Math.floor((i / nP) * span * 0.9);
    projects.push({
      id: id('p'), title: `${r.pick(['Main study', 'Review', 'Instrument', 'Software', 'Teaching', 'Hiring', 'Side project', 'Grant'])} ${i}`, color: '#2f7cf6', createdAt,
      about: sentence(r, 12), doc: page(r, r.int(1, 4)), archived: createdAt < now - 4 * 365 * DAY && r.chance(0.6),
      pins: Array.from({ length: r.int(0, 4) }, (_, k) => ({ id: id('pin'), label: `Pin ${k}`, href: r.chance(0.5) ? 'https://github.com/x/y' : '~/runs/big' })),
      ideas: Array.from({ length: r.int(0, 8) }, () => ({ id: id('i'), text: sentence(r), at: createdAt + r.int(0, 300) * DAY })),
    });
  }
  for (let i = 0; i < nT; i++) {
    const p = projects[Math.floor((i / nT) * nP)];
    const createdAt = p.createdAt + r.int(0, 200) * DAY;
    const done = createdAt < now - 120 * DAY && r.chance(0.75);
    threads.push({ id: id('th'), projectId: p.id, title: sentence(r, r.int(3, 7)).slice(0, -1), status: done ? 'done' : 'active', body: page(r, r.int(2, 10)), createdAt, updatedAt: Math.min(now, createdAt + r.int(0, 300) * DAY), ...(done ? { doneAt: createdAt + r.int(30, 300) * DAY } : {}) });
  }
  for (let i = 0; i < nL; i++) {
    const parent = r.chance(0.8) ? threads[r.int(0, threads.length - 1)] : projects[r.int(0, projects.length - 1)];
    projectLog.push({ id: id('l'), parentId: parent.id, at: Math.min(now, parent.createdAt + r.int(0, 400) * DAY), doc: page(r, r.next() < 0.8 ? 0.6 : 3) });
  }

  // scheduling links (most finished), with bookings and the app's decisions
  const links: BookingLink[] = [];
  for (let i = 0; i < (o.links ?? 30); i++) {
    const createdAt = t0 + Math.floor((i / 30) * span * 0.95);
    const first = dayOf(createdAt);
    const mode = i % 4 === 0 ? 'poll' : 'book';
    const decisions: NonNullable<BookingLink['decisions']> = {};
    const bookings: BookingLink['bookings'] = [];
    for (let k = 0; k < r.int(5, 120); k++) {
      const start = at(createdAt + r.int(1, 14) * DAY, r.int(9, 16));
      const pk = r.hex(64);
      const ok = r.chance(0.5);
      decisions[pk] = { id: r.hex(64), status: ok ? 'ok' : r.pick(['taken', 'busy', 'invalid'] as const), start, at: start - DAY };
      if (ok) bookings.push({ id: r.hex(16), name: r.pick(NAMES), start, end: start + 30 * MIN, createdAt: start - DAY, guestKey: pk });
    }
    links.push({
      id: r.hex(8), mode, title: `Meeting ${i}`, hostName: 'Braden', durationMin: 30, days: Array.from({ length: 10 }, (_, k) => first + k), firstDay: first, lastDay: first + 14, weekdays: [1, 2, 3, 4, 5],
      windowStart: 540, windowEnd: 1020, timeZone: 'America/Toronto', blockingCalendars: ['personal', 'research'], calendarId: 'research', bufferMin: 0, noticeMin: 60, createdAt,
      singleUse: mode === 'book' && r.chance(0.5), closed: createdAt < now - 60 * DAY, bookings, decisions,
      nostr: { sk: r.hex(64), secret: r.hex(64), lastPub: Math.floor(createdAt / 1000) },
      responses: mode === 'poll' ? Array.from({ length: r.int(2, 12) }, () => ({ id: r.hex(16), name: r.pick(NAMES), cells: Array.from({ length: r.int(4, 40) }, () => at(createdAt + r.int(1, 10) * DAY, r.int(9, 16))), updatedAt: createdAt })) : [],
    });
  }

  const skipped: Skip[] = Array.from({ length: 200 }, () => ({ key: r.pick(['gym', 'group', 'journal club']), at: now - r.int(1, 2000) * DAY }));
  const dismissed = Array.from({ length: 300 }, (_, i) => `add|gym|2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}`);

  return {
    calendars, events, tasks, habits, habitLog, habitNotes, projects, threads, projectLog, links, macKnown, skipped, dismissed,
    defaultCalendarId: 'personal', myName: 'Braden', homeZone: 'America/Toronto',
  };
}
export type BigState = ReturnType<typeof bigState>;
