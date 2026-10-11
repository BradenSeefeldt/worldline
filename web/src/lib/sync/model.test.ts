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
