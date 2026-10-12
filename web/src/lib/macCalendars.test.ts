// Calendars on the Mac, kept in step both ways: every case of what changed where.
import { describe, expect, it } from 'vitest';
import { calendarIdFor, fingerprint, fromMac, keyOf, reconcile, type MacEvent } from './macCalendars';
import { decodeEvent } from './recurrence';
import type { CalEvent } from '../data/types';

const t = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
const W = { from: t(1, 0), to: t(31, 0) };
const CAL = calendarIdFor('ICLOUD-1');
const cals = new Map([[CAL, 'ICLOUD-1']]);
const mac = (x: Partial<MacEvent> = {}): MacEvent => ({ ext: 'E1', occ: t(20, 14), calendar: 'ICLOUD-1', title: 'Group meeting', start: t(20, 14), end: t(20, 15), all_day: false, recurring: false, ...x });
const run = (events: CalEvent[], m: MacEvent[], known: Record<string, string> = {}) => reconcile(events, m, known, cals, W, decodeEvent);

/** The state after a first import of `m`. */
const imported = (m: MacEvent[]) => {
  const p = run([], m);
  return { events: p.events, known: p.known };
};

describe('from the Mac into Worldline', () => {
  it('first look: every event comes in, remembered as agreed; nothing is pushed', () => {
    const p = run([], [mac(), mac({ ext: 'E2', occ: t(21, 9), start: t(21, 9), end: t(21, 10), title: 'Dentist', location: 'Bloor St' })]);
    expect(p.events.map((e) => e.title).sort()).toEqual(['Dentist', 'Group meeting']);
    expect(p.events.find((e) => e.title === 'Dentist')).toMatchObject({ calendarId: CAL, location: 'Bloor St', ext: { id: 'E2' } });
    expect(p.pushes).toEqual([]);
    expect(Object.keys(p.known)).toHaveLength(2);
  });
  it('changed on the Mac: Worldline takes it, keeping its own id and extras (its alert)', () => {
    const s = imported([mac()]);
    s.events[0] = { ...s.events[0], alert: 5 };
    const p = run(s.events, [mac({ title: 'Group meeting (moved)', start: t(20, 16), end: t(20, 17) })], s.known);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]).toMatchObject({ id: s.events[0].id, title: 'Group meeting (moved)', start: t(20, 16), alert: 5 });
    expect(p.pushes).toEqual([]);
  });
  it('deleted on the Mac: removed from Worldline', () => {
    const s = imported([mac()]);
    const p = run(s.events, [], s.known);
    expect(p.events).toEqual([]);
    expect(p.pushes).toEqual([]);
    expect(p.known).toEqual({});
  });
  it('all-day events: whole local days, end exclusive (the Mac ends them at 23:59:59)', () => {
    const e = fromMac(mac({ all_day: true, start: t(22, 0), end: new Date(2026, 9, 23, 23, 59, 59).getTime() }));
    const d = decodeEvent(e);
    expect([d.start, d.end]).toEqual([t(22, 0), t(24, 0)]); // two days: the 22nd and the 23rd
  });
});

describe('from Worldline to the Mac', () => {
  it('changed only in Worldline: saved to that occurrence on the Mac', () => {
    const s = imported([mac()]);
    const edited = { ...s.events[0], title: 'Group meeting (room 1203)' };
    const p = run([edited], [mac()], s.known);
    expect(p.pushes).toEqual([{ op: 'save', key: keyOf(edited.ext!), fp: fingerprint(edited), save: expect.objectContaining({ ext: 'E1', occ: 0, calendar: 'ICLOUD-1', title: 'Group meeting (room 1203)' }) }]);
    expect(p.events[0].title).toBe('Group meeting (room 1203)'); // (kept until the Mac has it)
  });
  it('changed on both: the Mac wins', () => {
    const s = imported([mac()]);
    const p = run([{ ...s.events[0], title: 'Mine' }], [mac({ title: 'Theirs' })], s.known);
    expect(p.events[0].title).toBe('Theirs');
    expect(p.pushes).toEqual([]);
  });
  it('deleted in Worldline: deleted on the Mac', () => {
    const s = imported([mac()]);
    const p = run([], [mac()], s.known);
    expect(p.pushes).toEqual([{ op: 'delete', key: keyOf({ id: 'E1', occ: 0 }), ext: 'E1', occ: 0, calendar: 'ICLOUD-1' }]); // (a one-off event: named by its identifier alone)
    expect(p.events).toEqual([]);
  });
  it('new in a Mac calendar: created there (a repeating one as a repeating event)', () => {
    const one: CalEvent = { id: 'w1', calendarId: CAL, title: 'Lunch with Sam', start: t(22, 12), end: t(22, 13), allDay: false };
    const weekly: CalEvent = { id: 'w2', calendarId: CAL, title: 'Reading group', start: t(23, 10), end: t(23, 11), allDay: false, recurrence: { freq: 'weekly', interval: 1, byDay: [5] } };
    const p = run([one, weekly], []);
    expect(p.pushes).toEqual([
      expect.objectContaining({ op: 'create', localId: 'w1', repeating: false, save: expect.objectContaining({ calendar: 'ICLOUD-1', title: 'Lunch with Sam', start: t(22, 12) }) }),
      expect.objectContaining({ op: 'create', localId: 'w2', repeating: true, save: expect.objectContaining({ rule: { freq: 'weekly', interval: 1, by_day: [5] } }) }),
    ]);
  });
  it('moved from a Mac calendar to one of Worldline’s own: deleted on the Mac, kept here as Worldline’s', () => {
    const s = imported([mac()]);
    const moved = { ...s.events[0], calendarId: 'personal' };
    const p = run([moved], [mac()], s.known);
    expect(p.pushes.map((x) => x.op)).toEqual(['delete']);
    expect(p.events).toEqual([expect.objectContaining({ id: moved.id, calendarId: 'personal', ext: undefined })]);
  });
  it('moved between two Mac calendars: saved with the new calendar', () => {
    const two = new Map([[CAL, 'ICLOUD-1'], [calendarIdFor('GOOGLE-2'), 'GOOGLE-2']]);
    const first = reconcile([], [mac()], {}, two, W, decodeEvent);
    const moved = { ...first.events[0], calendarId: calendarIdFor('GOOGLE-2') };
    const p = reconcile([moved], [mac()], first.known, two, W, decodeEvent);
    expect(p.pushes).toEqual([expect.objectContaining({ op: 'save', save: expect.objectContaining({ calendar: 'GOOGLE-2', ext: 'E1' }) })]);
  });
});

describe('what is never touched', () => {
  it('events outside the window, and calendars not kept in step', () => {
    const s = imported([mac()]);
    const old: CalEvent = { ...s.events[0], id: 'old', ext: { id: 'E9', occ: t(1, 0) - 90 * 86_400_000 }, start: t(1, 0) - 90 * 86_400_000, end: t(1, 1) - 90 * 86_400_000 };
    const other: CalEvent = { id: 'p1', calendarId: 'personal', title: 'Mine', start: t(20, 9), end: t(20, 10), allDay: false };
    const p = run([...s.events, old, other], [mac()], s.known);
    expect(p.events.map((e) => e.id).sort()).toEqual([s.events[0].id, 'old', 'p1'].sort());
    expect(p.pushes).toEqual([]);
  });
  it('a second look with nothing changed: nothing to do', () => {
    const s = imported([mac(), mac({ ext: 'E2', occ: t(21, 9), start: t(21, 9), end: t(21, 10) })]);
    const p = run(s.events, [mac(), mac({ ext: 'E2', occ: t(21, 9), start: t(21, 9), end: t(21, 10) })], s.known);
    expect(p.pushes).toEqual([]);
    expect(p.events).toEqual(s.events);
  });
  it('a repeating event on the Mac: each occurrence separately; editing one saves just that one', () => {
    const occ = (d: number) => mac({ occ: t(d, 14), start: t(d, 14), end: t(d, 15), recurring: true });
    const s = imported([occ(6), occ(13), occ(20)]);
    expect(s.events).toHaveLength(3);
    expect(s.events.every((e) => e.ext?.recurring)).toBe(true);
    const edited = s.events.map((e) => (e.ext!.occ === t(13, 14) ? { ...e, start: t(13, 16), end: t(13, 17) } : e));
    const p = run(edited, [occ(6), occ(13), occ(20)], s.known);
    expect(p.pushes).toEqual([expect.objectContaining({ op: 'save', save: expect.objectContaining({ ext: 'E1', occ: t(13, 14), start: t(13, 16) }) })]);
  });
  it('moved far ahead in Worldline (past the window): saved there, never taken as deleted', () => {
    const s = imported([mac()]);
    const later = { ...s.events[0], start: t(20, 14) + 500 * 86_400_000, end: t(20, 15) + 500 * 86_400_000 };
    const p = run([later], [mac()], s.known);
    expect(p.pushes).toEqual([expect.objectContaining({ op: 'save', save: expect.objectContaining({ start: later.start }) })]);
    expect(p.events).toEqual([later]);
  });
  it('a one-off event moved on the Mac stays the same event (its id and extras), however its start changes', () => {
    const s = imported([mac()]);
    const p = run(s.events, [mac({ occ: t(22, 9), start: t(22, 9), end: t(22, 10) })], s.known); // (the Mac reports the new start)
    expect(p.events).toEqual([expect.objectContaining({ id: s.events[0].id, start: t(22, 9) })]);
    expect(p.pushes).toEqual([]);
  });
  it('a Mac calendar left out of a round (another Mac’s, or one sitting it out) keeps its events tied: no duplicates', () => {
    const s = imported([mac()]);
    const p = reconcile(s.events, [], s.known, new Map(), W, decodeEvent); // (no calendars in step this round)
    expect(p.events).toEqual(s.events);
    expect(p.pushes).toEqual([]);
  });
});
