// The store needs a browser; give it the little it touches (window size, events, localStorage).
import { beforeAll, describe, expect, it } from 'vitest';
import { ideasOf, itemsIn, openItems, textToDoc, type DocNode } from '../lib/projects';

const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
Object.assign(globalThis, { localStorage, window: { innerWidth: 1200, localStorage, setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} } });
let useStore: typeof import('./store').useStore;
beforeAll(async () => ({ useStore } = await import('./store')));

const T = new Date(2026, 9, 12, 14).getTime();
const draft = () => useStore.getState().startDraft({ calendarId: 'research', title: '', start: T, end: T + 3_600_000, allDay: false });

describe('dragged-out events are drafts until confirmed', () => {
  it('clicking away throws the draft away, with no undo step left behind', () => {
    const before = useStore.getState();
    const id = draft();
    useStore.getState().updateEvent(id, { title: 'Coffee' }, true);
    expect(useStore.getState().events.some((e) => e.id === id)).toBe(true);
    useStore.getState().select(null);
    const after = useStore.getState();
    expect(after.events.some((e) => e.id === id)).toBe(false);
    expect(after.past.length).toBe(before.past.length);
    expect(after.pendingId).toBe(null);
  });
  it('a confirmed draft is one undo step, however much it was edited first', () => {
    const before = useStore.getState().past.length;
    const id = draft();
    useStore.getState().updateEvent(id, { title: 'Coffee' }, true);
    useStore.getState().updateEvent(id, { end: T + 2 * 3_600_000 });
    useStore.getState().confirmDraft();
    expect(useStore.getState().past.length).toBe(before + 1);
    useStore.getState().undo();
    expect(useStore.getState().events.some((e) => e.id === id)).toBe(false);
  });
  it('confirming keeps it (named "New Event" if left blank) and closes the card', () => {
    const id = draft();
    useStore.getState().confirmDraft();
    const s = useStore.getState();
    expect(s.events.find((e) => e.id === id)?.title).toBe('New Event');
    expect(s.selectedId).toBe(null);
    expect(s.pendingId).toBe(null);
    s.select(null); // nothing else is thrown away later
    expect(useStore.getState().events.some((e) => e.id === id)).toBe(true);
  });
  it('opening a different event also discards the draft', () => {
    const keep = useStore.getState().events[0].id;
    const id = draft();
    useStore.getState().select(keep);
    expect(useStore.getState().events.some((e) => e.id === id)).toBe(false);
    expect(useStore.getState().selectedId).toBe(keep);
  });
});

describe('projects', () => {
  const doc = (...lines: string[]) => textToDoc(lines.join('\n'));
  const todo = (text: string, checked = false, kids: DocNode[] = []) => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...(kids.length ? [{ type: 'taskList', content: kids }] : [])] });
  const st = () => useStore.getState();

  it('a note or an edit counts as touching a thread; finishing stamps it done', () => {
    const p = st().addProject('Test project', '#2f7cf6');
    const t = st().addThread(p, 'Long thing');
    const old = Date.now() - 30 * 86_400_000;
    useStore.setState((x) => ({ threads: x.threads.map((y) => (y.id === t ? { ...y, updatedAt: old } : y)) }));
    st().addLog(t, doc('Tried the restart; MPI hangs.'));
    expect(st().threads.find((x) => x.id === t)!.updatedAt).toBeGreaterThan(old);
    st().updateThread(t, { status: 'done' });
    expect(st().threads.find((x) => x.id === t)!.doneAt).toBeDefined();
    st().updateThread(t, { status: 'active' });
    expect(st().threads.find((x) => x.id === t)!.doneAt).toBeUndefined();
  });
  it('typing is one undo step — a new note and the words that follow too; deleting a project takes its threads and notes', () => {
    const p = st().addProject('Another', '#e45db0');
    const t = st().addThread(p, 'Thread');
    let depth = st().past.length;
    for (const v of ['N', 'Ne', 'Nex', 'Next']) st().updateThread(t, { body: doc(v) }, true);
    expect(st().past.length).toBe(depth + 1);
    depth = st().past.length;
    const n = st().addLog(t, doc('F'));
    for (const v of ['Fi', 'Fin', 'Fine']) st().updateLog(n, doc(v));
    expect(st().past.length).toBe(depth + 1);
    st().addLog(p, doc('Project note'));
    st().deleteProject(p);
    expect(st().threads.some((x) => x.projectId === p)).toBe(false);
    expect(st().projectLog.some((e) => e.parentId === p || e.parentId === t)).toBe(false);
    st().undo();
    expect(st().threads.some((x) => x.id === t)).toBe(true);
  });
  it('ticking a to-do from the board ticks it where it was written (and ⌘Z unticks it)', () => {
    const p = st().addProject('Tick', '#14a8b8');
    const t = st().addThread(p, 'Has to-dos', { type: 'doc', content: [{ type: 'taskList', content: [todo('Data @Alex', false, [todo('Overlay')])] }] });
    const n = st().addLog(t, { type: 'doc', content: [{ type: 'taskList', content: [todo('Rerun')] }] });
    const w = () => ({ projects: st().projects, threads: st().threads, projectLog: st().projectLog });
    const rerun = openItems(w(), t).find((x) => x.text === 'Rerun')!;
    expect(rerun.s).toEqual({ owner: t, entry: n, at: expect.any(Number) });
    st().setChecked(rerun.s, rerun.path, true);
    expect(itemsIn(st().projectLog.find((e) => e.id === n)!.doc)[0].done).toBe(true);
    // Alex delivers: the overlay is no longer waiting behind it
    const data = openItems(w(), t).find((x) => x.who === 'Alex')!;
    expect(openItems(w(), t).find((x) => x.text === 'Overlay')!.blockedBy).toBe('Data');
    st().setChecked(data.s, data.path, true);
    expect(openItems(w(), t).find((x) => x.text === 'Overlay')!.blockedBy).toBeUndefined();
    st().undo();
    expect(openItems(w(), t).find((x) => x.text === 'Overlay')!.blockedBy).toBe('Data');
  });
  it('ideas: jot one, start it (it becomes a thread and leaves the list); an "Idea:" line is marked started', () => {
    const p = st().addProject('Ideas', '#8e5cf7');
    st().addIdea(p, 'Polarization as a test of the geometry');
    const w = () => ({ projects: st().projects, threads: st().threads, projectLog: st().projectLog });
    const jotted = ideasOf(w(), p)[0];
    const t = st().startIdea(p, jotted);
    expect(st().threads.find((x) => x.id === t)).toMatchObject({ projectId: p, title: 'Polarization as a test of the geometry', status: 'active' });
    expect(ideasOf(w(), p)).toEqual([]);
    st().addLog(p, doc('Idea: feature sizes as a proxy for event durations'));
    const line = ideasOf(w(), p)[0];
    expect(line.mark).toBeDefined();
    st().startIdea(p, line);
    expect(ideasOf(w(), p)).toEqual([]);
    expect(st().threads.some((x) => x.title === 'Idea')).toBe(false); // titled from the idea, not its label
  });
  it('action items: added to today’s project note; filing one moves it (and what waits under it) into the thread — one undo step', () => {
    const p = st().addProject('Meetings', '#2e9e4e');
    const t = st().addThread(p, 'Get the run going');
    const w = () => ({ projects: st().projects, threads: st().threads, projectLog: st().projectLog });
    st().addTodo(p, 'Rerun with romio disabled');
    st().addTodo(p, 'Send Alex the plots');
    const notes = () => st().projectLog.filter((e) => e.parentId === p);
    expect(notes()).toHaveLength(1); // both in today's one note
    expect(openItems(w(), p).map((x) => x.text)).toEqual(['Rerun with romio disabled', 'Send Alex the plots']);
    const depth = st().past.length;
    const first = openItems(w(), p)[0];
    st().moveItem(first.s, first.path, t);
    expect(st().past.length).toBe(depth + 1);
    expect(openItems(w(), p).map((x) => x.text)).toEqual(['Send Alex the plots']);
    expect(openItems(w(), t).map((x) => [x.text, !!x.s.entry])).toEqual([['Rerun with romio disabled', true]]);
    const second = openItems(w(), p)[0];
    st().moveItem(second.s, second.path, t);
    expect(notes()).toHaveLength(0); // the project's note had nothing else in it: gone
    expect(openItems(w(), t).map((x) => x.text)).toEqual(['Rerun with romio disabled', 'Send Alex the plots']);
    st().undo();
    expect(openItems(w(), p).map((x) => x.text)).toEqual(['Send Alex the plots']);
  });
  it('reordering the board: live columns in the new order, archived ones after; one undo step; no-op if unchanged', () => {
    const ids = st().projects.map((p) => p.id);
    const live = st().projects.filter((p) => !p.archived).map((p) => p.id);
    const depth = st().past.length;
    st().reorderProjects([...live].reverse());
    expect(st().projects.filter((p) => !p.archived).map((p) => p.id)).toEqual([...live].reverse());
    expect(st().projects.length).toBe(ids.length);
    expect(st().past.length).toBe(depth + 1);
    st().reorderProjects([...live].reverse());
    expect(st().past.length).toBe(depth + 1);
    st().undo();
    expect(st().projects.map((p) => p.id)).toEqual(ids);
  });
  it('the pane keeps a history: back, forward, and a new page drops the forward ones', () => {
    st().closePane();
    st().openPane({ k: 'project', id: 'a' });
    st().openPane({ k: 'thread', id: 'b' });
    st().openPane({ k: 'thread', id: 'b' }); // the same page again: no new step
    expect(st().projectNav.hist.length).toBe(2);
    st().stepPane(-1);
    expect(st().projectNav.hist[st().projectNav.i]).toEqual({ k: 'project', id: 'a' });
    st().openPane({ k: 'waiting' });
    expect(st().projectNav.hist.map((v) => v.k)).toEqual(['project', 'waiting']);
    st().closePane();
    expect(st().projectNav.i).toBe(-1);
  });
});
