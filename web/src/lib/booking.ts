// Scheduling links: let other people book time with you (one person) or find a time together
// (a group poll, like when2meet). Privacy rule: guests only ever get `publicView` — open times
// and what you chose to share. Never what you're doing, never event titles.
import type { CalEvent } from '../data/types';
import { MIN } from './dates';
import { epochDay, fromEpochDay, instantOf, wallClock } from './zone';

export type LinkMode = 'book' | 'poll';

export interface Booking {
  id: string;
  name: string;
  email?: string;
  start: number;
  end: number;
  createdAt: number;
  eventId?: string; // set once it's on your calendar
  guestKey?: string; // booked from another computer: the guest's key on the relays
}

export interface PollResponse {
  id: string;
  name: string;
  cells: number[]; // start instants of the 30-min cells they're free
  updatedAt: number;
}

export interface BookingLink {
  id: string; // also the URL slug
  mode: LinkMode;
  title: string; // the event's name
  hostName: string; // shown to guests ("Book time with Sam")
  durationMin: number;
  location?: string;
  note?: string; // shown to guests
  days?: number[]; // the exact days offered (epoch days, host's zone) — picked by dragging in the editor
  firstDay: number; // older links: a date range + weekdays instead of `days`
  lastDay: number;
  weekdays: number[]; // 0 = Sunday …
  windowStart: number; // minutes after midnight, host's zone
  windowEnd: number;
  timeZone: string; // the host's zone (the window is on this clock)
  blockingCalendars: string[]; // your calendars that count as busy
  calendarId: string; // where booked meetings go
  bufferMin: number; // free time kept around your other events
  noticeMin: number; // no bookings sooner than this from now
  createdAt: number;
  singleUse?: boolean; // booking link closes after one booking
  closed?: boolean;
  finalStart?: number; // poll: the time you picked
  bookings: Booking[];
  /** Its keys on the relays (lib/schedwire.ts): kept only in your database. `lastPub`: created_at of the last
   *  published availability (seconds), so the next one is always newer. */
  nostr?: { sk: string; secret: string; lastPub?: number };
  /** Your app's answer to each guest's request (keyed by the guest's key), published back so their page can say. */
  decisions?: Record<string, { id: string; status: 'ok' | 'taken' | 'busy' | 'closed' | 'invalid'; start: number }>;
  responses: PollResponse[];
}

export const CELL_MIN = 30;

/** The instants a link's range covers (for fetching your busy time). */
export function linkSpan(link: BookingLink) {
  const days = linkDays(link);
  const a = fromEpochDay(days[0] ?? link.firstDay);
  const b = fromEpochDay((days[days.length - 1] ?? link.lastDay) + 1);
  return { from: instantOf(a.y, a.m, a.d, 0, link.timeZone), to: instantOf(b.y, b.m, b.d, 0, link.timeZone) };
}

/** An .ics file so a guest can add the meeting to their own calendar. */
export function icsFor(title: string, start: number, end: number, location?: string) {
  const z = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Calendar//Booking//EN', 'BEGIN:VEVENT',
    `UID:${start}-${Math.random().toString(36).slice(2)}@calendar`, `DTSTAMP:${z(Date.now())}`,
    `DTSTART:${z(start)}`, `DTEND:${z(end)}`, `SUMMARY:${esc(title)}`, ...(location ? [`LOCATION:${esc(location)}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
} // grid resolution for polls, and the step between offered start times

export interface Interval {
  start: number;
  end: number;
}

/** Your busy time inside the link's range — just intervals, nothing else leaves this function. Meetings booked
 *  through this link always count, whichever calendar they went into. */
export function busyFor(link: BookingLink, events: CalEvent[]): Interval[] {
  const blocking = new Set(link.blockingCalendars);
  return events
    .filter((e) => (blocking.has(e.calendarId) || e.bookedVia === link.id) && !e.allDay && e.kind !== 'deadline' && e.kind !== 'task')
    .map((e) => ({ start: e.start - link.bufferMin * MIN, end: e.end + link.bufferMin * MIN }));
}

/** The days a link offers, as epoch days in the host's zone. */
export function linkDays(link: BookingLink) {
  if (link.days) return [...link.days].sort((a, b) => a - b);
  const out: number[] = [];
  for (let d = link.firstDay; d <= link.lastDay; d++) {
    const { y, m, d: dd } = fromEpochDay(d);
    if (link.weekdays.includes(new Date(Date.UTC(y, m, dd)).getUTCDay())) out.push(d);
  }
  return out;
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** Cells (or start times) on one day: every CELL_MIN from the window start. */
function cellsOn(link: BookingLink, day: number, length: number) {
  const { y, m, d } = fromEpochDay(day);
  const out: Interval[] = [];
  for (let t = link.windowStart; t + length <= link.windowEnd; t += CELL_MIN) {
    const start = instantOf(y, m, d, t, link.timeZone);
    out.push({ start, end: start + length * MIN });
  }
  return out;
}

export interface PublicDay {
  day: number; // epoch day (host zone)
  slots: number[]; // book: open start times · poll: open cell starts
  cells?: number[]; // poll: every cell in the window (busy ones are shown greyed out)
}

/** Everything a guest is allowed to see. */
export interface PublicView {
  id: string;
  mode: LinkMode;
  title: string;
  hostName: string;
  durationMin: number;
  location?: string;
  note?: string;
  cellMin: number;
  days: PublicDay[];
  closed: boolean;
  finalStart?: number;
  responses: { name: string; cells: number[] }[]; // poll only: the group's answers
}

/** Done with: the booked / scheduled meeting is over, or every offered day has passed. */
export function isFinished(link: BookingLink, now = Date.now()) {
  if (link.closed) return !(link.finalStart && link.finalStart + link.durationMin * MIN > now); // keep it in view until the meeting
  const days = linkDays(link);
  if (!days.length) return false;
  const { to } = linkSpan(link);
  return to <= now;
}

/** `hostName`: your name from Settings (used when the link doesn't set its own). */
export function publicView(link: BookingLink, events: CalEvent[], now = Date.now(), hostName = ''): PublicView {
  const busy = busyFor(link, events);
  const earliest = now + link.noticeMin * MIN;
  const length = link.mode === 'book' ? link.durationMin : CELL_MIN;
  const days = linkDays(link).map((day) => {
    const all = cellsOn(link, day, length);
    return {
      day,
      slots: all.filter((c) => c.start >= earliest && !busy.some((b) => overlaps(b, c))).map((c) => c.start),
      ...(link.mode === 'poll' ? { cells: all.map((c) => c.start) } : {}),
    };
  });
  return {
    id: link.id,
    mode: link.mode,
    title: link.title,
    hostName: link.hostName || hostName,
    durationMin: link.durationMin,
    location: link.location,
    note: link.note,
    cellMin: CELL_MIN,
    days: days.filter((d) => link.mode === 'poll' || d.slots.length > 0),
    closed: !!link.closed,
    finalStart: link.finalStart,
    responses: link.mode === 'poll' ? link.responses.map((r) => ({ name: r.name, cells: r.cells })) : [],
  };
}

/** Is this start time still open? (Checked again right before a booking is saved.) */
export function stillOpen(link: BookingLink, events: CalEvent[], start: number, now = Date.now()) {
  return publicView(link, events, now).days.some((d) => d.slots.includes(start));
}

/** Poll: who's free in each cell. */
export function heat(responses: PollResponse[] | { name: string; cells: number[] }[]) {
  const m = new Map<number, string[]>();
  for (const r of responses) for (const c of r.cells) m.set(c, [...(m.get(c) ?? []), r.name]);
  return m;
}

/** Poll: a meeting starting at `start` — does it fit (you free for all of it, same day) and who can make all of it. */
export function meetingAt(view: PublicView, h: Map<number, string[]>, start: number, durationMin: number) {
  const need = Math.ceil(durationMin / CELL_MIN);
  const cells = Array.from({ length: need }, (_, k) => start + k * CELL_MIN * MIN);
  const day = view.days.find((d) => d.slots.includes(start));
  const fits = !!day && cells.every((c) => day.slots.includes(c));
  const names = cells.map((c) => new Set(h.get(c) ?? [])).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  return { start, cells, fits, names: [...names] };
}

/** Poll: the best meeting times — most people free for the whole meeting, then earliest; never overlapping. */
export function bestTimes(link: BookingLink, view: PublicView, limit = 3) {
  const h = heat(link.responses);
  const out: { start: number; names: string[] }[] = [];
  for (const d of view.days)
    for (const s of d.slots) {
      const m = meetingAt(view, h, s, link.durationMin);
      if (m.fits && m.names.length) out.push({ start: s, names: m.names }); // you must be free for all of it
    }
  // Distinct options: skip times that overlap one already picked (not three slices of one afternoon).
  const len = link.durationMin * MIN;
  const picks: typeof out = [];
  for (const o of out.sort((a, b) => b.names.length - a.names.length || a.start - b.start)) {
    if (picks.length >= limit) break;
    if (!picks.some((p) => Math.abs(p.start - o.start) < len)) picks.push(o);
  }
  return picks;
}

/** Sensible defaults for a new link: no days yet (you pick them), 9–5, an hour, your visible calendars block. */
export function newLink(opts: { id: string; mode: LinkMode; hostName: string; calendars: { id: string; visible: boolean }[]; calendarId: string; timeZone: string; now?: number }): BookingLink {
  const now = opts.now ?? Date.now();
  const w = wallClock(now, opts.timeZone);
  const today = epochDay(w.y, w.m, w.d);
  const days: number[] = [];
  return {
    id: opts.id,
    mode: opts.mode,
    title: opts.mode === 'book' ? 'Meeting' : 'Group meeting',
    hostName: opts.hostName,
    durationMin: 60,
    days,
    firstDay: today,
    lastDay: today,
    weekdays: [1, 2, 3, 4, 5],
    windowStart: 9 * 60,
    windowEnd: 17 * 60,
    timeZone: opts.timeZone,
    blockingCalendars: opts.calendars.filter((c) => c.visible).map((c) => c.id),
    calendarId: opts.calendarId,
    bufferMin: 0,
    noticeMin: 0,
    singleUse: opts.mode === 'book',
    createdAt: now,
    bookings: [],
    responses: [],
  };
}
