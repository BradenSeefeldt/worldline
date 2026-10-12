import { useMemo } from 'react';
import { useStore } from './store';
import { expand } from '../lib/recurrence';
import type { CalEvent } from './types';

/** Events to show in [from, to): one-off events plus occurrences of recurring series. */
export function useEventsIn(from: number, to: number) {
  const events = useStore((s) => s.events);
  return useMemo(() => expand(events, from, to), [events, from, to]);
}

/** Deadlines only (picked out before unrolling anything: the Deadlines card and the runways look far ahead, and
 *  unrolling every series that far on each change took a fifth of a second with years of events). */
let lastDeadlines: { events: CalEvent[]; out: CalEvent[] } | null = null;
const deadlinesOf = (events: CalEvent[]) =>
  lastDeadlines?.events === events ? lastDeadlines.out : (lastDeadlines = { events, out: events.filter((e) => e.kind === 'deadline') }).out;
export function useDeadlinesIn(from: number, to: number) {
  const events = useStore((s) => s.events);
  return useMemo(() => expand(deadlinesOf(events), from, to), [events, from, to]);
}
