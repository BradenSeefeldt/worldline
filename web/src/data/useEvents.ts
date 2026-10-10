import { useMemo } from 'react';
import { useStore } from './store';
import { expand } from '../lib/recurrence';

/** Events to show in [from, to): one-off events plus occurrences of recurring series. */
export function useEventsIn(from: number, to: number) {
  const events = useStore((s) => s.events);
  return useMemo(() => expand(events, from, to), [events, from, to]);
}
