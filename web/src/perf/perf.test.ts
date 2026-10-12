// Performance with ten years of data (perf/bigData.ts). Off in the normal suite (it takes ~1 min); run with
//   npm run test:perf          (PERF=1 TZ=America/Toronto vitest run src/perf --silent=false)
// Each measurement is the median of a few runs; budgets are ~3–5× what was measured on an Apple-silicon Mac (v0.10.0),
// so they catch regressions without flaking. PERF_OUT=<file> also writes the table as JSON.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import * as Y from 'yjs';
import { deflateSync } from 'fflate';
import { NOW_FOR_PERF } from './now';

const RUN = !!process.env.PERF;
const DAY = 86_400_000;

// ---- the app's environment, as in data/syncEngine.test.ts (node: no IndexedDB → localStorage)
const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const noop = () => {};
if (RUN)
  Object.assign(globalThis, {
    localStorage,
    window: { innerWidth: 1400, localStorage, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) },
    document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
  });

let gc: () => void = noop;
const heapMB = () => (gc(), gc(), process.memoryUsage().heapUsed / 1e6);

// ---- measuring
interface Row { op: string; data: string; ms: number; budget?: number; note?: string }
const rows: Row[] = [];
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function bench(op: string, data: string, fn: (i: number) => unknown, reps = 5, budget?: number) {
  fn(-1); // warm
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn(i);
    ts.push(performance.now() - t);
  }
  const ms = med(ts);
  rows.push({ op, data, ms, budget });
  if (budget !== undefined) expect(ms, `${op} took ${ms.toFixed(1)} ms (budget ${budget})`).toBeLessThan(budget);
  return ms;
}
async function benchAsync(op: string, data: string, fn: (i: number) => Promise<unknown>, reps = 3, budget?: number) {
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    await fn(i);
    ts.push(performance.now() - t);
  }
  const ms = med(ts);
  rows.push({ op, data, ms, budget });
  if (budget !== undefined) expect(ms, `${op} took ${ms.toFixed(1)} ms (budget ${budget})`).toBeLessThan(budget);
  return ms;
}
const note = (op: string, data: string, value: string) => rows.push({ op, data, ms: NaN, note: value });
const MB = (n: number) => `${(n / 1e6).toFixed(2)} MB`;

describe.runIf(RUN)('performance with ten years of data', () => {
  // modules are loaded after the environment above exists (store.ts reads `window` as it loads)
  let S: typeof import('../data/store');
  let P: typeof import('../data/persist');
  let M: typeof import('../lib/sync/model');
  let W: typeof import('../lib/sync/wire');
  let big: import('./bigData').BigState;
  let gen: typeof import('./bigData');
  const st = () => S.useStore.getState();

  beforeAll(async () => {
    setFlagsFromString('--expose_gc');
    gc = runInNewContext('gc') as () => void;
    vi.useFakeTimers({ toFake: ['Date'], now: NOW_FOR_PERF, shouldAdvanceTime: true });
    const h0 = heapMB();
    gen = await import('./bigData');
    S = await import('../data/store');
    P = await import('../data/persist');
    M = await import('../lib/sync/model');
    W = await import('../lib/sync/wire');
    await S.useStore.persist.rehydrate(); // (nothing saved yet: the app's first run)
    const h1 = heapMB();
    const t = performance.now();
    big = gen.bigState({ now: NOW_FOR_PERF });
    rows.push({ op: 'generate the dataset (test harness)', data: `${big.events.length} events`, ms: performance.now() - t });
    S.useStore.setState({ ...big, past: [], future: [] });
    const h2 = heapMB();
    note('heap: app modules loaded (demo data)', '', `${(h1 - h0).toFixed(0)} MB`);
    note('heap: + ten years of data in the store', `${big.events.length} events`, `${(h2 - h1).toFixed(0)} MB`);
  }, 120_000);

  afterAll(() => {
    if (!RUN) return;
    const line = (r: Row) => `| ${r.op} | ${r.data} | ${r.note ?? r.ms.toFixed(r.ms < 10 ? 2 : 0)} | ${r.budget ?? ''} |`;
    const table = ['| operation | data | ms (or value) | budget ms |', '|---|---|---|---|', ...rows.map(line)].join('\n');
    process.stdout.write('\n' + table + '\n');
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(rows, null, 1));
  });

  // ------------------------------------------------------------------ saving and loading
  it('saved state: size, serialise, parse, hydrate', async () => {
    const opts = S.useStore.persist.getOptions();
    const saved = opts.partialize!(st());
    let json = '';
    bench('JSON.stringify of the saved state', '', () => (json = JSON.stringify({ state: saved, version: opts.version })), 5, 120);
    note('saved state size', `${big.events.length} events`, MB(json.length));
    for (const k of Object.keys(saved as object)) {
      const n = JSON.stringify((saved as Record<string, unknown>)[k]).length;
      if (n > 100_000) note(`  saved state: ${k}`, '', MB(n));
    }
    bench('JSON.parse of the saved state', MB(json.length), () => JSON.parse(json), 5, 120);
    bench('persist.readable() (a full extra JSON.parse at every load)', MB(json.length), () => P.readable(json), 5, 120);
    bench('cleanSaved (merge: validate every record)', '', () => S.cleanSaved(JSON.parse(json).state, st()), 3, 150);
    mem.set('calendar-v1', json);
    await benchAsync('hydrate: persist.rehydrate() end to end', MB(json.length), async () => S.useStore.persist.rehydrate(), 3, 300);
    expect(st().events.length).toBe(big.events.length);
  }, 120_000);

  // ------------------------------------------------------------------ edits (what a keystroke / tap costs)
  it('actions: one edit, then the save it causes', async () => {
    const ev = st().events.find((e) => e.calendarId === 'research' && !e.recurrence && !e.kind)!;
    const task = st().tasks.find((t) => !t.done)!;
    const thread = st().threads.find((t) => t.status === 'active')!;
    const today = Math.round(Date.UTC(2026, 9, 12) / DAY);
    // fill the undo history first (50 steps), as after a while of use
    for (let i = 0; i < 60; i++) st().updateEvent(ev.id, { location: `Room ${i}` });
    expect(st().past.length).toBe(50);
    const ms = {
      add: bench('add an event (createEvent)', '50 undo steps', (i) => st().createEvent({ calendarId: 'personal', title: `New ${i}`, start: Date.now(), end: Date.now() + 3_600_000, allDay: false }), 9, 30),
      key: bench('keystroke in an event title (updateEvent, coalesced)', '', (i) => st().updateEvent(ev.id, { title: `Title ${i}` }, true), 9, 30),
      habit: bench('tick a habit (setHabitAmount)', '', (i) => st().setHabitAmount('h-3', today, i % 2), 9, 20),
      task: bench('keystroke in a task title (updateTask)', '', (i) => st().updateTask(task.id, { title: `Task ${i}` }), 9, 20),
      page: bench('keystroke in a project page (updateThread body)', '', (i) => st().updateThread(thread.id, { body: { ...thread.body!, content: [...thread.body!.content!, { type: 'paragraph', content: [{ type: 'text', text: `x${i}` }] }] } }, true), 9, 20),
      toast: bench('UI-only change (showToast): skipped by the save', '', (i) => st().showToast(`t${i}`), 9, 5),
    };
    // the save each burst of changes causes, 250 ms later (store.ts handOver → JSON.stringify of everything)
    bench('save after an edit: store debounce → JSON.stringify (sync part of persist.flush)', '', (i) => {
      st().setHabitAmount('h-4', today, i % 2);
      void P.flush();
    }, 5, 150);
    await P.flush();
    note('saved string written per save (every edit burst; Mac: also through IPC into SQLite)', '', MB(mem.get('calendar-v1')!.length));
    expect(ms.toast).toBeLessThan(ms.key + 1);
  }, 120_000);

  it('undo history: memory held by 50 steps of event edits', () => {
    const ev = st().events.find((e) => e.calendarId === 'teaching' && !e.recurrence)!;
    S.useStore.setState({ past: [], future: [] });
    const h0 = heapMB();
    for (let i = 0; i < 50; i++) st().updateEvent(ev.id, { title: `Step ${i}` }); // each step: a new events array
    const h1 = heapMB();
    note('heap held by 50 undo steps (each a full copy of the events array)', `${st().events.length} events`, `${(h1 - h0).toFixed(1)} MB`);
    bench('undo (⌘Z)', '', () => (st().undo(), st().redo()), 5, 5);
  }, 60_000);

  // ------------------------------------------------------------------ what the views and the sidebar compute per change
  it('event expansion and per-change derived data', async () => {
    const { expand, decodeEvent } = await import('../lib/recurrence');
    const { upcomingAlerts } = await import('../lib/alerts');
    const H = await import('../lib/habits');
    const { bucketTasks } = await import('../lib/tasks');
    const { suggest } = await import('../lib/suggest');
    const events = st().events;
    const now = Date.now();
    const d0 = new Date(now);
    d0.setHours(0, 0, 0, 0);
    const today0 = d0.getTime();
    const n = `${events.length} events`;
    const week = bench('expand: TimeGrid week (3 weeks rendered: prev/this/next)', n, () => expand(events, today0 - 7 * DAY, today0 + 14 * DAY), 9, 120);
    const masters = events.filter((e) => e.recurrence), oneOffs = events.filter((e) => !e.recurrence);
    bench('  of which: the 30k one-off events (scan + decode)', `${oneOffs.length} events`, () => expand(oneOffs, today0 - 7 * DAY, today0 + 14 * DAY), 9, 30);
    bench('  of which: the series (most ended years ago, still walked)', `${masters.length} series`, () => expand(masters, today0 - 7 * DAY, today0 + 14 * DAY), 9, 120);
    const month = bench('expand: Month view / sidebar mini-month (42 days)', n, () => expand(events, today0 - 14 * DAY, today0 + 28 * DAY), 9, 30);
    const ahead = bench('expand: TimeGrid deadline ribbons (range + 120 days)', n, () => expand(events, today0 - 7 * DAY, today0 + 134 * DAY), 5, 30);
    const deadlines = bench('Sidebar Deadlines card: expand 520 days + filter', n, () => expand(events, today0 - 120 * DAY, today0 + 400 * DAY).filter((e) => e.kind === 'deadline' && !e.done).sort((a, b) => a.start - b.start), 5, 40);
    // components/Habits.tsx habitEvents + useHabitStats (cache keyed on the events array: every event edit misses it)
    const habits = st().habits, log = st().habitLog;
    const today = H.dayOf(now);
    const since = Math.min(today - 371, ...habits.map((h) => H.dayOf(h.createdAt)));
    const words = habits.map((h) => (h.match ?? '').trim().toLowerCase()).filter(Boolean);
    let past: typeof events = [];
    const habitEv = bench('Habits: filter by habit words + expand since the oldest habit (10 y)', n, () => {
      const relevant = events.filter((e) => { const t = (e.title ?? '').toLowerCase(); return words.some((w) => t.includes(w)); });
      past = expand(relevant, H.dateOfDay(since).getTime(), H.dateOfDay(today + 1).getTime());
    }, 5, 60);
    const habitStats = bench('Habits: credit + progress + strength + streak for 20 habits', `${past.length} matching occurrences`, () =>
      habits.map((h) => { const auto = H.calendarCredit(h, past, now); return [H.periodProgress(h, log, auto, today), H.strength(h, log, auto, today), H.streak(h, log, auto, today)]; }), 5, 80);
    rows.push({ op: '⇒ per event keystroke, calendar page (week + mini-month + ribbons + Deadlines + Habits card)', data: n, ms: week + month + ahead + deadlines + habitEv + habitStats });
    bench('Habits CSV export: expand ALL events since the oldest habit (Habits.tsx:26, unfiltered)', n, () => expand(events, H.dateOfDay(since).getTime(), H.dateOfDay(today + 1).getTime()), 1, 400);
    bench('alerts: upcomingAlerts (26 h window; 1.5 s after each events change)', n, () => upcomingAlerts(events, st().calendars, st().settings, now - 300_000, now + 26 * 3_600_000), 5, 100);
    bench('tasks: bucketTasks (sidebar Tasks card)', `${st().tasks.length} tasks`, () => bucketTasks(st().tasks, now), 9, 5);
    // QuickAdd (while open): its window + suggestions
    let window520: typeof events = [];
    bench('QuickAdd: expand 520 days + decode masters (on open, and per events change)', n, () => {
      window520 = expand(events, now - 120 * DAY, now + 400 * DAY);
      events.filter((e) => e.recurrence).map(decodeEvent);
    }, 3, 40);
    bench('QuickAdd: suggest() (empty box suggestions)', `${window520.length} occurrences`, () => suggest(window520, st().calendars, { skipped: st().skipped, dismissed: st().dismissed, tasks: st().tasks, habits, habitLog: log }), 3, 200);
  }, 180_000);

  it('quick add parsing', async () => {
    const { parseQuick } = await import('../lib/quickparse');
    const { parseCommand } = await import('../lib/commands');
    const { expand, decodeEvent } = await import('../lib/recurrence');
    const { tasksForCommands } = await import('../lib/tasks');
    const now = Date.now();
    const cals = st().calendars;
    bench('parseQuick: "lunch with Sam tomorrow 12:30 #social for 90 min"', '', () => parseQuick('lunch with Sam tomorrow 12:30 #social for 90 min', cals), 21, 5);
    const evs = expand(st().events, now - 120 * DAY, now + 400 * DAY);
    const withTasks = [...evs, ...tasksForCommands(st().tasks, now)];
    const masters = st().events.filter((e) => e.recurrence).map(decodeEvent);
    bench('parseCommand: "move gym to friday at 3" (per keystroke in QuickAdd)', `${withTasks.length} events+tasks`, () => parseCommand('move gym to friday at 3', withTasks, cals, new Date(), masters), 5, 20);
    bench('parseCommand: "delete dentist" ', `${withTasks.length} events+tasks`, () => parseCommand('delete dentist', withTasks, cals, new Date(), masters), 5, 100);
  }, 120_000);

  it('projects: search and the board', async () => {
    const Pj = await import('../lib/projects');
    const w = { projects: st().projects, threads: st().threads, projectLog: st().projectLog };
    const data = `${w.projects.length} projects, ${w.threads.length} threads, ${w.projectLog.length} notes`;
    let hits = 0;
    bench('Projects search "reconnection" (all)', data, () => (hits = Pj.search(w, 'reconnection').length), 5, 50);
    note('  hits', '', String(hits));
    bench('Projects search, no match', data, () => Pj.search(w, 'zzzqqq'), 5, 30);
    bench('Projects search within one project', data, () => Pj.search(w, 'reconnection', w.projects[10].id), 5, 5);
    bench('Projects board: columnOf + openItems + ideasOf for every live project, statusOf per tile', data, () => {
      for (const p of w.projects.filter((x) => !x.archived)) {
        const col = Pj.columnOf(w, p.id);
        Pj.openItems(w, p.id);
        Pj.ideasOf(w, p.id);
        for (const t of col.live) (Pj.statusOf(w, t), Pj.openItems(w, t.id));
      }
    }, 3, 80);
  }, 120_000);

  it('backup and .ics export', async () => {
    const { makeBackup, readBackup } = await import('../lib/backup');
    const { toIcs } = await import('../lib/icsExport');
    const opts = S.useStore.persist.getOptions();
    let text = '';
    bench('backup: makeBackup + JSON.stringify', '', () => (text = JSON.stringify(makeBackup(opts.partialize!(st()) as Record<string, unknown>, 2, 'perf'))), 3, 150);
    note('backup file size', '', `${MB(text.length)} (deflated ${MB(deflateSync(new TextEncoder().encode(text)).length)})`);
    bench('backup: readBackup (restore check)', MB(text.length), () => readBackup(text, 2), 3, 150);
    for (const id of ['research', 'sub-dept', 'mac:GOOGLE-WORK']) {
      const evs = st().events.filter((e) => e.calendarId === id);
      let ics = '';
      bench(`.ics export of "${id}"`, `${evs.length} events`, () => (ics = toIcs(id, evs)), 3, 300);
      note(`  .ics size "${id}"`, '', MB(ics.length));
    }
  }, 120_000);

  // ------------------------------------------------------------------ sync
  it('sync document: build, size, snapshot, catch-up, single edits', async () => {
    const keys = W.deriveSync(W.newSecret());
    const sk = W.newDeviceKey();
    const state = M.pick(st() as unknown as Record<string, unknown>);
    let doc = new Y.Doc();
    bench('sync: writeLocal(everything) into a new doc (turning sync on / a resume with no doc)', '', (i) => {
      doc = new Y.Doc();
      M.writeLocal(doc, null, state);
      void i;
    }, 3, 800);
    let bytes: Uint8Array = new Uint8Array();
    bench('sync: Y.encodeStateAsUpdate (saveDoc 1.5 s after every change; snapshot)', '', () => (bytes = Y.encodeStateAsUpdate(doc)), 5, 500);
    const packed = deflateSync(bytes);
    note('sync doc size: raw / deflated', '', `${MB(bytes.length)} / ${MB(packed.length)}`);
    let b64 = '';
    bench('sync: base64 of the doc (saveDoc → sideStore every 1.5 s after a change)', MB(bytes.length), () => {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      b64 = btoa(s);
    }, 3, 1000);
    note('  worldline-sync-doc stored string', '', MB(b64.length));
    let pieces: Awaited<ReturnType<typeof W.sealSnapshot>> = [];
    await benchAsync('sync: sealSnapshot (deflate + encrypt + sign pieces)', '', async () => (pieces = await W.sealSnapshot(bytes, keys, sk)), 1, 3000);
    note(`snapshot pieces (CHUNK 24 kB; receivers refuse n > ${W.MAX_PIECES})`, '', `${pieces.length} pieces = ${((pieces.length / W.MAX_PIECES) * 100).toFixed(0)}% of the cap`);
    expect(pieces.length).toBeLessThanOrEqual(W.MAX_PIECES);
    // catch-up on a fresh device: open every piece, assemble, apply, read back
    await benchAsync('sync: catch-up on a new device (open pieces → apply → readDoc)', `${pieces.length} pieces`, async () => {
      const asm = new W.SnapshotAssembler();
      const fresh = new Y.Doc();
      for (const ev of pieces) {
        const m = await W.openMessage(ev, keys);
        if (m?.kind === 'piece') {
          const whole = await asm.add(m);
          if (whole) Y.applyUpdate(fresh, whole, 'remote');
        }
      }
      const got = M.readDoc(fresh);
      expect(got.events!.length).toBe(state.events.length);
    }, 1, 2500);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, bytes);
    bench('sync: readDoc (whole doc → app state; also on each remote change, reusing records)', '', () => M.readDoc(fresh, state), 3, 300);

    // single edits: what goes out
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    let prev = state;
    const edit = (k: 'events' | 'tasks', i: number, patch: Record<string, unknown>) => {
      const list = prev[k] as { id: string }[];
      const next = { ...prev, [k]: list.map((r, j) => (j === i ? { ...r, ...patch } : r)) };
      M.writeLocal(doc, prev, next);
      prev = next;
    };
    bench('sync: writeLocal for one changed event title (per store change, while sync is on)', `${state.events.length} events`, (i) => edit('events', 100, { title: `Edit ${i}` }), 9, 25);
    note('  update size for one title edit', '', `${updates[updates.length - 1].length} B`);
    const habitNext = (i: number) => ({ ...prev, habitLog: { ...prev.habitLog, 'h-1': { ...prev.habitLog['h-1'], [99999]: i % 2 ? 1 : 2 } } });
    bench('sync: writeLocal for one habit tick', '', (i) => {
      const next = habitNext(i);
      M.writeLocal(doc, prev, next);
      prev = next;
    }, 9, 10);

    // growth: 500 edits then 500 deletes, each its own update (as typed over days)
    const base = Y.encodeStateAsUpdate(doc).length;
    for (let i = 0; i < 500; i++) edit('events', 1000 + i, { notes: `edited ${i} ${'x'.repeat(40)}` });
    const afterEdits = Y.encodeStateAsUpdate(doc).length;
    for (let i = 0; i < 500; i++) {
      const next = { ...prev, events: prev.events.filter((_, j) => j !== 2000) };
      M.writeLocal(doc, prev, next);
      prev = next;
    }
    const afterDeletes = Y.encodeStateAsUpdate(doc).length;
    note('doc growth: 500 field edits', '', `+${((afterEdits - base) / 1e3).toFixed(0)} kB (${((afterEdits - base) / 500).toFixed(0)} B per edit, the overwritten value is a tombstone)`);
    note('doc growth: 500 event deletions', '', `${((afterDeletes - afterEdits) / 1e3).toFixed(0)} kB (${((afterDeletes - afterEdits) / 500).toFixed(0)} B per deleted event)`);

    // sessions: each launch is a new Y.Doc with a new clientID; a session that edits adds its id to the doc for good
    let saved = Y.encodeStateAsUpdate(doc);
    const before = saved.length;
    let sv = 0;
    const t = performance.now();
    for (let s = 0; s < 300; s++) {
      const d = new Y.Doc();
      Y.applyUpdate(d, saved);
      const id = prev.events[s].id;
      (d.getMap('events').get(id) as Y.Map<unknown>).set('title', `Session ${s}`);
      saved = Y.encodeStateAsUpdate(d);
      sv = Y.encodeStateVector(d).length;
      d.destroy();
    }
    rows.push({ op: 'sync: 300 app launches each with one edit (load doc → edit → encode)', data: '', ms: (performance.now() - t) / 300, note: undefined });
    note('doc growth: 300 launch sessions with one edit each', '', `+${((saved.length - before) / 1e3).toFixed(0)} kB; state vector ${sv} B (${(sv / 300).toFixed(1)} B per session)`);
  }, 300_000);

  it('subscription refreshes: time, and what they leave in the sync doc', async () => {
    // refreshCalendar fetches the feed (stubbed here: the generated feed, a week later each time) and replaces the
    // calendar's events — mapped through all 50 undo steps too (beyondUndo)
    let week = 0;
    const sub = gen.SUBS[0];
    vi.stubGlobal('fetch', async () => new Response(gen.feedIcs(sub.name, sub.seed, Date.now(), week)));
    const { parseIcs } = await import('../lib/ics');
    const feed = gen.feedIcs(sub.name, sub.seed, Date.now(), 0);
    bench('parseIcs alone: a ~5k-event feed', MB(feed.length), () => parseIcs(feed, sub.id, Date.now() - 365 * DAY, Date.now() + 730 * DAY), 3, 300);
    for (let i = 0; i < 55; i++) st().updateEvent(st().events[i].id, { location: `L${i}` }); // a full undo history
    const doc = new Y.Doc();
    let prev = M.pick(st() as unknown as Record<string, unknown>);
    M.writeLocal(doc, null, prev);
    const size0 = Y.encodeStateAsUpdate(doc).length;
    const times: number[] = [], writes: number[] = [], ups: number[] = [];
    let upd = 0;
    doc.on('update', (u: Uint8Array) => (upd += u.length));
    for (week = 1; week <= 52; week++) {
      vi.setSystemTime(NOW_FOR_PERF + week * 7 * DAY);
      let t = performance.now();
      await st().refreshCalendar(sub.id);
      times.push(performance.now() - t);
      expect(st().calendars.find((c) => c.id === sub.id)?.syncError).toBeUndefined();
      const next = M.pick(st() as unknown as Record<string, unknown>);
      upd = 0;
      t = performance.now();
      M.writeLocal(doc, prev, next);
      writes.push(performance.now() - t);
      ups.push(upd);
      prev = next;
    }
    vi.unstubAllGlobals();
    vi.setSystemTime(NOW_FOR_PERF);
    const size1 = Y.encodeStateAsUpdate(doc).length;
    rows.push({ op: 'refreshCalendar (fetch stubbed): parse ~5k-event feed + replace + map 50 undo steps', data: '5k events', ms: med(times), budget: 3500 });
    expect(med(times)).toBeLessThan(3500);
    rows.push({ op: 'sync: writeLocal after a subscription refresh', data: '5k events', ms: med(writes), budget: 100 });
    expect(med(writes)).toBeLessThan(100);
    note('  sync update sent per weekly refresh (median)', '', `${(med(ups) / 1e3).toFixed(0)} kB`);
    note('doc growth: 52 weekly refreshes of one subscription', '', `+${((size1 - size0) / 1e3).toFixed(0)} kB raw (${((size1 - size0) / 52 / 1e3).toFixed(1)} kB/week; events rolling out of the window stay as tombstones)`);
  }, 300_000);

  it('sync engine running: edit cost and turn-on', async () => {
    const { startEngine } = await import('../data/syncEngine');
    const { memoryTransport } = await import('../lib/relays');
    const relay = memoryTransport();
    const cfg = { secret: W.newSecret(), device: W.newDeviceKey() };
    const t = performance.now();
    const engine = startEngine(cfg, relay, 'create');
    await engine.flush();
    rows.push({ op: 'sync engine: turn on (create) + first send + save of the doc', data: '', ms: performance.now() - t });
    const ev = st().events.find((e) => e.calendarId === 'personal' && !e.recurrence)!;
    bench('keystroke in an event title WITH sync on (store + writeLocal)', '', (i) => st().updateEvent(ev.id, { title: `Synced ${i}` }, true), 9, 35);
    bench('tick a habit WITH sync on', '', (i) => st().setHabitAmount('h-5', Math.round(Date.UTC(2026, 9, 12) / DAY), i % 2), 9, 10);
    await benchAsync('sync engine flush: merge + seal + send + saveDoc (encode + base64 + app save)', '', () => engine.flush(), 3, 60);
    note('relay messages stored after turn-on + edits', '', String(relay.events.length));
    engine.stop();
  }, 300_000);
});

it('perf suite is opt-in (PERF=1)', () => expect(true).toBe(true));
