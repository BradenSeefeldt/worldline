// Guards in the store: events never move into a read-only calendar (a subscription's refresh would wipe them), there's
// always a calendar new events can go into, and saved data (or a backup) can't break loading.
import { beforeAll, describe, expect, it } from 'vitest';

const noop = () => {};
let writes = 0;
const storage = { getItem: () => null, setItem: () => void writes++, removeItem: noop };
Object.assign(globalThis, {
  localStorage: storage,
  window: { innerWidth: 1200, localStorage: storage, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) },
  document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
});
let S: typeof import('./store');
const st = () => S.useStore.getState();
const sub = { id: 'sub-1', name: 'Seminars', color: '#888', visible: true, account: 'Subscribed', url: 'https://example.org/feed.ics' };
const t = (h: number) => new Date(2026, 9, 20, h).getTime();

beforeAll(async () => {
  S = await import('./store');
});
const fresh = () => {
  st().startFresh();
  S.useStore.setState((s) => ({ calendars: [...s.calendars, sub] }));
  return st().createEvent({ calendarId: 'personal', title: 'Mine', start: t(10), end: t(11), allDay: false });
};

describe('read-only calendars', () => {
  it('a calendar’s events can’t be “moved” into a subscription when it’s deleted', () => {
    fresh();
    S.useStore.setState((s) => ({ calendars: [...s.calendars, { id: 'work', name: 'Work', color: '#f00', visible: true, account: 'Local' }] }));
    st().deleteCalendar('personal', 'sub-1');
    expect(st().calendars.some((c) => c.id === 'personal')).toBe(true);
    expect(st().events.find((e) => e.title === 'Mine')?.calendarId).toBe('personal');
  });
  it('an event can’t be moved into a subscription', () => {
    const id = fresh();
    st().updateEvent(id, { calendarId: 'sub-1' });
    expect(st().events.find((e) => e.id === id)?.calendarId).toBe('personal');
  });
  it('a new event aimed at a subscription goes to a calendar you can write to', () => {
    fresh();
    const id = st().createEvent({ calendarId: 'sub-1', title: 'Quick add #seminars', start: t(12), end: t(13), allDay: false });
    expect(st().events.find((e) => e.id === id)?.calendarId).toBe('personal');
  });
});

describe('always a calendar for new events', () => {
  it('the last writable calendar can’t be deleted while only a subscription would be left', () => {
    fresh();
    st().deleteCalendar('personal', null);
    expect(st().calendars.map((c) => c.id)).toContain('personal');
  });
  it('removing the last Mac calendar brings back a calendar of your own', () => {
    st().startFresh();
    S.useStore.setState({ calendars: [{ id: 'mac:X', name: 'Home', color: '#0a0', visible: true, account: 'iCloud', mac: { id: 'X', host: 'h', writable: true } }] });
    st().removeMacCalendar('mac:X');
    expect(st().calendars.map((c) => c.id)).toEqual(['personal']);
  });
  it('choosing a calendar for a new event never throws, even with none', () => {
    expect(S.newEventCalendarId({ calendars: [], defaultCalendarId: 'x' })).toBe('personal');
    expect(S.newEventCalendarId({ calendars: [sub], defaultCalendarId: 'sub-1' })).toBe('personal');
  });
});

describe('loading saved data (or a backup)', () => {
  const current = { view: 'week' as const, hourH: 48, page: 'calendar' as const };
  it('keeps only valid fields and records; damaged ones don’t load', () => {
    const c = S.cleanSaved({
      events: [null, 7, { id: 'ok', calendarId: 'personal', start: 1, end: 2 }, { id: 'bad', calendarId: 'personal', start: 'x' }],
      calendars: [],
      view: 'decade',
      hourH: 1e9,
      undo: 'not a function', // not a saved field: ignored
      settings: 5,
    }, current);
    expect(c.events?.map((e) => e.id)).toEqual(['ok']);
    expect(c.calendars?.map((x) => x.id)).toEqual(['personal']); // none left → one of your own
    expect(c.view).toBe('week');
    expect(c.hourH).toBe(48);
    expect('undo' in c).toBe(false);
  });
  it('a valid file loads as it is', () => {
    const c = S.cleanSaved({ events: [{ id: 'a', calendarId: 'personal', start: 1, end: 2, title: 'A' }], view: 'month', myName: 'Sam' }, current);
    expect(c).toMatchObject({ view: 'month', myName: 'Sam', events: [{ id: 'a', title: 'A' }] });
  });
});

describe('saving', () => {
  it('changes that touch nothing saved (a toast, a selection) aren’t saved; a burst of edits is saved once', async () => {
    const persist = await import('./persist');
    fresh();
    await persist.flush();
    writes = 0;
    for (let i = 0; i < 50; i++) st().showToast(`toast ${i}`);
    st().select(null);
    await persist.flush();
    expect(writes).toBe(0);
    const id = st().createEvent({ calendarId: 'personal', title: 'A', start: t(9), end: t(10), allDay: false });
    for (let i = 0; i < 30; i++) st().updateEvent(id, { title: `A${i}` }, true);
    await new Promise((r) => setTimeout(r, 400));
    expect(writes).toBe(1);
  });
});

describe('undo', () => {
  it('a new-event draft is one undo step even with a full undo history; ⌘Z with it open takes it away', () => {
    fresh();
    for (let i = 0; i < 60; i++) st().createEvent({ calendarId: 'personal', title: `E${i}`, start: t(1), end: t(2), allDay: false });
    const n = st().events.length;
    st().startDraft({ calendarId: 'personal', title: '', start: t(14), end: t(15), allDay: false });
    st().confirmDraft();
    expect(st().events.length).toBe(n + 1);
    st().undo();
    expect(st().events.length).toBe(n); // one ⌘Z: gone
    st().startDraft({ calendarId: 'personal', title: '', start: t(16), end: t(17), allDay: false });
    st().undo(); // with the draft open
    expect(st().pendingId).toBeNull();
    expect(st().events.length).toBe(n);
  });
  it('showing / hiding a calendar or a Mac calendar coming and going isn’t reverted by undoing an older edit', () => {
    const id = fresh();
    st().updateEvent(id, { title: 'Edited' });
    st().toggleCalendar('sub-1');
    st().addMacCalendar({ id: 'mac:X', name: 'Home', color: '#0a0', visible: true, account: 'iCloud', mac: { id: 'X', host: 'h', writable: true } });
    st().undo();
    expect(st().events.find((e) => e.id === id)?.title).toBe('Mine');
    expect(st().calendars.find((c) => c.id === 'sub-1')?.visible).toBe(false);
    expect(st().calendars.some((c) => c.id === 'mac:X')).toBe(true);
  });
});

describe('what goes with a deleted thing', () => {
  it('a deleted calendar: scheduling links stop pointing at it', () => {
    fresh();
    S.useStore.setState((s) => ({ calendars: [...s.calendars, { id: 'work', name: 'Work', color: '#f00', visible: true, account: 'Local' }] }));
    const lid = st().createLink('book');
    S.useStore.setState((s) => ({ links: s.links.map((l) => (l.id === lid ? { ...l, calendarId: 'work', blockingCalendars: ['work', 'personal'] } : l)) }));
    st().deleteCalendar('work', null);
    const l = st().links.find((x) => x.id === lid)!;
    expect(l.calendarId).toBe('personal');
    expect(l.blockingCalendars).toEqual(['personal']);
  });
  it('a deadline dropped from quick add takes its checklist steps with it', () => {
    fresh();
    const d = st().createEvent({ calendarId: 'personal', title: 'Grant report', kind: 'deadline', start: t(17), end: t(17), allDay: false });
    S.useStore.setState((s) => ({ tasks: [...s.tasks, { id: 'step', title: 'Budget', parentId: d, done: false } as never] }));
    st().applyChanges([], [d]);
    expect(st().tasks.some((x) => x.id === 'step')).toBe(false);
  });
  it('a deleted habit’s notes go too; typing an amount is one undo step', () => {
    fresh();
    const h = st().addHabit({ title: 'Read', kind: 'amount', goal: 20, unit: 'pages', period: 'day', color: '#00f' } as never);
    S.useStore.setState((s) => ({ habitNotes: { ...s.habitNotes, [h]: { 1: 'note' } } }));
    const before = st().past.length;
    st().setHabitAmount(h, 100, 1);
    st().setHabitAmount(h, 100, 12);
    expect(st().past.length).toBe(before + 1);
    st().deleteHabit(h);
    expect(st().habitNotes[h]).toBeUndefined();
  });
});
