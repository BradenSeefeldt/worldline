// Calendars on the Mac, end to end: the real store and runner (data/macCalendars.ts) against a fake Calendar app
// (standing in for src-tauri/src/eventkit.rs) — connect, changes both ways, deleting, a new event tied to its copy
// there, and the brake on deleting many at once.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MacEvent, MacSave } from '../lib/macCalendars';

// ---- the fake Mac: its database (src-tauri/src/db.rs, for the app's own saving) and its Calendar app
const kv = new Map<string, string>();
const cal = { id: 'IC-HOME', title: 'Home', color: '#ff2d55', account: 'iCloud', writable: true };
let mac: MacEvent[] = [];
let nextId = 1;
const invoke = vi.fn(async (cmd: string, a: Record<string, unknown> = {}) => {
  switch (cmd) {
    case 'db_get': return kv.get(String(a.key)) ?? null;
    case 'db_set': return void kv.set(String(a.key), String(a.value));
    case 'db_del': return void kv.delete(String(a.key));
    case 'ek_status': return 'full';
    case 'ek_calendars': return [cal];
    case 'ek_events': return mac.filter((e) => (a.calendars as string[]).includes(e.calendar)).map((e) => ({ ...e }));
    case 'ek_save': {
      const s = a.event as MacSave;
      const body = { calendar: s.calendar, title: s.title, start: s.start, end: s.end, all_day: s.all_day, location: s.location ?? null, notes: s.notes ?? null, url: s.url ?? null };
      if (s.ext) {
        mac = mac.map((e) => (e.ext === s.ext ? { ...e, ...body } : e));
        return s.ext;
      }
      const ext = `NEW-${nextId++}`;
      mac.push({ ext, occ: s.start, recurring: !!s.rule, ...body });
      return ext;
    }
    case 'ek_delete':
      mac = mac.filter((e) => e.ext !== a.ext);
      return null;
  }
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, a?: Record<string, unknown>) => invoke(cmd, a) }));

const noop = () => {};
const storage = { getItem: () => null, setItem: noop, removeItem: noop };
Object.assign(globalThis, {
  localStorage: storage,
  window: { __TAURI_INTERNALS__: {}, innerWidth: 1200, localStorage: storage, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) },
  document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
});

let useStore: typeof import('./store').useStore;
let mc: typeof import('./macCalendars');
const t = (d: number, h: number) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + d, h).getTime();
const ev = (ext: string, title: string, d: number): MacEvent => ({ ext, occ: t(d, 10), calendar: cal.id, title, start: t(d, 10), end: t(d, 11), all_day: false, recurring: false });
const titles = () => useStore.getState().events.filter((e) => e.calendarId === 'mac:IC-HOME').map((e) => e.title).sort();
const macTitles = () => mac.map((e) => e.title).sort();
const settle = async () => {
  await mc.syncMacCalendars();
  await new Promise((r) => setTimeout(r, 30));
};

beforeAll(async () => {
  ({ useStore } = await import('./store'));
  mc = await import('./macCalendars');
  useStore.getState().startFresh();
  mac = [ev('E1', 'Group meeting', 1), ev('E2', 'Dentist', 2), ...Array.from({ length: 8 }, (_, i) => ev(`R${i}`, `Seminar ${i}`, 3 + i))];
});

describe('a calendar on this Mac, in Worldline', () => {
  it('connecting: the calendar and its events come in', async () => {
    await mc.showMacCalendar(cal, true);
    await settle();
    expect(useStore.getState().calendars.find((c) => c.id === 'mac:IC-HOME')).toMatchObject({ name: 'Home', account: 'iCloud', mac: { id: 'IC-HOME', writable: true } });
    expect(titles()).toEqual(macTitles());
  });
  it('an edit in Worldline reaches the Calendar app', async () => {
    const e = useStore.getState().events.find((x) => x.title === 'Dentist')!;
    useStore.getState().updateEvent(e.id, { title: 'Dentist (Dr. Lee)', location: 'Bloor St' });
    await settle();
    expect(mac.find((x) => x.ext === 'E2')).toMatchObject({ title: 'Dentist (Dr. Lee)', location: 'Bloor St' });
    expect(titles()).toEqual(macTitles());
  });
  it('a change in the Calendar app reaches Worldline (same event: its id stays)', async () => {
    const id = useStore.getState().events.find((x) => x.title === 'Group meeting')!.id;
    mac = mac.map((x) => (x.ext === 'E1' ? { ...x, title: 'Group meeting (room 1203)', start: t(1, 14), end: t(1, 15) } : x));
    await settle();
    expect(useStore.getState().events.find((x) => x.id === id)).toMatchObject({ title: 'Group meeting (room 1203)', start: t(1, 14) });
  });
  it('a new event in that calendar is created in the Calendar app and tied to it', async () => {
    const id = useStore.getState().createEvent({ calendarId: 'mac:IC-HOME', title: 'Lunch with Sam', start: t(2, 12), end: t(2, 13), allDay: false });
    await settle();
    expect(mac.some((x) => x.title === 'Lunch with Sam')).toBe(true);
    expect(useStore.getState().events.find((x) => x.id === id)?.ext?.id).toMatch(/^NEW-/);
    await settle(); // a second look: no duplicate
    expect(titles().filter((x) => x === 'Lunch with Sam')).toHaveLength(1);
  });
  it('deleting one in Worldline deletes it in the Calendar app; deleting one there removes it here', async () => {
    useStore.getState().deleteEvent(useStore.getState().events.find((x) => x.title === 'Lunch with Sam')!.id);
    await settle();
    expect(macTitles()).not.toContain('Lunch with Sam');
    mac = mac.filter((x) => x.ext !== 'E1');
    await settle();
    expect(titles()).not.toContain('Group meeting (room 1203)');
    expect(titles()).toEqual(macTitles());
  });
  it('many deleted here at once (an old backup restored…): nothing is deleted there; they come back', async () => {
    const before = macTitles();
    useStore.setState((s) => ({ events: s.events.filter((e) => !e.title.startsWith('Seminar')) }));
    await settle();
    await settle();
    expect(macTitles()).toEqual(before);
    expect(titles()).toEqual(before);
  });
  it('the calendar comes back empty for a moment (iCloud refreshing): nothing here disappears', async () => {
    const saved = mac;
    const before = titles();
    mac = [];
    await settle();
    expect(titles()).toEqual(before);
    mac = saved;
    await settle();
    expect(titles()).toEqual(macTitles());
  });
  it('stop showing it: its events leave Worldline only — the Calendar app keeps everything', async () => {
    const before = macTitles();
    await mc.showMacCalendar(cal, false);
    await settle();
    expect(titles()).toEqual([]);
    expect(macTitles()).toEqual(before);
  });
});
