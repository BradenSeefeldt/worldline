// Display preferences that plain helper functions need (the date maths, the time formatter, the parser's defaults).
// The store owns the settings and copies them here (data/store.ts → applyPrefs); views redraw when they change.
// Defaults are the app's long-standing behaviour, so the tests run with them.
import { setWeekStart } from './dates';
import { DEFAULT_DEADLINE_LOOK, type DeadlineLook } from '../data/settings';

export interface Prefs {
  weekStartsOn: 0 | 1; // 0 = Sunday, 1 = Monday
  hour24: boolean; // "15:30" rather than "3:30 PM"
  defaultEventMin: number; // a new event's length when nothing says
  dueMinutes: number; // a deadline's time when none is given (minutes after midnight)
  leadDays: number; // a deadline's runway when none is given
  habitsFromCalendar: boolean; // calendar events tick habits (Settings → Habits)
  deadlineLook: DeadlineLook; // when a deadline changes colour, and to what (Settings → Tasks & Deadlines)
}

export const prefs: Prefs = { weekStartsOn: 1, hour24: false, defaultEventMin: 60, dueMinutes: 17 * 60, leadDays: 14, habitsFromCalendar: true, deadlineLook: DEFAULT_DEADLINE_LOOK };

export function setPrefs(p: Partial<Prefs>) {
  const weekChanged = p.weekStartsOn !== undefined && p.weekStartsOn !== prefs.weekStartsOn;
  Object.assign(prefs, p);
  if (weekChanged) setWeekStart(prefs.weekStartsOn);
}

/** Does this browser's language use a 24-hour clock? (The guest page follows the guest, not you.) */
export const localeUses24h = () => {
  try {
    const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hc === 'h23' || hc === 'h24';
  } catch {
    return false;
  }
};
