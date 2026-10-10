// Pure edits on the event list that understand recurring series.
//   scope 'this' on an occurrence → an exception for that date only
//   scope 'all'  on an occurrence → the whole series (the master) changes
import type { CalEvent } from '../data/types';
import { decodeEvent, encodeEvent, isOccurrenceId, occurrenceId, resolveEvent, splitOccurrenceId } from './recurrence';
import { encodeDay, wallClock } from './zone';

// Edits work on events as shown (all-day ones as local midnights) and store them back encoded.
const toLocal = (events: CalEvent[]) => events.map(decodeEvent);
const toStored = (events: CalEvent[]) => events.map(encodeEvent);

export type Scope = 'this' | 'all';

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
      // The whole series moves by however much this occurrence moved.
      mp.start = master.start + ((patch.start ?? occ.start) - occ.start);
      mp.end = master.end + ((patch.end ?? occ.end) - occ.end);
      const r = master.recurrence;
      if (r?.freq === 'weekly' && (r.byDay?.length ?? 1) <= 1)
        mp.recurrence = { ...r, byDay: [wallClock(mp.start, master.allDay ? undefined : master.timeZone).wd] }; // weekday on the series' own clock
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
export function endSeries(events: CalEvent[], masterId: string, at: number): CalEvent[] {
  const master = events.find((e) => e.id === masterId);
  if (!master?.recurrence) return events;
  if (master.start >= at) return removeSeries(events, masterId);
  return events
    .filter((e) => !(e.seriesId === masterId && e.start >= at)) // drop future exceptions too
    .map((e) => (e.id === masterId ? { ...e, recurrence: { ...e.recurrence!, until: at - 1 } } : e));
}
