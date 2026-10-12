// Keyboard and screen-reader access for things you click on the calendar (an event, a task row): reachable with Tab,
// opened with Enter or Space, and named by what they are and when.
import type { KeyboardEvent } from 'react';

/** Props for an element that acts as a button: focusable, Enter / Space do `act`, read out as `label`. */
export const asButton = (label: string, act: () => void) => ({
  role: 'button' as const,
  tabIndex: 0,
  'aria-label': label,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    act();
  },
});
