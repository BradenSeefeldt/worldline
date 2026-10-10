// Demo data for development and the tests (an example researcher's week). The app itself starts empty.
import { addDays, startOfDay, startOfWeek } from 'date-fns';
import type { CalEvent, CalendarSource } from './types';
import type { Task } from '../lib/tasks';
import { encodeDay } from '../lib/zone';
import { SKIP, dayOf, type Habit, type HabitLog } from '../lib/habits';
import type { DocNode, LogEntry, Project, Thread } from '../lib/projects';

export const DEFAULT_CALENDARS: CalendarSource[] = [
  { id: 'research', name: 'Research', color: '#2f7cf6', visible: true, account: 'Demo' },
  { id: 'dept', name: 'Department', color: '#8e5cf7', visible: true, account: 'Demo' },
  { id: 'personal', name: 'Personal', color: '#20b26b', visible: true, account: 'Demo' },
  { id: 'social', name: 'Social', color: '#f29a1d', visible: true, account: 'Demo' },
  { id: 'holidays', name: 'Holidays', color: '#ef4b4b', visible: true, account: 'Demo' },
];

export function makeDemoEvents(now = new Date()): CalEvent[] {
  const events: CalEvent[] = [];
  let n = 0;
  const at = (day: Date, h: number, m = 0) => {
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const add = (calendarId: string, title: string, start: number, end: number, extra: Partial<CalEvent> = {}) =>
    events.push({ id: `demo-${n++}`, calendarId, title, start, end, allDay: false, ...extra });
  const allDay = (calendarId: string, title: string, first: Date, days: number) =>
    add(calendarId, title, startOfDay(first).getTime(), addDays(startOfDay(first), days).getTime(), { allDay: true });

  const wk0 = startOfWeek(now, { weekStartsOn: 1 });
  for (let w = -8; w <= 12; w++) {
    const mon = addDays(wk0, w * 7);
    const day = (k: number) => addDays(mon, k);
    add('research', 'Group meeting', at(mon, 10), at(mon, 11), { location: 'Room 1403' });
    add('dept', 'Dept lunch talk', at(day(1), 12), at(day(1), 13), { location: 'MP 1318' });
    add('dept', 'Dept lunch talk', at(day(3), 12), at(day(3), 13), { location: 'MP 1318' });
    if (w % 2 === 0) add('research', 'Jordan — survey paper', at(day(2), 14), at(day(2), 15));
    add('personal', 'Gym', at(mon, 18), at(mon, 19, 30));
    add('personal', 'Gym', at(day(3), 7, 30), at(day(3), 8, 30));
    if (w % 3 === 0) add('social', 'Climbing', at(day(5), 14), at(day(5), 17), { location: 'Basecamp' });
    // A regular 1:1 that hasn't been put on the calendar yet this week (suggestions will notice)
    if (w < 0) add('research', 'Meeting with Alex', at(day(3), 15), at(day(3), 16));
  }

  // A real repeating series (stored once, shown every Friday)
  add('dept', 'Journal club', at(addDays(wk0, -8 * 7 + 4), 11), at(addDays(wk0, -8 * 7 + 4), 12), {
    recurrence: { freq: 'weekly', interval: 1, byDay: [5] },
  });

  // A busy afternoon today, to show side-by-side overlap layout
  const today = startOfDay(now);
  add('research', 'Check the overnight run', at(today, 9), at(today, 9, 30));
  add('social', 'Coffee chat', at(today, 14), at(today, 14, 30));
  add('research', 'Postdoc interview prep', at(today, 14, 30), at(today, 16));
  // A clash tomorrow afternoon
  add('research', 'Telecon with Sasha', at(addDays(today, 1), 15), at(addDays(today, 1), 15, 30));
  add('research', 'Grant call', at(addDays(today, 1), 15, 15), at(addDays(today, 1), 16));
  add('personal', 'Dentist', at(addDays(today, 6), 9), at(addDays(today, 6), 10), { location: 'Bloor St' });
  // Overnight event split across two days
  add('research', 'Render frames (cluster)', at(addDays(today, 2), 22), at(addDays(today, 3), 2));

  // All-day and multi-day
  // Deadlines: a due moment (5 PM by default) with a runway of work before it
  const due = (title: string, day: Date, h = 17, leadDays?: number) => {
    const t = at(day, h);
    add('', title, t, t, { kind: 'deadline', ...(leadDays ? { leadDays } : {}) }); // deadlines have no calendar
  };
  due('Thesis chapter 4', addDays(today, 9));
  due('Conference abstract', addDays(today, 3), 12);
  due('Grant proposal', addDays(today, 41), 17, 21);
  events[events.length - 1].id = 'demo-grant'; // checklist steps below point at it
  due('Referee report', addDays(today, -1));
  allDay('research', 'Simulation workshop', addDays(wk0, 15), 3);
  allDay('social', 'Cottage weekend', addDays(wk0, 11), 3);
  allDay('personal', 'Mom’s birthday', addDays(today, 3), 1);

  // Canadian Thanksgiving: second Monday of October
  const oct1 = new Date(now.getFullYear(), 9, 1);
  const firstMon = addDays(oct1, (8 - oct1.getDay()) % 7);
  allDay('holidays', 'Thanksgiving', addDays(firstMon, 7), 1);

  return events;
}

export function makeDemoTasks(now = new Date()): Task[] {
  const today = startOfDay(now);
  let n = 0;
  const t = (title: string, dueIn?: number, extra: Partial<Task> = {}): Task => ({
    id: `demo-task-${n++}`,
    title,
    createdAt: now.getTime() - (20 - n) * 60_000,
    ...(dueIn !== undefined ? { due: encodeDay(addDays(today, dueIn).getTime()) } : {}),
    ...extra,
  });
  return [
    t('Email Jordan the plots', 0),
    t('Book flight to the workshop', -3),
    t('Pay rent', 2),
    t('Renew library books', 5),
    t('Buy coffee filters'),
    t('Look into the restart flags'),
    t('Reply to Sasha about telecon slides'),
    t('Submit expense report', 0, { done: true, doneAt: now.getTime() - 3_600_000 }),
    t('Grant budget', 20, { parentId: 'demo-grant' }),
    t('Grant CV', 27, { parentId: 'demo-grant' }),
    t('Grant letters of support', undefined, { parentId: 'demo-grant' }),
    t('Grant draft to Alex', 34, { parentId: 'demo-grant', done: true, doneAt: now.getTime() - 86_400_000 }),
  ];
}

/** Three habits with years of made-up (repeatable) history, so the Habits page has something to show. */
export const DEMO_HABIT_IDS = ['demo-gym', 'demo-read', 'demo-meditate'];
export function makeDemoHabits(now = new Date()): { habits: Habit[]; habitLog: HabitLog } {
  const today = dayOf(now.getTime());
  const ago = (days: number) => addDays(startOfDay(now), -days).getTime();
  const habits: Habit[] = [
    { id: 'demo-gym', title: 'Gym', color: '#20b26b', kind: 'check', goal: 3, period: 'week', match: 'gym', createdAt: new Date(2024, 0, 3).getTime() },
    { id: 'demo-read', title: 'Read', color: '#2f7cf6', kind: 'count', goal: 20, period: 'day', unit: 'pages', createdAt: new Date(2024, 8, 1).getTime() },
    { id: 'demo-meditate', title: 'Meditate', color: '#8e5cf7', kind: 'check', goal: 1, period: 'day', createdAt: ago(120) },
  ];
  // A tiny repeatable "random" so the history looks lived-in but is the same every time.
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const habitLog: HabitLog = { 'demo-gym': {}, 'demo-read': {}, 'demo-meditate': {} };
  for (let d = dayOf(habits[0].createdAt); d < today; d++) {
    const date = new Date(d * 86_400_000 + 43_200_000);
    const month = date.getUTCMonth();
    const years = (today - d) / 365;
    // Gym: keen every January, slack in summer, steadier each year.
    const keen = (month === 0 ? 0.25 : month >= 5 && month <= 7 ? -0.2 : 0) + 0.12 * (2.5 - years);
    if ((d + 3) % 7 < 5 && rnd() < 0.5 + keen) habitLog['demo-gym'][d] = 1;
    // Read: a long lull last spring, otherwise most days.
    if (d >= dayOf(habits[1].createdAt)) {
      const lull = years > 0.35 && years < 0.6 ? -0.4 : 0;
      if (rnd() < 0.7 + lull) habitLog['demo-read'][d] = [10, 15, 20, 20, 25, 30, 40][Math.floor(rnd() * 7)];
    }
    // Meditate: getting better, with the odd rest day.
    if (d >= dayOf(habits[2].createdAt)) {
      const r = rnd();
      if (r < 0.04) habitLog['demo-meditate'][d] = SKIP;
      else if (r < 0.5 + 0.35 * (1 - (today - d) / 120)) habitLog['demo-meditate'][d] = 1;
    }
  }
  return { habits, habitLog };
}

// ---- building editor documents by hand (the shape the Projects editor saves)
type Inline = string | { b: string } | { code: string };
const inl = (x: Inline): DocNode =>
  typeof x === 'string' ? { type: 'text', text: x } : 'b' in x ? { type: 'text', text: x.b, marks: [{ type: 'bold' }] } : { type: 'text', text: x.code, marks: [{ type: 'code' }] };
const para = (...xs: Inline[]): DocNode => ({ type: 'paragraph', content: xs.map(inl) });
const h2 = (t: string): DocNode => ({ type: 'heading', attrs: { level: 2 }, content: [inl(t)] });
const listOf = (type: 'bulletList' | 'orderedList', xs: (string | [string, string[]])[]): DocNode => ({
  type, content: xs.map((x) => ({ type: 'listItem', content: typeof x === 'string' ? [para(x)] : [para(x[0]), listOf('bulletList', x[1])] })),
});
/** To-dos: 'x ' = done; an array right after one = to-dos that wait on it. Items may mix text and code. */
type Todo = string | Inline[];
function todos(...xs: (Todo | Todo[][])[]): DocNode {
  const out: DocNode[] = [];
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k];
    if (Array.isArray(x) && Array.isArray(x[0])) continue; // a nested group, handled with its parent
    const parts: Inline[] = typeof x === 'string' ? [x] : (x as Inline[]);
    const first = parts[0];
    const done = typeof first === 'string' && first.startsWith('x ');
    if (done) parts[0] = (first as string).slice(2);
    const next = xs[k + 1];
    const kids = Array.isArray(next) && Array.isArray(next[0]) ? [todos(...(next as Todo[][])[0])] : [];
    out.push({ type: 'taskItem', attrs: { checked: done }, content: [para(...parts), ...kids] });
  }
  return { type: 'taskList', content: out };
}
const doc = (...blocks: DocNode[]): DocNode => ({ type: 'doc', content: blocks });

/** Demo projects: an example researcher (an advisor Alex, a collaborator Jordan, a student Kai), with threads at
 *  different stages, notes from meetings, people owing things, ideas and some history. */
export function makeDemoProjects(now = new Date()): { projects: Project[]; threads: Thread[]; projectLog: LogEntry[] } {
  const t = now.getTime();
  const ago = (d: number, h = 0) => t - d * 86_400_000 - h * 3_600_000;
  const projects: Project[] = [
    {
      id: 'demo-sim', title: 'Simulation study', color: '#2f7cf6', createdAt: ago(400),
      about: 'Run the simulations, make synthetic observations, compare them with the real ones.',
      pins: [
        { id: 'demo-pin-0', label: 'Paper draft', href: 'https://www.overleaf.com' },
        { id: 'demo-pin-1', label: 'Code', href: 'https://github.com' },
        { id: 'demo-pin-2', label: '~/runs on cluster', href: 'cluster:~/runs' },
        { id: 'demo-pin-3', label: 'Observations paper', href: 'https://arxiv.org' },
      ],
      ideas: [{ id: 'demo-idea-0', text: 'A different particle distribution in the post-processing — does it change the spectral index?', at: ago(9) }],
      doc: doc(
        h2('Plan'),
        listOf('orderedList', ['Big run → statistics paper (this term)', 'Compare with the observed light curves', 'Follow-up with the new post-processing (after the paper)']),
        todos('Renew the cluster allocation before Nov 1', 'Ask IT about the scratch quota'),
      ),
    },
    {
      id: 'demo-survey', title: 'Survey paper', color: '#e45db0', createdAt: ago(700),
      about: 'Fit the full survey sample and write it up. With Jordan.',
      pins: [{ id: 'demo-pin-4', label: 'Survey sample', href: '~/data/survey' }, { id: 'demo-pin-5', label: 'Draft', href: 'https://www.overleaf.com' }],
      ideas: [{ id: 'demo-idea-1', text: 'A lookup table of the model parameters, to quote in the paper', at: ago(30) }],
      doc: doc(
        h2('Outline'),
        listOf('bulletList', ['Intro: what the survey can test', 'Data: the sample and the cuts', 'Method: the fits', ['Results', ['The main histogram', 'Comparison with a random sample']], 'Discussion: what it rules out']),
      ),
    },
    {
      id: 'demo-kai', title: 'Kai — student project', color: '#f29a1d', createdAt: ago(80),
      about: "Kai's project (2nd-year student): measuring feature sizes in the simulation output.",
      pins: [{ id: 'demo-pin-6', label: "Kai's repo", href: 'https://github.com' }, { id: 'demo-pin-7', label: 'Shared plots', href: '~/shared/kai_plots' }],
      ideas: [{ id: 'demo-idea-2', text: 'Kai gives a talk at the group retreat', at: ago(20) }],
      doc: doc(para('Weekly 1:1. Aim: a short letter by spring, and a talk at the group retreat.')),
    },
    {
      id: 'demo-thesis', title: 'Thesis chapter', color: '#14a8b8', createdAt: ago(1100),
      about: 'The measurements are done; the chapter is what is left.', pins: [], ideas: [], doc: doc(para('Only the writing left.')),
    },
  ];
  let n = 0;
  const th = (projectId: string, title: string, edited: number, body: DocNode, extra: Partial<Thread> = {}): Thread => ({
    id: `demo-th-${n++}`, projectId, title, status: 'active', body, createdAt: ago(edited + 40), updatedAt: ago(edited), ...extra,
  });
  const threads: Thread[] = [
    th('demo-sim', 'Get the big run going on the cluster', 1, doc(
      para('High-resolution run. Config in ', { code: '~/runs/big' }, ' on the cluster; checkpoints every 500 steps.'),
      todos('x Compile with the new HDF5 module', 'x Short test run', 'Restart from a checkpoint', [['Queue the full run', 'Check the first results']]),
    )),
    th('demo-sim', 'Statistics paper', 2, doc(
      para('Waiting times and sizes of the events across all runs; compare with the observed statistics.'),
      todos('x Event finder on all runs', 'Figure: waiting-time distribution', 'x Draft the methods section'),
      h2('§2 Methods (draft)'),
      para('We identify events as sharp drops in the measured flux, exceeding 15 per cent within 200 time units. For each event we record the amplitude, the duration and the energy released…'),
      para('The waiting times between events follow an approximately exponential distribution, consistent with a memoryless process. (Check against the low-resolution runs before claiming this.)'),
      h2('§3 Results'),
    )),
    th('demo-sim', 'Compare with the observations', 2, doc(
      para('Overlay the synthetic light curves on the observed ones; is the rise time right?'),
      todos('Reduced observational data @Alex', [['Overlay the synthetic light curves', 'Fit rise / decay times', 'Decide: figure in the paper, or its own letter?']]),
    )),
    th('demo-survey', 'Archival spectra from Sam', 3, doc(
      para("Sam's archival data cover decades; they could tighten the main constraint."),
      todos('The archival spectra and reduction notes @Sam', [['Compute the structure function', 'Compare with what the model needs']]),
    )),
    th('demo-survey', 'Fit the full sample', 3, doc(todos('x Clean the sample', 'Fit every object'))),
    th('demo-kai', 'Feature finder on the simulation output', 7, doc(
      para("Kai's finder: locates the features along the current sheet and measures their sizes."),
      todos('x Run it on the first set of outputs', 'Resolution test (does it miss small ones?)'),
    )),
    th('demo-thesis', 'Write the instrument chapter', 2, doc(todos('x §1 Setup', 'x §2 Methods', '§3 Results', '§4 Systematics'))),
    th('demo-thesis', 'Noise vs temperature', 60, doc(para('Done — it is §3 of the chapter.')), { status: 'done', doneAt: ago(60) }),
  ];
  const [run, stats, obs, sam, fit, finder, chap] = threads;
  let k = 0;
  const note = (parentId: string, d: number, h: number, ...blocks: DocNode[]): LogEntry => ({ id: `demo-log-${k++}`, parentId, at: ago(d, h), doc: doc(...blocks) });
  const projectLog: LogEntry[] = [
    note(run.id, 1, 5, para('Restart from a checkpoint hangs — only with > 64 nodes. Smells like the file system striping.'), todos(['Try ', { code: 'lfs setstripe -c 8' }, ' on the checkpoint dir'])),
    note(run.id, 6, 3, para('Compiles with the new HDF5 module; the short test ran clean.')),
    note(run.id, 9, 2, para({ b: 'Alex:' }, " has seen this hang before — it's the MPI-IO buffering, not the file system."), todos('Set romio_cb_write = disable and retry')),
    note(stats.id, 2, 4, para({ b: 'Alex:' }, ' methods draft reads well. Wants the threshold dependence shown in an appendix, not just stated.'), todos('Appendix figure: number of events vs threshold')),
    note(stats.id, 12, 2, para('Finder now runs on all six runs; 214 events. Threshold choice matters below 10 per cent — stick to 15.')),
    note(obs.id, 2, 4, para('Alex: the data is still coming — after a proposal deadline.')),
    note(obs.id, 6, 1, para('Asked Alex for the reduced data.')),
    note(sam.id, 3, 2, para('Emailed Sam asking for the archival spectra and the reduction notes.')),
    note(fit.id, 3, 5, para({ b: 'Jordan:' }, ' fine to lose a third of the sample if the fits are cleaner; say so in the paper.'), todos('x Decide on the cut', 'Rerun the fits with the new cut')),
    note(finder.id, 7, 3, para('Results: 312 features in the first set. Sizes look log-normal, not a power law — interesting if it holds.'), para('Q: is the finder missing features near the grid scale? That alone could turn a power law into a log-normal.')),
    note(chap.id, 2, 2, para('§2 done. §3 needs the temperature figure redone with error bars.')),
    note('demo-sim', 2, 4, para({ b: 'Meeting with Alex.' }, ' Paper sections agreed:'), listOf('orderedList', ['Introduction', 'Simulations and the event finder', 'Statistics: waiting times, sizes, durations', 'Comparison with the observations', 'Discussion: what sets the waiting time?'])),
    note('demo-sim', 9, 2, para({ b: 'Meeting with Alex.' }), para('Decided: the big run first; the new post-processing after the paper.')),
    note('demo-survey', 2, 3, para('Idea: (from Alex) the same fits could test the simulations too.'), todos('Bring up the cross-check with Jordan')),
    note('demo-survey', 3, 5, para({ b: 'Jordan.' }), para('Decided: the outline above. The results section gets the main histogram and a random-sample comparison.'), para('Q: do we need the second survey too, or is this one enough?')),
    note('demo-kai', 0, 1, para({ b: '1:1.' }, ' Nothing new — Kai was at a conference.')),
    note('demo-kai', 7, 3, para({ b: '1:1.' }), todos('Size histogram with Poisson error bars @Kai', [['Compare with the published slope', 'Decide whether it goes in the statistics paper']]), para('Idea: feature sizes as a proxy for the event durations — links the project to the statistics paper.')),
  ];
  return { projects, threads, projectLog };
}
