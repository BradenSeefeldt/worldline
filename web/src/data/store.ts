// Central app state. Views read from here and call these actions; later the event
// actions will also talk to the NAS server (which syncs with Google Calendar).
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { addDays, addMonths, startOfDay, startOfMonth } from 'date-fns';
import type { CalEvent, CalendarSource, Range, ViewMode } from './types';
import { DEFAULT_CALENDARS, DEMO_HABIT_IDS, makeDemoEvents, makeDemoHabits, makeDemoProjects, makeDemoTasks } from './mock';
import { appendItem, docOf, emptyDoc, isEmptyDoc, migrateV1, removeAt, setAttrsAt, textToDoc, todaysNote, todoNode, type DocNode, type IdeaRow, type LogEntry, type Project, type Source, type Thread } from '../lib/projects';
import type { Habit, HabitLog, HabitNotes } from '../lib/habits';
import type { ThemeId } from '../lib/theme';
import { seriesKey, type Skip } from '../lib/suggest';
import { encodeEvent, resolveEvent } from '../lib/recurrence';
import { encodeDay, localZone } from '../lib/zone';
import type { Task } from '../lib/tasks';
import { isFinished, newLink, type BookingLink, type LinkMode, type PollResponse } from '../lib/booking';
import { newLinkKeys, type Accept, type Decision } from '../lib/schedwire';
import { endSeries, removeEvent, updateEvent, type Scope } from '../lib/mutate';
import { normalizeFeedUrl, parseIcs } from '../lib/ics';
import { fetchText, isApp } from '../lib/platform';
import { appStorage } from './persist';

export const DRAFT_ID = '__draft__';
export const DAYS_IN_VIEW: Record<Exclude<ViewMode, 'month'>, number> = { day: 1, '3day': 3, week: 7 };
export const HOUR_H_RANGE = [26, 160] as const;

/** Calendar for new events: the starred default, unless it's hidden. */
export const newEventCalendarId = (s: { calendars: CalendarSource[]; defaultCalendarId: string }) => {
  const mine = s.calendars.filter((c) => !c.url); // subscribed calendars are read-only
  return (mine.find((c) => c.id === s.defaultCalendarId && c.visible) ?? mine.find((c) => c.visible) ?? mine[0] ?? s.calendars[0]).id;
};
/** Is this event from a subscribed (read-only) calendar? */
export const isLocked = (s: { events: CalEvent[]; calendars: CalendarSource[] }, id: string) => {
  const ev = resolveEvent(s.events, id);
  return !!ev && !!s.calendars.find((c) => c.id === ev.calendarId)?.url;
};

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

interface Toast {
  id: number;
  text: string;
  undo: boolean;
  editId?: string; // offer an "Edit" button that opens this event
}

export interface BlockDrag {
  kind: 'task' | 'deadline';
  id: string;
  title: string;
  x: number; // pointer position (viewport)
  y: number;
  origin: { x: number; y: number }; // where it was picked up, to fly back to if dropped elsewhere
  over: boolean; // over the hour grid (the grid shows the block; the floating card fades)
  phase: 'drag' | 'drop' | 'return';
}

interface Snapshot {
  events: CalEvent[];
  calendars: CalendarSource[];
  tasks: Task[];
  habits: Habit[];
  habitLog: HabitLog;
  habitNotes: HabitNotes;
  projects: Project[];
  threads: Thread[];
  projectLog: LogEntry[];
}
const snap = (s: Snapshot): Snapshot => ({
  events: s.events, calendars: s.calendars, tasks: s.tasks, habits: s.habits, habitLog: s.habitLog, habitNotes: s.habitNotes,
  projects: s.projects, threads: s.threads, projectLog: s.projectLog,
});

/** "That's from a subscribed calendar": shown when something tries to change one of its events. */
function lockedToast(get: () => State, id: string) {
  const ev = resolveEvent(get().events, id);
  const cal = get().calendars.find((c) => c.id === ev?.calendarId);
  get().showToast(`“${ev?.title}” is from ${cal?.name ?? 'a subscribed calendar'} (subscribed) — it can only be changed at its source`, false);
}

/** What's open in the pane beside the Projects board. */
export interface PaneView {
  k: 'thread' | 'project' | 'waiting' | 'search';
  id?: string;
  q?: string;
  pid?: string; // search: only this project
}
/** A note or edit counts as touching its thread. */
const touch = (threads: Thread[], id: string, now: number) => threads.map((t) => (t.id === id ? { ...t, updatedAt: now } : t));
/** Change one document (a page body or a note), wherever it lives. */
function withDoc(s: Pick<State, 'threads' | 'projects' | 'projectLog'>, src: Source, fn: (d: DocNode) => DocNode): Partial<State> {
  const now = Date.now();
  if (src.entry) return { projectLog: s.projectLog.map((e) => (e.id === src.entry ? { ...e, doc: fn(e.doc) } : e)), threads: touch(s.threads, src.owner, now) };
  if (s.threads.some((t) => t.id === src.owner)) return { threads: s.threads.map((t) => (t.id === src.owner ? { ...t, body: fn(t.body ?? emptyDoc()), updatedAt: now } : t)) };
  return { projects: s.projects.map((p) => (p.id === src.owner ? { ...p, doc: fn(p.doc ?? emptyDoc()) } : p)) };
}

/** Change today's note on a page (making it if there isn't one yet). */
function withTodayNote(s: Pick<State, 'threads' | 'projects' | 'projectLog'>, parentId: string, fn: (d: DocNode | undefined) => DocNode): Partial<State> {
  const now = Date.now();
  const e = todaysNote(s.projectLog, parentId, now);
  if (e) return { projectLog: s.projectLog.map((x) => (x === e ? { ...x, doc: fn(x.doc) } : x)), threads: touch(s.threads, parentId, now) };
  return { projectLog: [...s.projectLog, { id: newId(), parentId, at: now, doc: fn(undefined) }], threads: touch(s.threads, parentId, now) };
}

export const CALENDAR_COLORS = [
  '#2f7cf6', '#8e5cf7', '#20b26b', '#f29a1d', '#ef4b4b', '#e45db0',
  '#14a8b8', '#7a8a99', '#a0732f', '#5b6ef0', '#2e9e4e', '#d4a20b',
];

interface State {
  calendars: CalendarSource[];
  events: CalEvent[];
  tasks: Task[];
  habits: Habit[];
  habitLog: HabitLog;
  habitNotes: HabitNotes;
  setHabitNote: (id: string, day: number, text: string) => void;
  page: 'calendar' | 'habits' | 'projects'; // the calendar, the Habits page, or the Projects board
  /** The page open beside the Projects board, with back / forward history (not saved). */
  projectNav: { hist: PaneView[]; i: number };
  openPane: (v: PaneView) => void;
  closePane: () => void;
  stepPane: (dir: 1 | -1) => void;
  projects: Project[];
  threads: Thread[];
  projectLog: LogEntry[];
  addProject: (title: string, color: string) => string;
  /** `typing` folds a burst of keystrokes into one undo step. */
  updateProject: (id: string, patch: Partial<Project>, typing?: boolean) => void;
  deleteProject: (id: string) => void;
  /** The board's column order (live projects, left to right); archived ones keep their place at the end. */
  reorderProjects: (ids: string[]) => void;
  addThread: (projectId: string, title: string, body?: DocNode) => string;
  /** Any change counts as touching the thread (updatedAt). */
  updateThread: (id: string, patch: Partial<Thread>, typing?: boolean) => void;
  deleteThread: (id: string) => void;
  /** A new dated note (today) on a thread or project. Returns its id. */
  addLog: (parentId: string, doc: DocNode) => string;
  updateLog: (id: string, doc: DocNode) => void;
  deleteLog: (id: string) => void;
  /** Tick (or untick) a to-do where it was written, from wherever it's shown. */
  setChecked: (s: Source, path: number[], checked: boolean) => void;
  /** Settle a "Q:" (or mark an "Idea:" as started). */
  setResolved: (s: Source, path: number[], resolved: boolean) => void;
  /** An action item: added to today's note on that page (made if needed), as a to-do. */
  addTodo: (parentId: string, text: string) => void;
  /** File a to-do (with anything waiting under it) into another page's notes for today. */
  moveItem: (s: Source, path: number[], toId: string) => void;
  addIdea: (projectId: string, text: string) => void;
  removeIdea: (projectId: string, ideaId: string) => void;
  /** Start working on an idea: it becomes a thread (and leaves the ideas). Returns the thread's id. */
  startIdea: (projectId: string, row: IdeaRow) => string;
  theme: ThemeId; // Settings → Appearance
  setTheme: (t: ThemeId) => void;
  setPage: (p: 'calendar' | 'habits' | 'projects') => void;
  addHabit: (h: Omit<Habit, 'id' | 'createdAt'>) => string;
  updateHabit: (id: string, patch: Partial<Habit>) => void;
  deleteHabit: (id: string) => void;
  /** Set how much was done on a day (epoch day); 0 clears it. */
  setHabitAmount: (id: string, day: number, amount: number) => void;
  links: BookingLink[]; // scheduling links (book a time / group poll)
  myName: string; // shown to guests on your links
  view: ViewMode;
  /** What the current view is showing; views report this as you scroll. */
  visibleRange: Range;
  /** A request for the view to scroll to `date`. `seq` changes on every request. */
  nav: { date: number; seq: number; smooth: boolean };
  selectedId: string | null;
  sidebarOpen: boolean;
  defaultCalendarId: string; // where new events go (★ in the sidebar)
  quickAddOpen: boolean;
  hourH: number; // time-grid zoom: pixels per hour
  toast: Toast | null;
  flashId: string | null; // briefly highlighted event (e.g. just added)
  skipped: Skip[]; // deleted occurrences, so suggestions don't bring them back
  dismissed: string[]; // suggestion ids you closed
  past: Snapshot[]; // undo stack
  future: Snapshot[]; // redo stack
  zone: string; // this computer's current time zone (checked live)
  homeZone: string; // where you normally are
  showHomeHours: boolean; // second hour column in home time when away
  showDeadlines: boolean; // deadlines aren't in a calendar, so they have their own show/hide
  showTasks: boolean; // dated tasks drawn on the calendar
  collapsed: Record<string, boolean>; // folded sidebar sections
  sideOrder: string[]; // the sidebar's cards, in the order you dragged them into (lib/reorder.ts)
  setSideOrder: (order: string[]) => void;

  setView: (v: ViewMode) => void;
  goTo: (date: number, smooth?: boolean) => void;
  goToday: () => void;
  step: (dir: 1 | -1) => void;
  openDay: (date: number) => void;
  setVisibleRange: (r: Range) => void;
  setSidebarOpen: (open: boolean) => void;
  setQuickAdd: (open: boolean) => void;
  setHourH: (h: number) => void;
  toggleCalendar: (id: string) => void;
  addCalendar: (name: string, color: string) => string;
  updateCalendar: (id: string, patch: Partial<CalendarSource>) => void;
  /** Delete a calendar; its events move to `moveTo`, or are deleted when it's null. */
  deleteCalendar: (id: string, moveTo: string | null) => void;
  /** Subscribe to a calendar link (.ics / webcal://). Returns the new calendar's id; its events arrive shortly. */
  subscribeCalendar: (url: string, name: string, color: string) => string;
  /** Fetch a subscribed calendar again (no undo step: it's the feed's data, not an edit). */
  refreshCalendar: (id: string) => Promise<void>;
  refreshSubscriptions: () => Promise<void>;
  /** Import an .ics file as a new calendar of your own (editable copies). Returns how many events came in. */
  importIcs: (text: string, fallbackName: string, color: string) => { id: string; count: number };
  /** A new install: no demo data — one empty calendar, nothing else. */
  startFresh: () => void;
  setZone: (zone: string) => void;
  setHomeZone: (zone: string) => void;
  setShowHomeHours: (on: boolean) => void;
  setShowDeadlines: (on: boolean) => void;
  setShowTasks: (on: boolean) => void;
  createLink: (mode: LinkMode) => string;
  updateLink: (id: string, patch: Partial<BookingLink>) => void;
  /** Delete a link and its upcoming meetings (past ones stay, as a record). Guests see the meeting was cancelled. */
  deleteLink: (id: string) => void;
  /** Bookings that came in over the relays (data/schedSync.ts): the meetings go onto your calendar and the decisions
   *  are kept (and published back). Not an undo step — like a subscribed calendar's refresh, it isn't your edit. */
  applyRemoteBookings: (linkId: string, accepts: Accept[], decisions: Record<string, Decision>) => string[];
  /** Poll answers that came in over the relays. */
  setPollResponses: (linkId: string, responses: PollResponse[]) => void;
  /** Bookkeeping for the relays: when the link's availability was last published (seconds). */
  setLinkPub: (linkId: string, lastPub: number) => void;
  /** Give a link its keys if it has none (links made before v0.2). */
  ensureLinkKeys: (linkId: string) => void;
  /** New address for a link (the old one was shared too widely): the old address shows "closed". */
  resetLinkKeys: (linkId: string) => void;
  /** Sync status per link, for the editor (not saved). */
  linkSync: Record<string, { relays: number; total: number; at: number; error?: string }>;
  setLinkSync: (linkId: string, st: { relays: number; total: number; at: number; error?: string }) => void;
  /** Remove finished links (booked, scheduled or past). Meetings already booked stay on your calendar. */
  clearFinishedLinks: () => void;
  setMyName: (name: string) => void;
  /** You pick the final time for a poll: creates the event and closes the poll. */
  scheduleFromPoll: (linkId: string, start: number) => void;
  /** `due`: local midnight (stored as a date). */
  addTask: (t: { title: string; due?: number; parentId?: string }) => string;
  updateTask: (id: string, patch: Partial<Omit<Task, 'due'>> & { due?: number | null }) => void;
  setTaskDone: (id: string, done: boolean, quiet?: boolean) => void;
  deleteTask: (id: string) => void;
  toggleSection: (key: string) => void;
  setDefaultCalendar: (id: string) => void;
  showToast: (text: string, undo?: boolean, editId?: string) => void;
  hideToast: () => void;
  flash: (id: string) => void;

  select: (id: string | null) => void;
  /** Click on an item: open its card, or close it if it's already open. */
  toggleSelect: (id: string) => void;
  /** An item being dragged from the sidebar onto the calendar (see DragGhost / TimeGrid). */
  blockDrag: BlockDrag | null;
  setBlockDrag: (d: BlockDrag | null) => void;
  /** Make a 1-hour block for a task or deadline at `start` (one undo step). Returns the new event id. */
  blockOut: (item: Pick<BlockDrag, 'kind' | 'id' | 'title'>, start: number) => string;
  createEvent: (e: Omit<CalEvent, 'id'>) => string;
  /** A new event made by dragging / double-clicking: open its card, but keep it only once confirmed. */
  pendingId: string | null;
  startDraft: (e: Omit<CalEvent, 'id'>) => string;
  /** Keep the pending event (Enter or "Add event" on its card) and close the card. */
  confirmDraft: () => void;
  /** `coalesce`: merge rapid edits of the same fields (typing) into one undo step. */
  /**
   * Returns the id the event has afterwards (editing one occurrence of a series creates an
   * exception with a new id). `scope` 'all' edits the whole series.
   */
  updateEvent: (id: string, patch: Partial<CalEvent>, coalesce?: boolean, scope?: Scope) => string;
  deleteEvent: (id: string, scope?: Scope) => void;
  endSeries: (masterIds: string[], at: number) => void;
  /** Several edits/deletions as one undo step (used by quick-add commands). */
  applyChanges: (updates: { id: string; patch: Partial<CalEvent> }[], removeIds: string[]) => void;
  dismissSuggestion: (id: string) => void;
  setDone: (id: string, done: boolean) => void;
  undo: () => void;
  redo: () => void;
  resetDemo: () => void;
}

const initialView: ViewMode = window.innerWidth < 700 ? '3day' : 'week';
const today = startOfDay(new Date()).getTime();
let lastEdit = { key: '', time: 0 };
let flashTimer = 0;
let draftPast = 0; // undo-stack height when the pending event was made

export const useStore = create<State>()(
  persist(
    (set, get) => {
      /** Save the current events as an undo step before a change. */
      const record = (coalesceKey?: string) => {
        const t = Date.now();
        if (coalesceKey && coalesceKey === lastEdit.key && t - lastEdit.time < 1500) {
          lastEdit.time = t;
          return;
        }
        lastEdit = { key: coalesceKey ?? '', time: t };
        set((s) => ({ past: [...s.past.slice(-49), snap(s)], future: [] }));
      };

      return {
        calendars: DEFAULT_CALENDARS,
        events: makeDemoEvents().map(encodeEvent),
        tasks: makeDemoTasks(),
        ...makeDemoHabits(),
        habitNotes: {},
        ...makeDemoProjects(),
        page: 'calendar',
        projectNav: { hist: [], i: -1 },
        theme: 'system',
        links: [],
        myName: '',
        linkSync: {},
        view: initialView,
        visibleRange: { start: today, end: addDays(today, 7).getTime() },
        nav: { date: Date.now(), seq: 0, smooth: false },
        selectedId: null,
        sidebarOpen: window.innerWidth >= 900,
        defaultCalendarId: 'personal',
        quickAddOpen: false,
        hourH: 52,
        toast: null,
        flashId: null,
        skipped: [],
        dismissed: [],
        zone: localZone(),
        homeZone: localZone(),
        showHomeHours: true,
        showDeadlines: true,
        showTasks: true,
        collapsed: {},
        sideOrder: [],
        past: [],
        future: [],
        pendingId: null,

        setView: (view) => {
          const s = get();
          if (view === s.view) return;
          const now = Date.now();
          const { start, end } = s.visibleRange;
          const anchor = now >= start && now < end ? now : start;
          set({ view, nav: { date: anchor, seq: s.nav.seq + 1, smooth: false } });
        },
        goTo: (date, smooth = true) => set((s) => ({ nav: { date, seq: s.nav.seq + 1, smooth } })),
        goToday: () => get().goTo(Date.now()),
        step: (dir) => {
          const { view, visibleRange, goTo } = get();
          const base = visibleRange.start;
          if (view === 'month') goTo(addMonths(startOfMonth(base), dir).getTime());
          else goTo(addDays(base, dir * DAYS_IN_VIEW[view]).getTime());
        },
        openDay: (date) => set((s) => ({ view: 'day', nav: { date, seq: s.nav.seq + 1, smooth: false } })),
        setVisibleRange: (r) => {
          const cur = get().visibleRange;
          if (cur.start !== r.start || cur.end !== r.end) set({ visibleRange: r });
        },
        setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
        setQuickAdd: (quickAddOpen) => set({ quickAddOpen }),
        setHourH: (h) => set({ hourH: Math.min(HOUR_H_RANGE[1], Math.max(HOUR_H_RANGE[0], h)) }),
        addCalendar: (name, color) => {
          record();
          const id = `cal-${newId()}`;
          set((s) => ({ calendars: [...s.calendars, { id, name: name.trim() || 'Untitled', color, visible: true, account: 'Local' }] }));
          return id;
        },
        subscribeCalendar: (url, name, color) => {
          record();
          const id = `sub-${newId()}`;
          set((s) => ({ calendars: [...s.calendars, { id, name: name.trim() || 'Subscribed calendar', color, visible: true, account: 'Subscribed', url: normalizeFeedUrl(url), autoName: !name.trim() }] }));
          void get().refreshCalendar(id);
          return id;
        },
        refreshCalendar: async (id) => {
          const cal = get().calendars.find((c) => c.id === id);
          if (!cal?.url) return;
          const patch = (p: Partial<CalendarSource>) => set((s) => ({ calendars: s.calendars.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
          try {
            const text = await fetchText(cal.url);
            if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("that link isn't a calendar (.ics) — look for an “iCal” or “subscribe” link");
            const now = Date.now();
            const feed = parseIcs(text, id, now - 365 * 86_400_000, now + 2 * 365 * 86_400_000);
            if (!get().calendars.some((c) => c.id === id)) return; // unsubscribed meanwhile
            set((s) => ({ events: [...s.events.filter((e) => e.calendarId !== id), ...feed.events.map(encodeEvent)] }));
            patch({ lastSync: Date.now(), syncError: undefined, ...(cal.autoName && feed.name ? { name: feed.name } : {}) });
          } catch (e) {
            patch({ syncError: e instanceof Error ? e.message : String(e) });
          }
        },
        refreshSubscriptions: async () => {
          for (const c of get().calendars.filter((x) => x.url)) await get().refreshCalendar(c.id);
        },
        importIcs: (text, fallbackName, color) => {
          const feed = parseIcs(text, 'x', Date.now() - 10 * 365 * 86_400_000, Date.now() + 5 * 365 * 86_400_000);
          record();
          const id = `cal-${newId()}`;
          set((s) => ({
            calendars: [...s.calendars, { id, name: feed.name || fallbackName || 'Imported', color: feed.color ?? color, visible: true, account: 'Local' }],
            events: [...s.events, ...feed.events.map((e) => encodeEvent({ ...e, id: `ics-${newId()}`, calendarId: id, createdAt: Date.now() }))],
          }));
          return { id, count: feed.events.length };
        },
        startFresh: () =>
          set({
            calendars: [{ id: 'personal', name: 'Personal', color: '#2f7cf6', visible: true, account: 'Local' }], defaultCalendarId: 'personal',
            events: [], tasks: [], habits: [], habitLog: {}, habitNotes: {}, projects: [], threads: [], projectLog: [], links: [],
            selectedId: null, past: [], future: [], skipped: [], dismissed: [], projectNav: { hist: [], i: -1 },
          }),
        updateCalendar: (id, patch) => {
          record(`cal:${id}:${Object.keys(patch).sort().join()}`);
          set((s) => ({ calendars: s.calendars.map((c) => (c.id === id ? { ...c, ...patch, ...(patch.name !== undefined ? { autoName: false } : {}) } : c)) }));
        },
        deleteCalendar: (id, moveTo) => {
          const s0 = get();
          if (s0.calendars.length <= 1) return;
          const cal = s0.calendars.find((c) => c.id === id);
          if (!cal) return;
          const count = s0.events.filter((e) => e.calendarId === id).length;
          record();
          set((s) => {
            const calendars = s.calendars.filter((c) => c.id !== id);
            const events = moveTo
              ? s.events.map((e) => (e.calendarId === id ? { ...e, calendarId: moveTo } : e))
              : s.events.filter((e) => e.calendarId !== id);
            return {
              calendars,
              events,
              defaultCalendarId: s.defaultCalendarId === id ? (moveTo ?? calendars[0].id) : s.defaultCalendarId,
              selectedId: null,
            };
          });
          const target = moveTo && s0.calendars.find((c) => c.id === moveTo)?.name;
          get().showToast(`Deleted “${cal.name}”${count ? ` · ${count} event${count === 1 ? '' : 's'} ${target ? `moved to ${target}` : 'deleted'}` : ''}`);
        },
        setZone: (zone) => set({ zone }),
        setHomeZone: (homeZone) => set({ homeZone }),
        setShowHomeHours: (showHomeHours) => set({ showHomeHours }),
        setShowDeadlines: (showDeadlines) => set({ showDeadlines }),
        setShowTasks: (showTasks) => set({ showTasks }),
        setSideOrder: (sideOrder) => set({ sideOrder }),
        createLink: (mode) => {
          const s = get();
          const id = Math.random().toString(36).slice(2, 10);
          const link = { ...newLink({ id, mode, hostName: '', calendars: s.calendars, calendarId: newEventCalendarId(s), timeZone: s.homeZone }), nostr: newLinkKeys() }; // name comes from Settings
          set((x) => ({ links: [link, ...x.links] }));
          return id;
        },
        updateLink: (id, patch) => {
          set((x) => ({
            links: x.links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
            ...(patch.hostName !== undefined ? { myName: patch.hostName } : {}),
          }));
        },
        deleteLink: (id) => {
          const now = Date.now();
          const gone = (e: CalEvent) => e.bookedVia === id && e.end > now;
          // also out of the undo history, so undoing an earlier edit can't bring a cancelled meeting back
          const without = (x: Snapshot) => ({ ...x, events: x.events.filter((e) => !gone(e)) });
          set((x) => ({ links: x.links.filter((l) => l.id !== id), events: x.events.filter((e) => !gone(e)), past: x.past.map(without), future: x.future.map(without) }));
        },
        clearFinishedLinks: () => set((x) => ({ links: x.links.filter((l) => !isFinished(l)) })),
        setMyName: (myName) => set({ myName }),
        applyRemoteBookings: (linkId, accepts, decisions) => {
          const link = get().links.find((l) => l.id === linkId);
          if (!link) return [];
          const evs: CalEvent[] = accepts.map((a) => ({
            id: newId(),
            calendarId: link.calendarId,
            title: a.name ? `${link.title} · ${a.name}` : link.title,
            start: a.start,
            end: a.start + link.durationMin * 60_000,
            allDay: false,
            location: link.location,
            notes: `Booked through your “${link.title}” link${a.name ? ` by ${a.name}` : ''}.`,
            bookedVia: link.id,
            createdAt: Date.now(),
          }));
          const bookings = accepts.map((a, i) => ({ id: a.id, name: a.name, start: a.start, end: evs[i].end, createdAt: a.at * 1000, eventId: evs[i].id, guestKey: a.pk }));
          const last = accepts[accepts.length - 1];
          // also into the undo history, so undoing an earlier edit of yours can't take a guest's booking away
          const withEvs = (x: Snapshot) => ({ ...x, events: [...x.events, ...evs] });
          set((x) => ({
            events: [...x.events, ...evs],
            past: evs.length ? x.past.map(withEvs) : x.past,
            future: evs.length ? x.future.map(withEvs) : x.future,
            links: x.links.map((l) =>
              l.id !== linkId
                ? l
                : { ...l, bookings: [...l.bookings, ...bookings], decisions: { ...l.decisions, ...decisions }, ...(l.singleUse && last ? { closed: true, finalStart: last.start } : {}) },
            ),
          }));
          return evs.map((e) => e.id);
        },
        setPollResponses: (linkId, responses) => set((x) => ({ links: x.links.map((l) => (l.id === linkId ? { ...l, responses } : l)) })),
        setLinkPub: (linkId, lastPub) => set((x) => ({ links: x.links.map((l) => (l.id === linkId && l.nostr ? { ...l, nostr: { ...l.nostr, lastPub } } : l)) })),
        ensureLinkKeys: (linkId) => {
          if (get().links.find((l) => l.id === linkId)?.nostr) return;
          set((x) => ({ links: x.links.map((l) => (l.id === linkId && !l.nostr ? { ...l, nostr: newLinkKeys() } : l)) }));
        },
        resetLinkKeys: (linkId) => set((x) => ({ links: x.links.map((l) => (l.id === linkId ? { ...l, nostr: newLinkKeys(), decisions: {} } : l)) })),
        setLinkSync: (linkId, st) => set((x) => ({ linkSync: { ...x.linkSync, [linkId]: st } })),
        scheduleFromPoll: (linkId, start) => {
          const link = get().links.find((l) => l.id === linkId);
          if (!link) return;
          record();
          const id = newId();
          const names = link.responses.map((r) => r.name).join(', ');
          const ev: CalEvent = {
            id, calendarId: link.calendarId, title: link.title, start, end: start + link.durationMin * 60_000, allDay: false,
            location: link.location, notes: names ? `Scheduled with ${names} through your “${link.title}” poll.` : undefined,
            bookedVia: link.id, createdAt: Date.now(),
          };
          set((x) => ({ events: [...x.events, ev], links: x.links.map((l) => (l.id === linkId ? { ...l, closed: true, finalStart: start } : l)) }));
          get().flash(id);
          get().goTo(start);
          get().showToast(`Scheduled “${link.title}” · ${new Date(start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, true, id);
        },
        addTask: ({ title, due, parentId }) => {
          record();
          const id = `t-${newId()}`;
          const task: Task = { id, title: title.trim() || 'New task', createdAt: Date.now(), ...(due !== undefined ? { due: encodeDay(due) } : {}), ...(parentId ? { parentId } : {}) };
          set((s) => ({ tasks: [...s.tasks, task] }));
          get().flash(id);
          return id;
        },
        updateTask: (id, patch) => {
          record(`task:${id}:${Object.keys(patch).sort().join()}`);
          const { due, ...rest } = patch;
          set((s) => ({
            tasks: s.tasks.map((t) => {
              if (t.id !== id) return t;
              const next: Task = { ...t, ...rest };
              if (due === null) delete next.due;
              else if (due !== undefined) next.due = encodeDay(due);
              return next;
            }),
          }));
        },
        setTaskDone: (id, done, quiet = false) => {
          const t = get().tasks.find((x) => x.id === id);
          if (!t) return;
          record();
          set((s) => ({ tasks: s.tasks.map((x) => (x.id === id ? { ...x, done, doneAt: done ? Date.now() : undefined } : x)) }));
          if (!quiet) get().showToast(done ? `✓ “${t.title}”` : `“${t.title}” is open again`);
        },
        deleteTask: (id) => {
          const t = get().tasks.find((x) => x.id === id);
          if (!t) return;
          record();
          set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id && x.parentId !== id), selectedId: s.selectedId === id ? null : s.selectedId }));
          get().showToast(`Deleted task “${t.title}”`);
        },
        toggleSection: (key) => set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),
        toggleCalendar: (id) =>
          set((s) => ({ calendars: s.calendars.map((c) => (c.id === id ? { ...c, visible: !c.visible } : c)) })),
        setDefaultCalendar: (defaultCalendarId) => set({ defaultCalendarId }),
        showToast: (text, undo = true, editId) => set({ toast: { id: Date.now(), text, undo, editId } }),
        hideToast: () => set({ toast: null }),
        flash: (id) => {
          clearTimeout(flashTimer);
          set({ flashId: id });
          flashTimer = window.setTimeout(() => set({ flashId: null }), 1600);
        },

        select: (id) => {
          // Leaving an unconfirmed new event throws it away, along with its undo steps (as if it never happened).
          const { pendingId } = get();
          if (pendingId && pendingId !== id) {
            set((s) => ({ events: s.events.filter((e) => e.id !== pendingId), past: s.past.slice(0, draftPast), pendingId: null, selectedId: null }));
          }
          const { selectedId, events } = get();
          // Leaving an event that was never named: give it a default title (not an undo step).
          const prev = events.find((e) => e.id === selectedId); // (occurrences always have a title)
          if (prev && prev.id !== id && !prev.title.trim())
            set((s) => ({ events: s.events.map((e) => (e.id === prev.id ? { ...e, title: 'New Event' } : e)) }));
          set({ selectedId: id });
        },
        toggleSelect: (id) => get().select(get().selectedId === id ? null : id),
        blockDrag: null,
        setBlockDrag: (blockDrag) => set({ blockDrag }),
        blockOut: (item, start) => {
          record();
          const id = newId();
          const s = get();
          const ev: CalEvent = {
            id,
            calendarId: newEventCalendarId(s),
            title: item.kind === 'deadline' ? `Work on ${item.title}` : item.title,
            start,
            end: start + 3_600_000,
            allDay: false,
            linkedTo: item.id,
            createdAt: Date.now(),
          };
          // The task itself is left alone (blocking time ≠ done, and it shouldn't move lists);
          // its row shows a 🕑 chip for the block instead.
          set((x) => ({ events: [...x.events, ev] }));
          return id;
        },
        createEvent: (e) => {
          record();
          const id = newId();
          // Timed series repeat on the clock of the zone they're created in; all-day events are stored as dates.
          const ev = encodeEvent({ ...e, id, createdAt: Date.now(), ...(e.recurrence && !e.allDay && !e.timeZone ? { timeZone: localZone() } : {}) });
          set((s) => ({ events: [...s.events, ev] }));
          return id;
        },
        setPage: (page) => set({ page }),
        openPane: (v) =>
          set(({ projectNav: { hist, i } }) => {
            const c = hist[i];
            if (c && c.k === v.k && c.id === v.id && c.q === v.q && c.pid === v.pid) return {};
            const next = [...hist.slice(0, i + 1), v].slice(-50);
            return { projectNav: { hist: next, i: next.length - 1 } };
          }),
        closePane: () => set({ projectNav: { hist: [], i: -1 } }),
        stepPane: (dir) => set(({ projectNav: { hist, i } }) => (hist[i + dir] ? { projectNav: { hist, i: i + dir } } : {})),
        addProject: (title, color) => {
          record();
          const id = newId();
          set((s) => ({ projects: [...s.projects, { id, title: title.trim() || 'New project', color, pins: [], ideas: [], createdAt: Date.now() }] }));
          return id;
        },
        updateProject: (id, patch, typing = false) => {
          record(typing ? `project:${id}:${Object.keys(patch).sort().join()}` : undefined);
          set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
        },
        deleteProject: (id) => {
          const p = get().projects.find((x) => x.id === id);
          if (!p) return;
          record();
          set((s) => {
            const gone = new Set([id, ...s.threads.filter((t) => t.projectId === id).map((t) => t.id)]);
            return {
              projects: s.projects.filter((x) => x.id !== id), threads: s.threads.filter((t) => !gone.has(t.id)), projectLog: s.projectLog.filter((e) => !gone.has(e.parentId)),
              projectNav: { hist: [], i: -1 },
            };
          });
          get().showToast(`Deleted project “${p.title}”`);
        },
        reorderProjects: (ids) => {
          const s0 = get().projects;
          const byId = new Map(s0.map((p) => [p.id, p]));
          const next = [...ids.map((id) => byId.get(id)!).filter(Boolean), ...s0.filter((p) => !ids.includes(p.id))];
          if (next.every((p, i) => p === s0[i])) return;
          record();
          set({ projects: next });
        },
        addThread: (projectId, title, body) => {
          record();
          const id = newId();
          const now = Date.now();
          set((s) => ({ threads: [...s.threads, { id, projectId, title: title.trim() || 'New thread', status: 'active', body: body ?? emptyDoc(), createdAt: now, updatedAt: now }] }));
          return id;
        },
        updateThread: (id, patch, typing = false) => {
          record(typing ? `thread:${id}:${Object.keys(patch).sort().join()}` : undefined);
          const now = Date.now();
          set((s) => ({
            threads: s.threads.map((t) =>
              t.id !== id ? t : { ...t, ...patch, updatedAt: now, ...(patch.status && patch.status !== t.status ? { doneAt: patch.status === 'done' ? now : undefined } : {}) },
            ),
          }));
        },
        deleteThread: (id) => {
          const t = get().threads.find((x) => x.id === id);
          if (!t) return;
          record();
          set((s) => {
            const hist = s.projectNav.hist.filter((v) => v.id !== id);
            return { threads: s.threads.filter((x) => x.id !== id), projectLog: s.projectLog.filter((e) => e.parentId !== id), projectNav: { hist, i: hist.length - 1 } };
          });
          get().showToast(`Deleted “${t.title}”`);
        },
        addLog: (parentId, doc) => {
          record(`log:new:${parentId}`);
          const id = newId();
          const now = Date.now();
          lastEdit = { key: `log:${id}`, time: now }; // the typing that follows is part of the same undo step
          set((s) => ({ projectLog: [...s.projectLog, { id, parentId, doc, at: now }], threads: touch(s.threads, parentId, now) }));
          return id;
        },
        updateLog: (id, doc) => {
          record(`log:${id}`);
          const now = Date.now();
          set((s) => {
            const e = s.projectLog.find((x) => x.id === id);
            return { projectLog: s.projectLog.map((x) => (x.id === id ? { ...x, doc } : x)), threads: e ? touch(s.threads, e.parentId, now) : s.threads };
          });
        },
        deleteLog: (id) => {
          record();
          set((s) => ({ projectLog: s.projectLog.filter((e) => e.id !== id) }));
        },
        setChecked: (src, path, checked) => {
          record();
          set((s) => withDoc(s, src, (d) => setAttrsAt(d, path, { checked })));
        },
        setResolved: (src, path, resolved) => {
          record();
          set((s) => withDoc(s, src, (d) => setAttrsAt(d, path, { resolved })));
        },
        addTodo: (parentId, text) => {
          if (!text.trim()) return;
          record();
          set((s) => withTodayNote(s, parentId, (d) => appendItem(d, todoNode(text))));
        },
        moveItem: (src, path, toId) => {
          const doc = docOf(get(), src);
          const taken = doc && removeAt(doc, path);
          if (!taken?.node || taken.node.type !== 'taskItem' || src.owner === toId) return;
          record();
          set((s) => {
            // take it out where it was (a note left with nothing in it goes), then add it to today's note on the target
            let st: Partial<State> = withDoc(s, src, () => taken.doc);
            if (src.entry && isEmptyDoc(taken.doc)) st = { ...st, projectLog: (st.projectLog ?? s.projectLog).filter((e) => e.id !== src.entry) };
            return { ...st, ...withTodayNote({ ...s, ...st } as State, toId, (d) => appendItem(d, taken.node!)) };
          });
        },
        addIdea: (projectId, text) => {
          if (!text.trim()) return;
          record();
          set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, ideas: [{ id: newId(), text: text.trim(), at: Date.now() }, ...(p.ideas ?? [])] } : p)) }));
        },
        removeIdea: (projectId, ideaId) => {
          record();
          set((s) => ({ projects: s.projects.map((p) => (p.id === projectId ? { ...p, ideas: (p.ideas ?? []).filter((i) => i.id !== ideaId) } : p)) }));
        },
        startIdea: (projectId, row) => {
          record();
          const id = newId();
          const now = Date.now();
          const title = row.text.split(/[—.:;?]/)[0].trim().slice(0, 80) || row.text.slice(0, 80);
          set((s) => {
            let st: Partial<State> = {
              threads: [...s.threads, { id, projectId, title, status: 'active', body: textToDoc(row.text), createdAt: now, updatedAt: now }],
              projects: row.idea ? s.projects.map((p) => (p.id === projectId ? { ...p, ideas: (p.ideas ?? []).filter((i) => i.id !== row.idea!.id) } : p)) : s.projects,
            };
            if (row.mark) st = { ...st, ...withDoc({ ...s, ...st } as State, row.mark.s, (d) => setAttrsAt(d, row.mark!.path, { resolved: true })) };
            return st;
          });
          return id;
        },
        setTheme: (theme) => set({ theme }),
        addHabit: (h) => {
          record();
          const id = newId();
          set((s) => ({ habits: [...s.habits, { ...h, id, createdAt: Date.now() }], habitLog: { ...s.habitLog, [id]: {} } }));
          return id;
        },
        updateHabit: (id, patch) => {
          record(`habit:${id}:${Object.keys(patch).sort().join()}`);
          set((s) => ({ habits: s.habits.map((h) => (h.id === id ? { ...h, ...patch } : h)) }));
        },
        deleteHabit: (id) => {
          const h = get().habits.find((x) => x.id === id);
          if (!h) return;
          record();
          set((s) => {
            const { [id]: _gone, ...habitLog } = s.habitLog;
            return { habits: s.habits.filter((x) => x.id !== id), habitLog };
          });
          get().showToast(`Deleted habit “${h.title}”`);
        },
        setHabitNote: (id, day, text) => {
          record(`note:${id}:${day}`); // typing a note is one undo step
          set((s) => {
            const days = { ...(s.habitNotes[id] ?? {}) };
            if (text.trim()) days[day] = text;
            else delete days[day];
            return { habitNotes: { ...s.habitNotes, [id]: days } };
          });
        },
        setHabitAmount: (id, day, amount) => {
          record();
          set((s) => {
            const days = { ...(s.habitLog[id] ?? {}) };
            if (amount > 0) days[day] = amount;
            else delete days[day];
            return { habitLog: { ...s.habitLog, [id]: days } };
          });
        },
        startDraft: (e) => {
          get().select(null);
          draftPast = get().past.length;
          const id = get().createEvent(e);
          set({ pendingId: id, selectedId: id });
          return id;
        },
        confirmDraft: () => {
          const id = get().pendingId;
          if (!id) return;
          // Making it and the edits before confirming are one undo step: ⌘Z takes the whole event away.
          set((s) => ({ pendingId: null, past: s.past.slice(0, draftPast + 1) }));
          get().select(null);
          get().flash(id);
        },
        updateEvent: (id, patch, coalesce = false, scope = 'this') => {
          if (isLocked(get(), id)) {
            lockedToast(get, id);
            return id;
          }
          record(coalesce ? `${id}:${Object.keys(patch).sort().join()}` : undefined);
          const r = updateEvent(get().events, id, patch, scope, newId);
          set((s) => ({ events: r.events, selectedId: s.selectedId === id ? r.id : s.selectedId }));
          return r.id;
        },
        deleteEvent: (id, scope = 'this') => {
          const ev = resolveEvent(get().events, id);
          if (!ev) return;
          if (isLocked(get(), id)) return lockedToast(get, id);
          record();
          set((s) => ({
            skipped: [...s.skipped.slice(-199), { key: seriesKey(ev.title), at: ev.start }],
            events: removeEvent(s.events, id, scope),
            tasks: s.tasks.filter((t) => t.parentId !== id),
            selectedId: s.selectedId === id ? null : s.selectedId,
            pendingId: s.pendingId === id ? null : s.pendingId,
          }));
          get().showToast(`Deleted “${ev.title || 'New Event'}”${scope === 'all' && ev.seriesId ? ' (all events)' : ''}`);
        },
        endSeries: (masterIds, at) => {
          masterIds = masterIds.filter((id) => !isLocked(get(), id));
          if (!masterIds.length) return;
          record();
          set((s) => ({ events: masterIds.reduce((evs, id) => endSeries(evs, id, at), s.events), selectedId: null }));
        },
        applyChanges: (updates, removeIds) => {
          updates = updates.filter((u) => !isLocked(get(), u.id));
          removeIds = removeIds.filter((id) => !isLocked(get(), id));
          if (!updates.length && !removeIds.length) return;
          record();
          const before = get().events;
          let events = before;
          for (const u of updates) events = updateEvent(events, u.id, u.patch, 'this', newId).events;
          const gone = removeIds.map((id) => resolveEvent(before, id)).filter(Boolean) as CalEvent[];
          for (const id of removeIds) events = removeEvent(events, id, 'this');
          set((s) => ({
            skipped: [...s.skipped.slice(-199), ...gone.map((e) => ({ key: seriesKey(e.title), at: e.start }))],
            events,
            selectedId: s.selectedId && removeIds.includes(s.selectedId) ? null : s.selectedId,
          }));
        },
        setDone: (id, done) => {
          const ev = resolveEvent(get().events, id);
          if (!ev) return;
          get().updateEvent(id, { done });
          get().showToast(done ? `✓ “${ev.title}” done` : `“${ev.title}” is open again`);
        },
        dismissSuggestion: (id) => set((s) => ({ dismissed: [...s.dismissed.slice(-299), id] })),
        undo: () => {
          const { past, future, selectedId } = get();
          if (!past.length) return;
          const prev = past[past.length - 1];
          lastEdit = { key: '', time: 0 };
          set({
            ...prev,
            past: past.slice(0, -1),
            future: [snap(get()), ...future].slice(0, 50),
            selectedId: resolveEvent(prev.events, selectedId) ? selectedId : null,
            toast: null,
          });
        },
        redo: () => {
          const { past, future, selectedId } = get();
          if (!future.length) return;
          const next = future[0];
          set({
            ...next,
            past: [...past, snap(get())],
            future: future.slice(1),
            selectedId: resolveEvent(next.events, selectedId) ? selectedId : null,
          });
        },
        resetDemo: () =>
          set({ events: makeDemoEvents().map(encodeEvent), tasks: makeDemoTasks(), ...makeDemoHabits(), habitNotes: {}, ...makeDemoProjects(), links: [], calendars: DEFAULT_CALENDARS, selectedId: null, past: [], future: [], skipped: [], dismissed: [] }),
      };
    },
    {
      name: 'calendar-v1',
      storage: createJSONStorage(appStorage), // the Mac app: a SQLite file; a browser: localStorage (data/persist.ts)
      version: 2,
      // v1: the demo habits gained years of history (only swapped while they're the untouched demo set).
      // v2: Projects became pages you write in (About, steps, waiting-on and notes folded into editor documents).
      //     The untouched demo projects are swapped for the new demo; anything else is converted, losing nothing.
      migrate: (persisted, version) => {
        const p = persisted as Partial<State>;
        if (version < 1 && p.habits && p.habits.length === DEMO_HABIT_IDS.length && p.habits.every((h) => DEMO_HABIT_IDS.includes(h.id))) Object.assign(p, makeDemoHabits());
        if (version < 2 && p.projects) {
          const v1 = p as unknown as Parameters<typeof migrateV1>[0];
          const demoOnly = (v1.projects ?? []).every((x) => x.id.startsWith('demo-')) && (v1.threads ?? []).every((x) => x.id.startsWith('demo-'));
          Object.assign(p, demoOnly ? makeDemoProjects() : migrateV1(v1));
        }
        return p as State;
      },
      partialize: (s) => ({
        calendars: s.calendars,
        events: s.events,
        view: s.view,
        hourH: s.hourH,
        defaultCalendarId: s.defaultCalendarId,
        skipped: s.skipped,
        dismissed: s.dismissed,
        homeZone: s.homeZone,
        showHomeHours: s.showHomeHours,
        showDeadlines: s.showDeadlines,
        showTasks: s.showTasks,
        collapsed: s.collapsed,
        sideOrder: s.sideOrder,
        tasks: s.tasks,
        habits: s.habits,
        habitLog: s.habitLog,
        habitNotes: s.habitNotes,
        projects: s.projects,
        threads: s.threads,
        projectLog: s.projectLog,
        page: s.page,
        theme: s.theme,
        links: s.links,
        myName: s.myName,
      }),
    },
  ),
);

// Another tab changed the saved data (development: the app open in two tabs): reload it here.
if (typeof window !== 'undefined' && !isApp())
  window.addEventListener('storage', (e) => {
    if (e.key === 'calendar-v1') void useStore.persist.rehydrate();
  });
