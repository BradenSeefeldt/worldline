import { describe, expect, it } from 'vitest';
import {
  ago, appendItem, bestThreads, columnOf, docText, ideasOf, itemsIn, looksLikeMarkdown, marksIn, migrateV1, normalizeTodos, openItems, protectDollars, removeAt, restoreDollars, search, setAttrsAt, span, statusOf, textToDoc, todoNode,
  type DocNode, type Thread, type World,
} from './projects';
import { makeDemoProjects } from '../data/mock';

const NOW = new Date(2026, 9, 9, 15).getTime();
const DAY = 86_400_000;
const p = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const todo = (text: string, checked = false, kids: DocNode[] = []): DocNode => ({ type: 'taskItem', attrs: { checked }, content: [p(text), ...(kids.length ? [{ type: 'taskList', content: kids }] : [])] });
const doc = (...blocks: DocNode[]): DocNode => ({ type: 'doc', content: blocks });
const list = (...items: DocNode[]): DocNode => ({ type: 'taskList', content: items });
let n = 0;
const th = (extra: Partial<Thread> = {}): Thread => ({ id: `t${n++}`, projectId: 'p', title: `T${n}`, status: 'active', body: doc(p('')), createdAt: NOW - 100 * DAY, updatedAt: NOW - DAY, ...extra });
const world = (threads: Thread[], extra: Partial<World> = {}): World => ({ projects: [{ id: 'p', title: 'P', color: '#000', createdAt: 0 }], threads, projectLog: [], ...extra });

describe('reading what you wrote', () => {
  it('to-dos: done or not, @Name = someone else’s, under an unticked one = waiting behind it', () => {
    const d = doc(p('Plan'), list(todo('x', true), todo('Reduced 2018 data @Alex', false, [todo('Overlay'), todo('Fit', false, [todo('Decide')])]), todo('Done one', true, [todo('Now free')])));
    expect(itemsIn(d).map(({ text, done, who, blockedBy }) => ({ text, done, who, blockedBy }))).toEqual([
      { text: 'x', done: true, who: undefined, blockedBy: undefined },
      { text: 'Reduced 2018 data', done: false, who: 'Alex', blockedBy: undefined },
      { text: 'Overlay', done: false, who: undefined, blockedBy: 'Reduced 2018 data' },
      { text: 'Fit', done: false, who: undefined, blockedBy: 'Reduced 2018 data' },
      { text: 'Decide', done: false, who: undefined, blockedBy: 'Fit' },
      { text: 'Done one', done: true, who: undefined, blockedBy: undefined },
      { text: 'Now free', done: false, who: undefined, blockedBy: undefined },
    ]);
  });
  it('Idea: / Decided: / Q: paragraphs (not inside to-dos); a settled Q is marked', () => {
    const d = doc(p('Idea: polarization'), p('Decided: a = 0.94 first'), p('Q: Hamann sample?'), p('Quiet: not a mark'), list(todo('Q: inside a to-do')));
    expect(marksIn(d).map(({ kind, text, resolved }) => [kind, text, resolved])).toEqual([['idea', 'polarization', false], ['decided', 'a = 0.94 first', false], ['q', 'Hamann sample?', false]]);
    const settled = setAttrsAt(d, marksIn(d)[2].path, { resolved: true });
    expect(marksIn(settled)[2].resolved).toBe(true);
    expect(marksIn(d)[2].resolved).toBe(false); // the original is untouched
  });
  it('a thread is waiting when nothing is ready for you and someone owes you something', () => {
    const waiting = th({ body: doc(list(todo('Data @Alex', false, [todo('Overlay')]))) });
    const busy = th({ body: doc(list(todo('Data @Alex'), todo('Write §3'))) });
    const w = world([waiting, busy]);
    expect(statusOf(w, waiting)).toEqual({ kind: 'waiting', who: 'Alex' });
    expect(statusOf(w, busy)).toEqual({ kind: 'active' });
  });
  it("a page's to-dos include its notes, each knowing where (and when) it was written", () => {
    const t = th({ body: doc(list(todo('In the body'))) });
    const w = world([t], { projectLog: [{ id: 'e1', parentId: t.id, at: NOW - 2 * DAY, doc: doc(list(todo('From a note'))) }] });
    expect(openItems(w, t.id).map((x) => [x.text, x.s.entry ?? 'body', x.s.at ?? null])).toEqual([['In the body', 'body', null], ['From a note', 'e1', NOW - 2 * DAY]]);
  });
  it('a column: active threads (quiet and waiting ones sink, otherwise most recently edited first), and done', () => {
    const recent = th({ updatedAt: NOW - DAY }), older = th({ updatedAt: NOW - 5 * DAY }), quiet = th({ updatedAt: NOW - 30 * DAY });
    const waiting = th({ updatedAt: NOW, body: doc(list(todo('Data @Alex'))) }), done = th({ status: 'done', doneAt: NOW });
    const c = columnOf(world([quiet, older, waiting, recent, done]), 'p', NOW);
    expect(c.live.map((t) => t.id)).toEqual([recent.id, older.id, waiting.id, quiet.id]);
    expect(c.done).toEqual([done]);
  });
  it('ideas: jotted ones plus every unstarted "Idea:" line in the project or its threads', () => {
    const t = th({ body: doc(p('Idea: from a thread'), p('Idea: started already')) });
    const started = setAttrsAt(t.body!, [1], { resolved: true });
    const w = world([{ ...t, body: started }], { projects: [{ id: 'p', title: 'P', color: '#000', createdAt: 0, ideas: [{ id: 'i', text: 'Jotted', at: 0 }] }] });
    expect(ideasOf(w, 'p').map((x) => x.text)).toEqual(['Jotted', 'from a thread']);
  });
  it('search finds words in pages, notes, ideas and pins', () => {
    const t = th({ title: 'Restart', body: doc(p('Config in ~/runs/a094')) });
    const w = world([t], {
      projects: [{ id: 'p', title: 'Flares', color: '#000', createdAt: 0, pins: [{ id: 'x', label: 'Runs', href: '~/runs' }], ideas: [{ id: 'i', text: 'runs at higher spin', at: 0 }] }],
      projectLog: [{ id: 'e', parentId: t.id, at: NOW, doc: doc(p('Lustre striping on the runs dir')) }],
    });
    expect(search(w, 'RUNS').map((h) => h.label)).toEqual(['Restart', 'Idea · Flares', 'Pin · Flares', 'Restart']);
    expect(search(w, '  ')).toEqual([]);
    // one project only: its page, notes, ideas, pins and its threads — nothing from elsewhere
    const other = th({ projectId: 'q', title: 'runs elsewhere' });
    const w2 = { ...w, threads: [...w.threads, other], projects: [...w.projects, { id: 'q', title: 'Other', color: '#000', createdAt: 0 }] };
    expect(search(w2, 'runs').map((h) => h.owner)).toContain(other.id);
    expect(search(w2, 'runs', 'p').map((h) => h.owner)).not.toContain(other.id);
    expect(search(w2, 'runs', 'p')).toHaveLength(4);
  });
  it('"today", "yesterday", "3d ago", "2w ago"; and how long something has waited', () => {
    expect(ago(NOW - 2 * 3_600_000, NOW)).toBe('today');
    expect(ago(NOW - DAY, NOW)).toBe('yesterday');
    expect(ago(NOW - 3 * DAY, NOW)).toBe('3d ago');
    expect(ago(NOW - 15 * DAY, NOW)).toBe('2w ago');
    expect(span(NOW - DAY, NOW)).toBe('1d');
    expect(span(NOW - 15 * DAY, NOW)).toBe('2w');
  });
  it('plain text ↔ documents', () => {
    expect(docText(textToDoc('One\nTwo'))).toBe('One Two');
    expect(docText(textToDoc(''))).toBe('');
    // equations read back as LaTeX (so search finds them, and a to-do with one in it reads right)
    const eq = doc({ type: 'paragraph', content: [{ type: 'text', text: 'flux ' }, { type: 'inlineMath', attrs: { latex: '\\phi_{BH}' } }] }, { type: 'blockMath', attrs: { latex: 'E = mc^2' } });
    expect(docText(eq)).toBe('flux $\\phi_{BH}$ $$E = mc^2$$');
  });
});

describe('the old format (v1) converts without losing anything', () => {
  it('About, steps, the next step and waiting-on become the page; notes become documents; bare ideas become ideas', () => {
    const v1 = {
      projects: [{ id: 'p', title: 'Flares', color: '#2f7cf6', meetings: ['Meeting with Alex'], createdAt: 1 }],
      threads: [
        { id: 'a', projectId: 'p', title: 'Run', status: 'active', about: 'the solver\nMAD', next: 'Fix MPI', steps: [{ title: 'Compile', done: true }], createdAt: 1, updatedAt: 2 },
        { id: 'b', projectId: 'p', title: 'GRAVITY', status: 'waiting', waitingOn: 'Alex — reduced 2018 data', createdAt: 1, updatedAt: 2 },
        { id: 'c', projectId: 'p', title: 'eDF', status: 'idea', about: 'κ electrons', createdAt: 5, updatedAt: 5 },
        { id: 'd', projectId: 'p', title: 'Idea with notes', status: 'idea', createdAt: 1, updatedAt: 1 },
        { id: 'e', projectId: 'p', title: 'Old', status: 'done', doneAt: 9, createdAt: 1, updatedAt: 9 },
      ],
      projectLog: [{ id: 'n1', parentId: 'a', text: 'Hangs at restart.\nTry striping.', at: 3 }, { id: 'n2', parentId: 'd', text: 'A thought', at: 4 }, { id: 'n3', parentId: 'p', text: 'Project note', at: 5 }],
    };
    const w = migrateV1(v1);
    expect(w.projects[0]).toEqual({ id: 'p', title: 'Flares', color: '#2f7cf6', createdAt: 1, pins: [], ideas: [{ id: 'c', text: 'eDF — κ electrons', at: 5 }] });
    const a = w.threads.find((t) => t.id === 'a')!;
    expect(docText(a.body)).toBe('the solver MAD Compile Fix MPI');
    expect(itemsIn(a.body).map((x) => [x.text, x.done])).toEqual([['Compile', true], ['Fix MPI', false]]);
    const b = w.threads.find((t) => t.id === 'b')!;
    expect(statusOf(w, b)).toEqual({ kind: 'waiting', who: 'Alex' });
    expect(itemsIn(b.body)[0].text).toBe('reduced 2018 data');
    expect(w.threads.find((t) => t.id === 'd')!.status).toBe('active'); // an idea that already had notes stays a thread
    expect(w.threads.find((t) => t.id === 'e')).toMatchObject({ status: 'done', doneAt: 9 });
    expect(w.threads.some((t) => t.id === 'c')).toBe(false);
    expect(w.projectLog.map((e) => [e.id, docText(e.doc)])).toEqual([['n1', 'Hangs at restart. Try striping.'], ['n2', 'A thought'], ['n3', 'Project note']]);
  });
});

describe('the demo projects', () => {
  it('read back as intended: waiting threads, ideas from notes, nothing blank', () => {
    const w = makeDemoProjects(new Date(NOW));
    const waiting = w.threads.filter((t) => statusOf(w, t).kind === 'waiting').map((t) => [t.title, statusOf(w, t).who]);
    expect(waiting).toEqual([['Compare with the model', 'Alex'], ['Older data sets from Sam', 'Sam']]);
    expect(ideasOf(w, 'demo-kai').map((x) => x.text)).toContain('the event sizes could stand in for their durations — links the project to the results paper.');
    for (const t of w.threads) expect(docText(t.body).trim(), t.title).not.toBe('');
  });
});

describe('action items: capture now, file later', () => {
  it('a to-do goes on the end: into a trailing checklist, else a new one (an empty page just becomes the list)', () => {
    const one = appendItem(undefined, todoNode('A'));
    expect(one).toEqual({ type: 'doc', content: [list(todo('A'))] });
    expect(itemsIn(appendItem(one, todoNode('B'))).map((x) => x.text)).toEqual(['A', 'B']);
    expect(appendItem(doc(p('Met Alex.')), todoNode('C')).content!.map((b) => b.type)).toEqual(['paragraph', 'taskList']);
    expect(appendItem(textToDoc(''), todoNode('D')).content!.map((b) => b.type)).toEqual(['taskList']);
  });
  it('taking a to-do out keeps what waits under it with it, and drops a checklist left empty', () => {
    const d = doc(p('Notes'), list(todo('Data @Alex', false, [todo('Overlay')])));
    const { doc: left, node } = removeAt(d, itemsIn(d)[0].path);
    expect(left.content!.map((b) => b.type)).toEqual(['paragraph']);
    expect(itemsIn({ type: 'doc', content: [list(node!)] }).map((x) => x.text)).toEqual(['Data', 'Overlay']);
  });
  it('filing: the thread sharing the most words with the to-do comes first, then the most recently edited', () => {
    const run = th({ title: 'Get the a = 0.94 run going on cluster', updatedAt: NOW - 5 * DAY });
    const paper = th({ title: 'Event statistics paper', updatedAt: NOW });
    const done = th({ title: 'Old run', status: 'done' });
    const w = world([run, paper, done]);
    expect(bestThreads(w, 'p', 'Rerun the restart with the a094 run on cluster').map(({ t, score }) => [t.title, score])).toEqual([['Get the a = 0.94 run going on cluster', 2], ['Event statistics paper', 0]]);
    expect(bestThreads(w, 'p', 'Email the department').map(({ t }) => t.id)).toEqual([paper.id, run.id]);
  });
});

describe('pasting markdown', () => {
  it('spots markdown worth formatting, and writes "[] …" lines the markdown way', () => {
    for (const t of ['# Title', '## Sub', '- item', '1. first', '> quote', '- [ ] todo', '[] todo', 'some **bold** text', '$$E=mc^2$$']) expect(looksLikeMarkdown(normalizeTodos(t)), t).toBe(true);
    for (const t of ['Just a sentence.', 'Costs $5.', 'C# and F# are languages', 'a - b = c']) expect(looksLikeMarkdown(t), t).toBe(false);
    expect(normalizeTodos('[] a\n  [x] b\n[ ] c')).toBe('- [ ] a\n  - [x] b\n- [ ] c');
  });
  it('dollar amounts stay text; real equations stay equations', () => {
    const p = protectDollars('costs $5 and $10, slope $\\alpha = -1.8$, and $$E = mc^2$$; a lone $x$ too');
    expect(p).not.toMatch(/\$5|\$10/);
    expect(p).toContain('$\\alpha = -1.8$');
    expect(p).toContain('$$E = mc^2$$');
    expect(p).toContain('$x$');
    const back = restoreDollars({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: p }] }] });
    expect(back.content![0].content![0].text).toBe('costs $5 and $10, slope $\\alpha = -1.8$, and $$E = mc^2$$; a lone $x$ too');
  });
});
