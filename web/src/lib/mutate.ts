// Pure edits on the event list that understand recurring series.
//   scope 'this' on an occurrence → an exception for that date only
//   scope 'all'  on an occurrence → the whole series (the master) changes
import type { CalEvent } from '../data/types';
import { decodeEvent, encodeEvent, isOccurrenceId, occurrenceId, resolveEvent, splitOccurrenceId } from './recurrence';
import { encodeDay, epochDay, instantOf, wallClock } from './zone';

// Edits work on events as shown (all-day ones as local midnights) and store them back encoded.
const toLocal = (events: CalEvent[]) => events.map(decodeEvent);
const toStored = (events: CalEvent[]) => events.map(encodeEvent);

export type Scope = 'this' | 'all';

/** Weekdays (0 = Sunday) moved by `days`: [1, 3] + 1 → [2, 4]. */
export const rotateDays = (byDay: number[], days: number) => byDay.map((d) => (((d + days) % 7) + 7) % 7);

/** Apply `patch` to event `id`. Returns the new list and the id the edited event now has. */
export function updateEvent(stored: CalEvent[], id: string, patch: Partial<CalEvent>, scope: Scope, newId: () => string) {
  const r = updateLocal(toLocal(stored), id, patch, scope, newId);
  return { events: toStored(r.events), id: r.id };
}

function updateLocal(events: CalEvent[], id: string, patch: Partial<CalEvent>, scope: Scope, newId: () => string) {
  if (!isOccurrenceId(id)) return { events: events.map((e) => (e.id === id ? { ...e, ...patch } : e)), id };

  const occ = resolveEvent(events, id);
  if (!occ) return { events, id };
  const { masterId, start: original } = splitOccurrenceId(id);

  if (scope === 'all') {
    const master = events.find((e) => e.id === masterId)!;
    const mp: Partial<CalEvent> = { ...patch };
    if (patch.start !== undefined || patch.end !== undefined) {
      // The whole series moves as this occurrence moved, counted on the series' own clock: so many calendar days and
      // so many minutes of wall-clock time (not milliseconds: across a daylight-saving change a day isn't 24 hours).
      const tz = master.allDay ? undefined : master.timeZone;
      const newStart = patch.start ?? occ.start, newEnd = patch.end ?? occ.end;
      const a = wallClock(occ.start, tz), b = wallClock(newStart, tz), m = wallClock(master.start, tz);
      const days = epochDay(b.y, b.m, b.d) - epochDay(a.y, a.m, a.d);
      const minutes = b.h * 60 + b.min - (a.h * 60 + a.min);
      mp.start = days || minutes ? instantOf(m.y, m.m, m.d + days, m.h * 60 + m.min + minutes, tz) : master.start;
      if (master.allDay) {
        // all-day: as many days long as the occurrence now is
        const e = wallClock(newEnd), s = wallClock(newStart);
        mp.end = new Date(m.y, m.m, m.d + days + Math.max(1, epochDay(e.y, e.m, e.d) - epochDay(s.y, s.m, s.d))).getTime();
      } else mp.end = mp.start + (newEnd - newStart);
      // A weekly series on set weekdays moves its weekdays too (Mon + Wed, a day later → Tue + Thu).
      const r = master.recurrence;
      if (patch.recurrence === undefined && r?.freq === 'weekly' && r.byDay?.length && days % 7) mp.recurrence = { ...r, byDay: rotateDays(r.byDay, days) };
    }
    const next = events.map((e) => (e.id === masterId ? { ...e, ...mp } : e));
    const newStart = patch.start ?? occ.start;
    return { events: next, id: occurrenceId(masterId, master.allDay ? encodeDay(newStart) : newStart) };
  }

  const exceptionId = newId();
  const exception: CalEvent = {
    ...occ,
    ...patch,
    id: exceptionId,
    seriesId: masterId,
    originalStart: original,
    recurrence: undefined,
    exdates: undefined,
  };
  const next = events.map((e) => (e.id === masterId ? { ...e, exdates: [...(e.exdates ?? []), original] } : e));
  return { events: [...next, exception], id: exceptionId };
}

/** Remove event `id`: one occurrence (skip that date) or, with scope 'all', the whole series. */
export function removeEvent(stored: CalEvent[], id: string, scope: Scope): CalEvent[] {
  return toStored(removeLocal(toLocal(stored), id, scope));
}

function removeLocal(events: CalEvent[], id: string, scope: Scope): CalEvent[] {
  if (isOccurrenceId(id)) {
    const { masterId, start } = splitOccurrenceId(id);
    if (scope === 'all') return removeSeries(events, masterId);
    return events.map((e) => (e.id === masterId ? { ...e, exdates: [...(e.exdates ?? []), start] } : e));
  }
  const ev = events.find((e) => e.id === id);
  if (ev?.recurrence) return removeSeries(events, id);
  if (ev?.seriesId && scope === 'all') return removeSeries(events, ev.seriesId);
  return events.filter((e) => e.id !== id);
}

function removeSeries(events: CalEvent[], masterId: string) {
  return events.filter((e) => e.id !== masterId && e.seriesId !== masterId);
}

/** Stop a series from `at` onward; past occurrences stay. A series that hasn't started is removed. */
export function endSeries(stored: CalEvent[], masterId: string, at: number): CalEvent[] {
  const events = toLocal(stored);
  const master = events.find((e) => e.id === masterId);
  if (!master?.recurrence) return stored;
  if (master.start >= at) return toStored(removeSeries(events, masterId));
  // (an all-day series stores this as its last day: see recurrence.ts)
  return toStored(events
    .filter((e) => !(e.seriesId === masterId && e.start >= at)) // drop future exceptions too
    .map((e) => (e.id === masterId ? { ...e, recurrence: { ...e.recurrence!, until: at - 1 } } : e)));
}
