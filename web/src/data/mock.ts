// Demo data for development, the tests and the website's screenshots: a made-up research professor's week (a lab, a
// department, students and collaborators with generic names). Nothing in it is about a real person or place. The app
// itself starts empty.
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
    add('research', 'Group meeting', at(mon, 10), at(mon, 11), { location: 'Lab' });
    add('dept', 'Teaching: Intro course', at(day(1), 12), at(day(1), 13), { location: 'Room 210' });
    add('dept', 'Teaching: Intro course', at(day(3), 12), at(day(3), 13), { location: 'Room 210' });
    if (w % 2 === 0) add('research', 'Jordan — review article', at(day(2), 14), at(day(2), 15));
    add('personal', 'Gym', at(mon, 18), at(mon, 19, 30));
    add('personal', 'Gym', at(day(3), 7, 30), at(day(3), 8, 30));
    if (w % 3 === 0) add('social', 'Climbing', at(day(5), 14), at(day(5), 17), { location: 'Climbing gym' });
    // A regular 1:1 that hasn't been put on the calendar yet this week (suggestions will notice)
    if (w < 0) add('research', 'Meeting with Alex', at(day(3), 15), at(day(3), 16));
  }

  // A real repeating series (stored once, shown every Friday)
  add('dept', 'Journal club', at(addDays(wk0, -8 * 7 + 4), 11), at(addDays(wk0, -8 * 7 + 4), 12), {
    recurrence: { freq: 'weekly', interval: 1, byDay: [5] },
  });

  // A busy afternoon today, to show side-by-side overlap layout
  const today = startOfDay(now);
  add('research', 'Check the overnight results', at(today, 9), at(today, 9, 30));
  add('social', 'Coffee chat', at(today, 14), at(today, 14, 30));
  add('dept', 'Hiring committee', at(today, 14, 30), at(today, 16));
  // A clash tomorrow afternoon
  add('research', 'Collaboration call', at(addDays(today, 1), 15), at(addDays(today, 1), 15, 30));
  add('research', 'Office hours', at(addDays(today, 1), 15, 15), at(addDays(today, 1), 16));
  add('personal', 'Dentist', at(addDays(today, 6), 9), at(addDays(today, 6), 10));
  // Overnight event split across two days
  add('research', 'Overnight data run', at(addDays(today, 2), 22), at(addDays(today, 3), 2));

  // All-day and multi-day
  // Deadlines: a due moment (5 PM by default) with a runway of work before it
  const due = (title: string, day: Date, h = 17, leadDays?: number) => {
    const t = at(day, h);
    add('', title, t, t, { kind: 'deadline', ...(leadDays ? { leadDays } : {}) }); // deadlines have no calendar
  };
  // (each with an id its checklist steps point at — makeDemoTasks)
  const dueId = (id: string, ...a: Parameters<typeof due>) => (due(...a), (events[events.length - 1].id = id));
  dueId('demo-dl-paper', 'Paper revision', addDays(today, 6)); // (each stage of colour on show: yellow)
  dueId('demo-dl-abstract', 'Conference abstract', addDays(today, 1), 12);
  dueId('demo-grant', 'Grant proposal', addDays(today, 41), 17, 21);
  dueId('demo-dl-review', 'Referee report', addDays(today, -1));
  dueId('demo-dl-grades', 'Midterm grades', addDays(today, 3)); // orange
  dueId('demo-dl-report', 'Annual report', addDays(today, 12)); // green
  allDay('research', 'Research workshop', addDays(wk0, 15), 3);
  allDay('social', 'Weekend away', addDays(wk0, 11), 3);
  allDay('personal', 'Mom’s birthday', addDays(today, 3), 1);
  allDay('holidays', 'Reading week', addDays(wk0, 21), 5);

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
    t('Email Jordan the figures', 0),
    t('Book flight to the workshop', -3),
    t('Pay rent', 2),
    t('Renew library books', 5),
    t('Buy coffee filters'),
    t('Order lab supplies'),
    t('Reply to Sam about the course schedule'),
    t('Submit expense report', 0, { done: true, doneAt: now.getTime() - 3_600_000 }),
    // checklists of the deadlines (makeDemoEvents)
    t('Grant budget', 20, { parentId: 'demo-grant' }),
    t('Grant CV', 27, { parentId: 'demo-grant' }),
    t('Grant letters of support', undefined, { parentId: 'demo-grant' }),
    t('Grant draft to Alex', 34, { parentId: 'demo-grant', done: true, doneAt: now.getTime() - 86_400_000 }),
    t('Abstract text (250 words)', undefined, { parentId: 'demo-dl-abstract', done: true, doneAt: now.getTime() - 2 * 86_400_000 }),
    t('Key figure', 0, { parentId: 'demo-dl-abstract' }),
    t('Co-authors sign off', 1, { parentId: 'demo-dl-abstract' }),
    t('Answer the referees point by point', 3, { parentId: 'demo-dl-paper' }),
    t('Redo figure 3', 2, { parentId: 'demo-dl-paper', done: true, doneAt: now.getTime() - 86_400_000 }),
    t('Cover letter', 5, { parentId: 'demo-dl-paper' }),
    t('Read the manuscript', undefined, { parentId: 'demo-dl-review', done: true, doneAt: now.getTime() - 3 * 86_400_000 }),
    t('Write the report', -1, { parentId: 'demo-dl-review' }),
    t('Mark the midterms', 2, { parentId: 'demo-dl-grades' }),
    t('Enter the grades', 3, { parentId: 'demo-dl-grades' }),
    t('Collect the numbers from the group', 7, { parentId: 'demo-dl-report' }),
    t('Write the summary', 11, { parentId: 'demo-dl-report' }),
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
const code = (language: string, text: string): DocNode => ({ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text }] });
const math = (latex: string): DocNode => ({ type: 'blockMath', attrs: { latex } });

/** Demo projects: a made-up research professor (a collaborator Alex, a co-author Jordan, a PhD student Kai), with
 *  threads at different stages, notes from meetings, people owing things, ideas and some history. */
export function makeDemoProjects(now = new Date()): { projects: Project[]; threads: Thread[]; projectLog: LogEntry[] } {
  const t = now.getTime();
  const ago = (d: number, h = 0) => t - d * 86_400_000 - h * 3_600_000;
  const projects: Project[] = [
    {
      id: 'demo-sim', title: 'Main study', color: '#2f7cf6', createdAt: ago(400),
      about: 'The funded study: collect the data, analyse it, and compare the results with the model.',
      pins: [
        { id: 'demo-pin-0', label: 'Paper draft', href: 'https://www.overleaf.com' },
        { id: 'demo-pin-1', label: 'Code', href: 'https://github.com' },
        { id: 'demo-pin-2', label: '~/data on the server', href: 'server:~/data' },
        { id: 'demo-pin-3', label: 'Related paper', href: 'https://arxiv.org' },
      ],
      ideas: [{ id: 'demo-idea-0', text: 'A second analysis method as a cross-check — does the main result change?', at: ago(9) }],
      doc: doc(
        h2('Plan'),
        listOf('orderedList', ['Full analysis → results paper (this term)', 'Compare with the model', 'Follow-up study (after the paper)']),
        todos('Renew the computing allocation before Nov 1', 'Ask IT about more storage'),
      ),
    },
    {
      id: 'demo-survey', title: 'Review article', color: '#e45db0', createdAt: ago(700),
      about: 'An invited review of the field. With Jordan.',
      pins: [{ id: 'demo-pin-4', label: 'Reading list', href: '~/review/reading' }, { id: 'demo-pin-5', label: 'Draft', href: 'https://www.overleaf.com' }],
      ideas: [{ id: 'demo-idea-1', text: 'A summary table of the main results, to open the review', at: ago(30) }],
      doc: doc(
        h2('Outline'),
        listOf('bulletList', ['Introduction: the open questions', 'Methods used so far', ['Results', ['What is settled', 'What is still debated']], 'Outlook']),
      ),
    },
    {
      id: 'demo-kai', title: 'Kai — PhD project', color: '#f29a1d', createdAt: ago(80),
      about: "Kai's PhD project (2nd year): measuring the effect in the new data set.",
      pins: [{ id: 'demo-pin-6', label: "Kai's repo", href: 'https://github.com' }, { id: 'demo-pin-7', label: 'Shared figures', href: '~/shared/kai_figures' }],
      ideas: [{ id: 'demo-idea-2', text: 'Kai gives a talk at the group retreat', at: ago(20) }],
      doc: doc(para('Weekly 1:1. Aim: a first paper by spring, and a talk at the group retreat.')),
    },
    {
      id: 'demo-thesis', title: 'Grant renewal', color: '#14a8b8', createdAt: ago(1100),
      about: 'Renewing the lab grant: aims, budget, letters.', pins: [], ideas: [], doc: doc(para('Due in six weeks; the aims are nearly done.')),
    },
  ];
  let n = 0;
  const th = (projectId: string, title: string, edited: number, body: DocNode, extra: Partial<Thread> = {}): Thread => ({
    id: `demo-th-${n++}`, projectId, title, status: 'active', body, createdAt: ago(edited + 40), updatedAt: ago(edited), ...extra,
  });
  const threads: Thread[] = [
    th('demo-sim', 'Get the full analysis running', 1, doc(
      para('The full data set on the server. Config in ', { code: '~/analysis/full' }, '; results saved every 500 steps.'),
      code('bash', '#!/bin/bash\n#SBATCH --nodes=8 --time=12:00:00\nmodule load python/3.12\nsrun python analyse.py --config ~/analysis/full/params.ini --resume latest'),
      todos('x Set up the environment on the server', 'x Short test run', 'Resume from the last checkpoint', [['Queue the full run', 'Check the first results']]),
    )),
    th('demo-sim', 'Results paper', 2, doc(
      para('The main measurement across the whole data set, compared with the model.'),
      todos('x Run the event finder on everything', 'Figure: waiting-time distribution', 'x Draft the methods section'),
      h2('§2 Methods (draft)'),
      para('We identify events as changes in the signal larger than 15 per cent within 200 time units. For each event we record the amplitude, the duration and the time since the previous one…'),
      para('The waiting times between events follow an approximately exponential distribution, consistent with a memoryless process. (Check against the smaller data set before claiming this.)'),
      math('P(\\Delta t) = \\lambda\\, e^{-\\lambda \\Delta t}, \\qquad \\hat\\lambda = \\frac{N}{\\sum_i \\Delta t_i}'),
      code('python', 'import numpy as np\n\ndt = np.diff(event_times)          # waiting times\nlam = len(dt) / dt.sum()           # maximum-likelihood rate\nprint(f"rate = {lam:.3g} per unit time, mean wait = {1 / lam:.1f}")'),
      h2('§3 Results'),
    )),
    th('demo-sim', 'Compare with the model', 2, doc(
      para('Put the model predictions on the same plots as the measurements; do the timescales agree?'),
      todos('Model predictions for the new parameters @Alex', [['Overlay them on the measurements', 'Fit the timescales', 'Decide: a figure in the paper, or a short paper of its own?']]),
    )),
    th('demo-survey', 'Older data sets from Sam', 3, doc(
      para("Sam's older data cover a much longer period; they could tighten the main result."),
      todos('The older data and their notes @Sam', [['Add them to the comparison table', 'Check they use the same definitions']]),
    )),
    th('demo-survey', 'Read the recent papers', 3, doc(todos('x Collect the reading list', 'Summarise each in two lines'))),
    th('demo-kai', 'First measurement', 7, doc(
      para("Kai's analysis: finds the events in the new data set and measures their sizes."),
      todos('x Run it on the first half of the data', 'Check the selection (does it miss small events?)'),
    )),
    th('demo-thesis', 'Write the renewal', 2, doc(todos('x Aims', 'x Progress report', 'Budget', 'Letters of support'))),
    th('demo-thesis', 'Last year’s report', 60, doc(para('Done — submitted in the spring.')), { status: 'done', doneAt: ago(60) }),
  ];
  const [run, stats, obs, sam, fit, finder, chap] = threads;
  let k = 0;
  const note = (parentId: string, d: number, h: number, ...blocks: DocNode[]): LogEntry => ({ id: `demo-log-${k++}`, parentId, at: ago(d, h), doc: doc(...blocks) });
  const projectLog: LogEntry[] = [
    note(run.id, 1, 5, para('Resuming from a checkpoint fails — only with more than 4 nodes. Probably the file system.'), todos(['Try writing checkpoints to ', { code: '/scratch' }, ' instead'])),
    note(run.id, 6, 3, para('The environment works; the short test ran clean.')),
    note(run.id, 9, 2, para({ b: 'Alex:' }, " has seen this before — it's the parallel file writes, not the file system."), todos('Write one checkpoint file per node and retry')),
    note(stats.id, 2, 4, para({ b: 'Alex:' }, ' methods draft reads well. Wants the threshold dependence shown in an appendix, not just stated.'), todos('Appendix figure: number of events vs threshold')),
    note(stats.id, 12, 2, para('The event finder now runs on everything; 214 events. The threshold matters below 10 per cent — stick to 15.')),
    note(obs.id, 2, 4, para('Alex: the model runs are still going — after a proposal deadline.')),
    note(obs.id, 6, 1, para('Asked Alex for the model predictions.')),
    note(sam.id, 3, 2, para('Emailed Sam asking for the older data and the notes on how it was taken.')),
    note(fit.id, 3, 5, para({ b: 'Jordan:' }, ' fine to leave out the weaker studies if the table is clearer; say so in the text.'), todos('x Decide what goes in the table', 'Redo the table with the new cut')),
    note(finder.id, 7, 3, para('Results: 312 events in the first half. The sizes look log-normal, not a power law — interesting if it holds.'), para('Q: does the selection miss the smallest events? That alone could turn a power law into a log-normal.')),
    note(chap.id, 2, 2, para('Progress report done. The budget needs the new equipment quote.')),
    note('demo-sim', 2, 4, para({ b: 'Meeting with Alex.' }, ' Paper sections agreed:'), listOf('orderedList', ['Introduction', 'Data and the event finder', 'Results: waiting times, sizes, durations', 'Comparison with the model', 'Discussion'])),
    note('demo-sim', 9, 2, para({ b: 'Meeting with Alex.' }), para('Decided: the full analysis first; the follow-up study after the paper.')),
    note('demo-survey', 2, 3, para('Idea: (from Alex) the same comparison could test the model too.'), todos('Bring up the cross-check with Jordan')),
    note('demo-survey', 3, 5, para({ b: 'Jordan.' }), para('Decided: the outline above. The results section gets the summary table and a timeline.'), para('Q: do we cover the older methods too, or only the last ten years?')),
    note('demo-kai', 0, 1, para({ b: '1:1.' }, ' Nothing new — Kai was at a conference.')),
    note('demo-kai', 7, 3, para({ b: '1:1.' }), todos('Size histogram with error bars @Kai', [['Compare with the published values', 'Decide whether it goes in the results paper']]), para('Idea: the event sizes could stand in for their durations — links the project to the results paper.')),
  ];
  return { projects, threads, projectLog };
}
