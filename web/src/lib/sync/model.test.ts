import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { pick, readDoc, writeLocal, type Synced } from './model';

const base = (extra: Partial<Record<string, unknown>> = {}): Synced =>
  pick({
    calendars: [{ id: 'c', name: 'Research', color: '#00f', visible: true }],
    events: [{ id: 'e1', calendarId: 'c', title: 'Group meeting', start: 1000, end: 2000, allDay: false }],
    tasks: [], habits: [{ id: 'h', title: 'Gym' }], projects: [{ id: 'p1', title: 'A' }, { id: 'p2', title: 'B' }], threads: [], projectLog: [], links: [],
    habitLog: { h: { 20000: 1, 20001: 1 } }, habitNotes: {},
    myName: 'Sam', homeZone: 'America/Toronto', defaultCalendarId: 'c', skipped: [], dismissed: [],
    settings: { weekStartsOn: 1, hour24: false, theme: 'not-synced', keepRunning: true },
    ...extra,
  });
/** Two devices that have synced once. */
function pair() {
  const a = new Y.Doc(), b = new Y.Doc();
  const s0 = base();
  writeLocal(a, null, s0);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b, s0 };
}
const sync = (x: Y.Doc, y: Y.Doc) => {
  Y.applyUpdate(y, Y.encodeStateAsUpdate(x));
  Y.applyUpdate(x, Y.encodeStateAsUpdate(y));
};

describe('the app’s data as a synced document', () => {
  it('reads back exactly what was written (and only what syncs)', () => {
    const { b, s0 } = pair();
    const got = readDoc(b);
    expect(got.events).toEqual(s0.events);
    expect(got.habitLog).toEqual({ h: { 20000: 1, 20001: 1 } });
    expect(got.myName).toBe('Sam');
    expect(got.settings).toEqual({ weekStartsOn: 1, hour24: false });
    expect(got.settings).not.toHaveProperty('keepRunning'); // device-only settings stay on the device
  });
  it('different items edited offline on two devices: both edits survive', () => {
    const { a, b, s0 } = pair();
    const phone = { ...s0, events: [...s0.events, { id: 'e2', calendarId: 'c', title: 'Dentist', start: 5000, end: 6000, allDay: false }] };
    const mac = { ...s0, tasks: [{ id: 't1', title: 'Email Jordan' }] };
    writeLocal(b, s0, phone);
    writeLocal(a, s0, mac);
    sync(a, b);
    for (const d of [a, b]) {
      const got = readDoc(d);
      expect(got.events!.map((e) => e.id)).toEqual(['e1', 'e2']);
      expect(got.tasks!.map((t) => t.id)).toEqual(['t1']);
    }
  });
  it('different fields of one item: both survive; the same field: the later edit wins, on both devices', () => {
    const { a, b, s0 } = pair();
    const e = s0.events[0];
    writeLocal(b, s0, { ...s0, events: [{ ...e, title: 'Group meeting (moved)' }] });
    writeLocal(a, s0, { ...s0, events: [{ ...e, start: 3000, end: 4000 }] });
    sync(a, b);
    expect(readDoc(a).events![0]).toMatchObject({ title: 'Group meeting (moved)', start: 3000, end: 4000 });
    writeLocal(a, readDoc(a) as Synced, { ...(readDoc(a) as Synced), myName: 'Sam A' });
    writeLocal(b, readDoc(b) as Synced, { ...(readDoc(b) as Synced), myName: 'Sam B' });
    sync(a, b);
    expect(readDoc(a).myName).toBe(readDoc(b).myName); // both devices agree on one winner
  });
  it('a deletion syncs; a field cleared (undefined) is removed, not stored as null', () => {
    const { a, b, s0 } = pair();
    writeLocal(a, s0, { ...s0, events: [], habitLog: { h: { 20000: 1 } }, projects: [{ id: 'p1', title: 'A' }, { id: 'p2' } as never] });
    sync(a, b);
    const got = readDoc(b);
    expect(got.events).toEqual([]);
    expect(got.habitLog).toEqual({ h: { 20000: 1 } });
    expect(got.projects![1]).toEqual({ id: 'p2' });
  });
  it('reordering (the board’s columns) syncs', () => {
    const { a, b, s0 } = pair();
    writeLocal(a, s0, { ...s0, projects: [s0.projects[1], s0.projects[0]] });
    sync(a, b);
    expect(readDoc(b).projects!.map((p) => p.id)).toEqual(['p2', 'p1']);
  });
  it('unchanged records keep their identity when read back (the app redraws only what changed)', () => {
    const { a, s0 } = pair();
    const first = readDoc(a, s0);
    expect(first.events).toBe(s0.events);
    const next = { ...s0, events: [...s0.events, { id: 'e2', calendarId: 'c', title: 'X', start: 1, end: 2, allDay: false }] };
    writeLocal(a, s0, next);
    const second = readDoc(a, s0);
    expect(second.events![0]).toBe(s0.events[0]);
    expect(second.calendars).toBe(s0.calendars);
  });
  it('writing the same thing again sends nothing', () => {
    const { a, s0 } = pair();
    let updates = 0;
    a.on('update', () => updates++);
    writeLocal(a, s0, s0);
    writeLocal(a, null, s0);
    expect(updates).toBe(0);
  });
});

describe('writing only what changed here (another device’s newer changes may already be in the document)', () => {
  it('a stale copy of a field the other device changed is never written back; the field changed here is', () => {
    const { a, b, s0 } = pair();
    const e = s0.events[0];
    writeLocal(b, s0, { ...s0, events: [{ ...e, title: 'Group meeting (phone)' }], habitLog: { h: { 20000: 1, 20001: 3 } } });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); // in a's document, not yet in a's data (still s0)
    writeLocal(a, s0, { ...s0, events: [{ ...e, start: 3000 }], habitLog: { h: { 20000: 0, 20001: 1 } } });
    sync(a, b);
    for (const d of [a, b]) {
      expect(readDoc(d).events![0]).toMatchObject({ title: 'Group meeting (phone)', start: 3000 });
      expect(readDoc(d).habitLog).toEqual({ h: { 20000: 0, 20001: 3 } });
    }
  });
  it('a record deleted on another device stays deleted, even when it’s edited here meanwhile', () => {
    const { a, b, s0 } = pair();
    writeLocal(b, s0, { ...s0, projects: [s0.projects[1]], habitLog: {} });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    writeLocal(a, s0, { ...s0, projects: [{ ...s0.projects[0], title: 'A, edited' }, { ...s0.projects[1], title: 'B, edited' }], habitLog: { h: { 20000: 1, 20001: 1, 20002: 1 } } });
    sync(a, b);
    for (const d of [a, b]) {
      expect(readDoc(d).projects).toEqual([{ id: 'p2', title: 'B, edited' }]);
      expect(readDoc(d).habitLog).toEqual({ h: { 20002: 1 } });
    }
  });
  it('the same field edited on both devices: both settle on one value (Yjs picks it, not the clock)', () => {
    const { a, b, s0 } = pair();
    const e = s0.events[0];
    writeLocal(a, s0, { ...s0, events: [{ ...e, title: 'Mac' }] });
    writeLocal(b, s0, { ...s0, events: [{ ...e, title: 'Phone' }] });
    sync(a, b);
    expect(readDoc(a).events![0].title).toBe(readDoc(b).events![0].title);
  });
});

describe('list order', () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, calendarId: 'c', title: `Event ${i}`, start: i * 1000, end: i * 1000 + 500, allDay: false }));
  it('50 deletions in a 2,000-event document grow it by only a little (no positions are renumbered)', () => {
    const doc = new Y.Doc();
    let s = base({ events: big(2000) });
    writeLocal(doc, null, s);
    const before = Y.encodeStateAsUpdate(doc).length;
    for (let i = 0; i < 50; i++) {
      const next = { ...s, events: s.events.slice(1) };
      writeLocal(doc, s, next);
      s = next;
    }
    expect(Y.encodeStateAsUpdate(doc).length - before).toBeLessThan(1000);
  });
  it('events store no position at all', () => {
    const { a } = pair();
    expect((a.getMap('events').get('e1') as Y.Map<unknown>).has('_o')).toBe(false);
  });
  it('moving one column writes one new place, and concurrent moves and additions settle the same on both', () => {
    const doc = new Y.Doc();
    const p = (id: string) => ({ id, title: id });
    const s0 = base({ projects: ['a', 'b', 'c', 'd', 'e'].map(p) });
    writeLocal(doc, null, s0);
    let sets = 0;
    doc.on('update', (u: Uint8Array) => (sets += Y.decodeUpdate(u).structs.length));
    const moved = { ...s0, projects: [s0.projects[4], ...s0.projects.slice(0, 4)] }; // e to the front
    writeLocal(doc, s0, moved);
    expect(sets).toBe(1);
    expect(readDoc(doc).projects!.map((x) => x.id)).toEqual(['e', 'a', 'b', 'c', 'd']);
    // two devices: one moves a to the end, the other adds f after b
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const [e, a, b, c, d] = moved.projects;
    writeLocal(doc, moved, { ...moved, projects: [e, b, c, d, a] });
    writeLocal(other, moved, { ...moved, projects: [e, a, b, p('f'), c, d] });
    sync(doc, other);
    expect(readDoc(doc).projects!.map((x) => x.id)).toEqual(['e', 'b', 'f', 'c', 'd', 'a']);
    expect(readDoc(other).projects!.map((x) => x.id)).toEqual(['e', 'b', 'f', 'c', 'd', 'a']);
  });
  it('lists you don’t order keep this device’s order; new arrivals go at the end', () => {
    const { a, s0 } = pair();
    const mine = { ...s0, habits: [{ id: 'h2', title: 'Read' }, { id: 'h', title: 'Gym' }] };
    writeLocal(a, s0, mine);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(a));
    writeLocal(other, readDoc(other) as Synced, { ...(readDoc(other) as Synced), habits: [...(readDoc(other) as Synced).habits, { id: 'h0', title: 'Walk' }] });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(other));
    expect(readDoc(a, mine).habits!.map((h) => h.id)).toEqual(['h2', 'h', 'h0']);
  });
  it('documents from before (a position `_o` on every record) still read in their order, and aren’t renumbered', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      for (const [c, ids] of [['projects', ['p2', 'p1', 'p3']], ['habits', ['hb', 'ha']]] as const)
        ids.forEach((id, i) => {
          const y = new Y.Map();
          doc.getMap(c).set(id, y);
          y.set('id', id);
          y.set('title', id);
          y.set('_o', i);
        });
    });
    const got = readDoc(doc) as Synced;
    expect(got.projects.map((p) => p.id)).toEqual(['p2', 'p1', 'p3']);
    expect(got.habits.map((h) => h.id)).toEqual(['hb', 'ha']);
    expect(got.projects[0]).not.toHaveProperty('_o');
    let updates = 0;
    doc.on('update', () => updates++);
    writeLocal(doc, got, { ...got, projects: got.projects.filter((p) => p.id !== 'p1') });
    expect(updates).toBe(1);
    expect((doc.getMap('projects').get('p3') as Y.Map<unknown>).get('_o')).toBe(2);
  });
});
