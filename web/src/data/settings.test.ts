import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';
import { resolveTheme } from '../lib/theme';

describe('saved settings', () => {
  it('nothing saved (or an older version that had no settings): the defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
  });
  it('a setting added later fills in from the default; ones you set are kept', () => {
    const s = normalizeSettings({ weekStartsOn: 0, hour24: true, suggest: { focus: false } });
    expect(s.weekStartsOn).toBe(0);
    expect(s.hour24).toBe(true);
    expect(s.suggest).toEqual({ stale: true, focus: false, add: true, habit: true });
    expect(s.linkDefaults).toEqual(DEFAULT_SETTINGS.linkDefaults);
  });
  it('anything invalid falls back: a dark theme in the light slot, an hours window that ends before it starts', () => {
    const s = normalizeSettings({ themeLight: 'midnight', themeDark: 'paper', dayStartHour: 99, startView: 'year', linkDefaults: { windowStart: 600, windowEnd: 540 } });
    expect([s.themeLight, s.themeDark, s.dayStartHour, s.startView]).toEqual(['light', 'dark', 8, 'week']);
    expect([s.linkDefaults.windowStart, s.linkDefaults.windowEnd]).toEqual([540, 1020]);
  });
});

describe('which theme to paint', () => {
  const pair = { light: 'paper' as const, dark: 'midnight' as const };
  it('following the Mac: your light theme by day, your dark theme by night', () => {
    expect(resolveTheme('system', false, pair).theme).toBe('paper');
    expect(resolveTheme('system', true, pair)).toEqual({ theme: 'midnight', dark: true });
  });
  it('one chosen theme: always that one', () => expect(resolveTheme('sage', true, pair).theme).toBe('sage'));
  it('no pair chosen: plain Light / Dark, as before', () => expect(resolveTheme('system', true).theme).toBe('dark'));
});
