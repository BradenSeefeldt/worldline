// Calendars on the Mac (iCloud, Google, Exchange… via the Calendar app), kept in step with Worldline both ways. Pure:
// given what the Mac has, what Worldline has, and what each event looked like the last time the two agreed (`known`),
// decide what to change where. data/macCalendars.ts fetches, applies and pushes.
//
// For each event (named by its Mac identifier + which occurrence):
//   · the same on both                       → nothing (and remembered as agreed)
//   · changed only in Worldline              → saved to the Mac
//   · changed on the Mac (or on both)        → the Mac's version (the Calendar app is the source of truth)
//   · only on the Mac, never seen before     → added to Worldline
//   · only on the Mac, but known             → deleted in Worldline → deleted on the Mac
//   · only in Worldline, known               → deleted on the Mac → removed from Worldline
//   · new in Worldline (no Mac identifier)   → created on the Mac (a repeating one as a real repeating event)
// The Mac is asked about a window of time: an event of Worldline's outside it is never taken as deleted there.
import type { CalEvent, Recurrence } from '../data/types';
import { encodeEvent } from './recurrence';

/** An event as the Mac reports it (src-tauri/src/eventkit.rs). */
export interface MacEvent {
  ext: string;
  occ: number;
  calendar: string; // the Mac's calendar identifier
  title: string;
  start: number;
  end: number;
  all_day: boolean;
  location?: string | null;
  notes?: string | null;
  url?: string | null;
  recurring: boolean;
}

/** What to send to the Mac to save (src-tauri/src/eventkit.rs → EkSave). */
export interface MacSave {
  ext?: string;
  occ?: number;
  calendar: string;
  title: string;
  start: number;
  end: number;
  all_day: boolean;
  location?: string;
  notes?: string;
  url?: string;
  rule?: { freq: Recurrence['freq']; interval: number; by_day: number[]; until?: number };
}

export type Push =
  | { op: 'save'; key: string; save: MacSave; fp: string } // an existing occurrence
  | { op: 'create'; localId: string; save: MacSave; fp: string; repeating: boolean }
  | { op: 'delete'; key: string; ext: string; occ: number; calendar: string };

export interface Plan {
  events: CalEvent[]; // Worldline's events after taking in the Mac's changes
  pushes: Push[]; // changes to make on the Mac
  known: Record<string, string>; // what each event looked like when the two last agreed
}

/** Worldline's calendar id for a Mac calendar. */
export const calendarIdFor = (macId: string) => `mac:${macId}`;
export const isMacCalendarId = (id: string) => id.startsWith('mac:');
export const keyOf = (ext: { id: string; occ: number }) => `${ext.id}|${ext.occ}`;
const DAY = 86_400_000;

/** The Mac's event as a Worldline event (all-day: whole local days, end exclusive — the Mac ends them at 23:59:59). */
export function fromMac(m: MacEvent): CalEvent {
  const occ = m.recurring ? m.occ : 0; // a one-off event: its identifier alone names it (its start may change)
  let end = m.end;
  if (m.all_day) {
    const last = new Date(m.end - 1);
    end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();
  }
  const ev: CalEvent = {
    id: `mac-${hash(keyOf({ id: m.ext, occ }))}`,
    calendarId: calendarIdFor(m.calendar),
    title: m.title,
    start: m.start,
    end: Math.max(end, m.start),
    allDay: m.all_day,
    ext: { id: m.ext, occ, ...(m.recurring ? { recurring: true } : {}) },
  };
  if (m.location) ev.location = m.location;
  if (m.notes) ev.notes = m.notes;
  if (m.url) ev.url = m.url;
  return m.all_day ? encodeEvent(ev) : ev;
}

/** The parts both sides keep, to tell whether an event changed. (Times as Worldline stores them.) */
export function fingerprint(e: CalEvent): string {
  return JSON.stringify([e.calendarId, e.title ?? '', e.start, e.end, !!e.allDay, e.location ?? '', e.notes ?? '', e.url ?? '']);
}

/** Worldline's event as the Mac saves it. Stored all-day times are encoded (lib/recurrence.ts): decode first. */
export function toSave(e: CalEvent, macCalendar: string, decode: (e: CalEvent) => CalEvent): MacSave {
  const d = e.allDay ? decode(e) : e;
  const s: MacSave = { calendar: macCalendar, title: d.title || 'New Event', start: d.start, end: d.end, all_day: !!d.allDay };
  if (e.ext) Object.assign(s, { ext: e.ext.id, occ: e.ext.occ });
  if (d.location) s.location = d.location;
  if (d.notes) s.notes = d.notes;
  if (d.url) s.url = d.url;
  if (d.recurrence) s.rule = { freq: d.recurrence.freq, interval: d.recurrence.interval, by_day: d.recurrence.byDay ?? [], ...(d.recurrence.until ? { until: d.recurrence.until } : {}) };
  return s;
}

/**
 * Compare and decide. `macCals`: Worldline calendar id → the Mac's calendar id, for the Mac calendars this Mac keeps in
 * step. `window`: the span the Mac was asked about (stored times). `decode`: lib/recurrence.ts → decodeEvent.
 */
export function reconcile(
  events: CalEvent[],
  mac: MacEvent[],
  known: Record<string, string>,
  macCals: Map<string, string>,
  window: { from: number; to: number },
  decode: (e: CalEvent) => CalEvent,
): Plan {
  const out = new Map(events.map((e) => [e.id, e]));
  const nextKnown: Record<string, string> = { ...known };
  const pushes: Push[] = [];
  // compared only when it starts well inside the window — the Mac surely returned it then (one missing at the edges
  // would otherwise look deleted)
  const inWindow = (e: CalEvent) => {
    const d = e.allDay ? decode(e) : e;
    return d.start >= window.from && d.start < window.to - DAY;
  };

  // what the Mac has (one per occurrence), and Worldline's events in the Mac calendars
  const fromM = new Map<string, CalEvent>();
  for (const m of mac) {
    if (!macCals.has(calendarIdFor(m.calendar))) continue;
    const e = fromMac(m);
    if (inWindow(e)) fromM.set(keyOf(e.ext!), e); // (the same rule both sides)
  }
  const fromW = new Map<string, CalEvent>();
  for (const e of events) {
    if (!macCals.has(e.calendarId)) {
      // Moved into one of Worldline's own calendars: it's Worldline's now. (A Mac calendar merely left out of this round
      // — another Mac's, or one sitting a round out — keeps its events' ties: losing them made duplicates.)
      if (e.ext && !isMacCalendarId(e.calendarId)) out.set(e.id, { ...e, ext: undefined });
      continue;
    }
    if (!e.ext) {
      // new in Worldline: create it on the Mac (a repeating one becomes a repeating event there; its occurrences
      // come back by themselves, so the one here goes once it's saved)
      if (e.seriesId) continue; // (an edited occurrence of a local series: belongs with its series)
      pushes.push({ op: 'create', localId: e.id, save: toSave(e, macCals.get(e.calendarId)!, decode), fp: fingerprint(e), repeating: !!e.recurrence });
      continue;
    }
    fromW.set(keyOf(e.ext), e); // (wherever it is now: moved far ahead is a change, not a deletion)
  }

  for (const key of new Set([...fromM.keys(), ...fromW.keys()])) {
    const m = fromM.get(key), w = fromW.get(key), k = known[key];
    if (m && w) {
      const fm = fingerprint(m), fw = fingerprint(w);
      if (fm === fw) nextKnown[key] = fm;
      else if (k === fm) {
        // changed only in Worldline
        pushes.push({ op: 'save', key, save: toSave(w, macCals.get(w.calendarId)!, decode), fp: fw });
      } else {
        // changed on the Mac (or both): the Mac's version, keeping Worldline's id and its own extras (alert…)
        out.set(w.id, { ...w, ...m, id: w.id, location: m.location, notes: m.notes, url: m.url });
        nextKnown[key] = fm;
      }
    } else if (m) {
      if (k !== undefined) {
        // deleted in Worldline
        pushes.push({ op: 'delete', key, ext: m.ext!.id, occ: m.ext!.occ, calendar: macCals.get(m.calendarId)! });
        delete nextKnown[key];
      } else {
        out.set(m.id, m);
        nextKnown[key] = fingerprint(m);
      }
    } else if (w && inWindow(w)) {
      // gone from the Mac (deleted there, or moved out of the calendars kept in step). Outside the window the Mac
      // wasn't asked, so nothing is known: left alone.
      out.delete(w.id);
      delete nextKnown[key];
    }
  }
  // Occurrences long before the window are never compared again (the Mac isn't asked about them): what they looked
  // like is forgotten, or it would pile up for every meeting ever had.
  for (const key of Object.keys(nextKnown)) {
    const occ = Number(key.slice(key.lastIndexOf('|') + 1));
    if (occ > 0) {
      if (occ < window.from - 30 * DAY) delete nextKnown[key];
    } else if (!fromM.has(key)) {
      // a one-off: forgotten once it's long past here, or gone from both sides
      const w = fromW.get(key);
      if (!w || (w.allDay ? decode(w) : w).end < window.from - 30 * DAY) delete nextKnown[key];
    }
  }
  return { events: [...out.values()], pushes, known: nextKnown };
}

/** A short stable id from a string (FNV-1a, base 36). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  let h2 = 0x1505;
  for (let i = 0; i < s.length; i++) h2 = (Math.imul(h2, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + h2.toString(36);
}
