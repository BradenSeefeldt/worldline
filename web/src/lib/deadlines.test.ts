import { describe, expect, it } from 'vitest';
import { countdown, urgency } from './deadlines';
import { setPrefs, prefs } from './prefs';
import { DEFAULT_DEADLINE_LOOK, normalizeSettings } from '../data/settings';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 9, 7, 19, 10).getTime();
const DAY = 86_400_000;
const dl = (inDays: number, leadDays = 14): CalEvent => ({
  id: 'd', calendarId: '', title: 'X', start: NOW + inDays * DAY, end: NOW + inDays * DAY, allDay: false, kind: 'deadline', leadDays,
});

describe('deadline colour = runway left', () => {
  it.each([
    [30, 'plenty'], // runway hasn't started
    [9, 'plenty'], // 64% of 14 days left
    [8, 'halfway'], // 57%
    [4, 'halfway'], // 29%
    [3, 'closing'], // 21%
    [2.5, 'closing'],
    [2, 'soon'], // the last 48 hours: red
    [0.5, 'soon'],
    [-0.1, 'overdue'],
  ])('%s days out on a 14-day runway → %s', (d, u) => expect(urgency(dl(d), NOW)).toBe(u));
  it('scales with the runway length', () => {
    expect(urgency(dl(9, 28), NOW)).toBe('halfway'); // 32% of 4 weeks
    expect(urgency(dl(9, 10), NOW)).toBe('plenty'); // 90% of 10 days
  });
  it('countdown text', () => {
    expect(countdown(dl(-2), NOW)).toBe('Overdue · 2 days');
    expect(countdown(dl(16), NOW)).toBe('16 days');
  });
  it('follows Settings: thresholds and colours', () => {
    try {
      setPrefs({ deadlineLook: { ...DEFAULT_DEADLINE_LOOK, halfway: 80, closing: 50, soonHours: 24 } });
      expect(urgency(dl(10), NOW)).toBe('halfway'); // 71% left: under 80%
      expect(urgency(dl(6), NOW)).toBe('closing'); // 43%
      expect(urgency(dl(1.5), NOW)).toBe('closing'); // 36 h out: not yet red with a 24-hour window
      expect(urgency(dl(0.9), NOW)).toBe('soon');
      setPrefs({ deadlineLook: { ...DEFAULT_DEADLINE_LOOK, soonHours: 0 } });
      expect(urgency(dl(0.1), NOW)).toBe('closing'); // red turned off: orange to the end
    } finally {
      setPrefs({ deadlineLook: DEFAULT_DEADLINE_LOOK });
    }
    expect(prefs.deadlineLook.colors.soon).toBe('#ef3b3b');
  });
  it('a saved look that makes no sense falls back to the usual one', () => {
    const l = normalizeSettings({ deadlineLook: { halfway: 30, closing: 70, soonHours: -5, colors: { soon: 'red', plenty: '#ABCDEF' } } }).deadlineLook;
    expect(l).toMatchObject({ halfway: 30, closing: 30, soonHours: 48, colors: { soon: '#ef3b3b', plenty: '#abcdef' } });
  });
});
