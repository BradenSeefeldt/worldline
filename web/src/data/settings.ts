// Settings → the preferences the app reads. One saved object; anything missing or malformed (an older version saved
// it, or a setting was added since) falls back to the default, so loading never breaks on an old file.
import type { ViewMode } from './types';
import type { ThemeId } from '../lib/theme';
import { THEMES } from '../lib/theme';

export type StartPage = 'last' | 'calendar' | 'habits' | 'projects';
export type SuggestionKey = 'stale' | 'focus' | 'add' | 'habit';

export interface AppSettings {
  // General
  weekStartsOn: 0 | 1;
  hour24: boolean;
  startPage: StartPage;
  keepRunning: boolean; // closing the window keeps the app running (the Mac app)
  autoUpdate: boolean; // check for (and download) new versions once a day (the Mac app)
  // Appearance (the theme itself stays `theme`: 'system' = follow the Mac, using these two)
  themeLight: ThemeId;
  themeDark: ThemeId;
  eventStyle: 'filled' | 'stripe';
  // Calendar
  startView: ViewMode;
  dayStartHour: number; // where a day scrolls to when it isn't today
  hideWeekends: boolean;
  weekNumbers: boolean;
  defaultEventMin: number;
  // Calendars
  subsRefreshMin: number;
  // Tasks & Deadlines
  dueMinutes: number;
  leadDays: number;
  /** A deadline's colour as its due time gets closer (Settings → Tasks & Deadlines): yellow below `halfway` per cent
   *  of the runway left, orange below `closing` per cent, red in the last `soonHours` hours, then the overdue colour. */
  deadlineLook: DeadlineLook;
  suggest: Record<SuggestionKey, boolean>; // each kind of quick-add suggestion on / off
  // Habits
  habitsFromCalendar: boolean;
  // Alerts (reminders): the defaults, minutes before (null = none) — lib/alerts.ts
  alertMin: number | null;
  alertAllDayMin: number | null;
  alertDeadlineMin: number | null;
  // Scheduling: what a new link starts with
  linkDefaults: { durationMin: number; windowStart: number; windowEnd: number; singleUse: boolean; bufferMin: number; noticeMin: number };
}

export interface DeadlineLook {
  halfway: number;
  closing: number;
  soonHours: number;
  colors: { plenty: string; halfway: string; closing: string; soon: string; overdue: string };
}
export const DEFAULT_DEADLINE_LOOK: DeadlineLook = {
  halfway: 60,
  closing: 25,
  soonHours: 48,
  colors: { plenty: '#20b26b', halfway: '#e0ae00', closing: '#f2801d', soon: '#ef3b3b', overdue: '#b0123a' },
};

export const DEFAULT_SETTINGS: AppSettings = {
  weekStartsOn: 1,
  hour24: false,
  startPage: 'last',
  keepRunning: true,
  autoUpdate: true,
  themeLight: 'light',
  themeDark: 'dark',
  eventStyle: 'filled',
  startView: 'week',
  dayStartHour: 8,
  hideWeekends: false,
  weekNumbers: false,
  defaultEventMin: 60,
  subsRefreshMin: 30,
  dueMinutes: 17 * 60,
  leadDays: 14,
  deadlineLook: DEFAULT_DEADLINE_LOOK,
  suggest: { stale: true, focus: true, add: true, habit: true },
  habitsFromCalendar: true,
  alertMin: 10,
  alertAllDayMin: null,
  alertDeadlineMin: 60,
  linkDefaults: { durationMin: 60, windowStart: 9 * 60, windowEnd: 17 * 60, singleUse: true, bufferMin: 0, noticeMin: 0 },
};

const LIGHT = new Set(THEMES.filter((t) => t.dark === false).map((t) => t.id));
const DARK = new Set(THEMES.filter((t) => t.dark === true).map((t) => t.id));
const VIEWS: ViewMode[] = ['day', '3day', 'week', 'month'];
const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : d);
const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d);
const minOrNone = (x: unknown, lo: number, hi: number, d: number | null) => (x === null ? null : num(x, lo, hi, d as number) ?? d);

/** Saved settings (any shape) → complete, valid settings. */
const HEX = /^#[0-9a-f]{6}$/i;
function normalizeLook(raw: unknown): DeadlineLook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const c = (r.colors && typeof r.colors === 'object' ? r.colors : {}) as Record<string, unknown>;
  const d = DEFAULT_DEADLINE_LOOK;
  const color = (k: keyof DeadlineLook['colors']) => (typeof c[k] === 'string' && HEX.test(c[k] as string) ? (c[k] as string).toLowerCase() : d.colors[k]);
  const halfway = num(r.halfway, 5, 95, d.halfway);
  return {
    halfway,
    closing: Math.min(num(r.closing, 1, 90, d.closing), halfway),
    soonHours: num(r.soonHours, 0, 14 * 24, d.soonHours),
    colors: { plenty: color('plenty'), halfway: color('halfway'), closing: color('closing'), soon: color('soon'), overdue: color('overdue') },
  };
}

export function normalizeSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AppSettings, unknown>>;
  const d = DEFAULT_SETTINGS;
  const sg = (r.suggest && typeof r.suggest === 'object' ? r.suggest : {}) as Record<string, unknown>;
  const ld = (r.linkDefaults && typeof r.linkDefaults === 'object' ? r.linkDefaults : {}) as Record<string, unknown>;
  const windowStart = num(ld.windowStart, 0, 23.5 * 60, d.linkDefaults.windowStart);
  const windowEnd = num(ld.windowEnd, 0.5 * 60, 24 * 60, d.linkDefaults.windowEnd);
  return {
    weekStartsOn: r.weekStartsOn === 0 ? 0 : 1,
    hour24: bool(r.hour24, d.hour24),
    startPage: (['last', 'calendar', 'habits', 'projects'] as const).includes(r.startPage as StartPage) ? (r.startPage as StartPage) : d.startPage,
    keepRunning: bool(r.keepRunning, d.keepRunning),
    autoUpdate: bool(r.autoUpdate, d.autoUpdate),
    themeLight: LIGHT.has(r.themeLight as ThemeId) ? (r.themeLight as ThemeId) : d.themeLight,
    themeDark: DARK.has(r.themeDark as ThemeId) ? (r.themeDark as ThemeId) : d.themeDark,
    eventStyle: r.eventStyle === 'stripe' ? 'stripe' : 'filled',
    startView: VIEWS.includes(r.startView as ViewMode) ? (r.startView as ViewMode) : d.startView,
    dayStartHour: num(r.dayStartHour, 0, 20, d.dayStartHour),
    hideWeekends: bool(r.hideWeekends, d.hideWeekends),
    weekNumbers: bool(r.weekNumbers, d.weekNumbers),
    defaultEventMin: num(r.defaultEventMin, 5, 480, d.defaultEventMin),
    subsRefreshMin: num(r.subsRefreshMin, 5, 24 * 60, d.subsRefreshMin),
    dueMinutes: num(r.dueMinutes, 0, 24 * 60 - 1, d.dueMinutes),
    leadDays: num(r.leadDays, 1, 365, d.leadDays),
    deadlineLook: normalizeLook(r.deadlineLook),
    suggest: { stale: bool(sg.stale, true), focus: bool(sg.focus, true), add: bool(sg.add, true), habit: bool(sg.habit, true) },
    habitsFromCalendar: bool(r.habitsFromCalendar, d.habitsFromCalendar),
    alertMin: 'alertMin' in r ? minOrNone(r.alertMin, 0, 7 * 1440, d.alertMin) : d.alertMin,
    alertAllDayMin: 'alertAllDayMin' in r ? minOrNone(r.alertAllDayMin, -1440, 7 * 1440, d.alertAllDayMin) : d.alertAllDayMin,
    alertDeadlineMin: 'alertDeadlineMin' in r ? minOrNone(r.alertDeadlineMin, 0, 7 * 1440, d.alertDeadlineMin) : d.alertDeadlineMin,
    linkDefaults: {
      durationMin: num(ld.durationMin, 5, 480, d.linkDefaults.durationMin),
      windowStart: windowStart < windowEnd ? windowStart : d.linkDefaults.windowStart,
      windowEnd: windowStart < windowEnd ? windowEnd : d.linkDefaults.windowEnd,
      singleUse: bool(ld.singleUse, d.linkDefaults.singleUse),
      bufferMin: num(ld.bufferMin, 0, 120, d.linkDefaults.bufferMin),
      noticeMin: num(ld.noticeMin, 0, 14 * 24 * 60, d.linkDefaults.noticeMin),
    },
  };
}
