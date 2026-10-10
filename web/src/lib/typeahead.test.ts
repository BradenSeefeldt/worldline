import { describe, expect, it } from 'vitest';
import { phraseAction, typeahead } from './typeahead';
import { expand } from './recurrence';
import { DEFAULT_CALENDARS } from '../data/mock';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 9, 7, 19, 10); // Wed Oct 7 2026, 7:10 PM
const t = (m: number, d: number, h: number) => new Date(2026, m, d, h).getTime();
const one = (id: string, title: string, start: number, cal = 'research'): CalEvent => ({
  id, calendarId: cal, title, start, end: start + 3_600_000, allDay: false,
});
const ALEX: CalEvent = { ...one('alex', 'Meeting with Alex', t(8, 4, 15)), recurrence: { freq: 'weekly', interval: 1, byDay: [5] } };
const RAW = [
  ALEX,
  one('j1', 'Journal club', t(9, 9, 11), 'dept'),
  one('l1', 'Lunch with Sam', t(8, 20, 12), 'social'),
  one('l2', 'Lunch with Sam', t(8, 27, 12), 'social'),
  one('g', 'Gym', t(9, 8, 7)),
];
const events = expand(RAW, NOW.getTime() - 120 * 86_400_000, NOW.getTime() + 60 * 86_400_000);
const ta = (s: string) => typeahead(s, events, [ALEX], DEFAULT_CALENDARS, [], NOW).map((x) => x.phrase);

describe('typeahead', () => {
  it('completes event names after a command verb, with the day', () => {
    expect(ta('skip al')).toContain('Skip Meeting with Alex friday');
    expect(ta('skip al')).toContain('Skip all recurring Meeting with Alex');
    expect(ta('push gy')).toEqual(['Push Gym tomorrow back 15 min']);
    expect(ta('move jour')[0]).toBe('Move Journal club friday to ');
  });
  it('tolerates a typo in the partial name', () => {
    expect(ta('skip jorn')).toContain('Skip Journal club friday');
  });
  it('offers known event names for new events, keeping what was typed', () => {
    expect(ta('lunch with s')).toContain('Lunch with Sam #social');
    expect(ta('lunch with s tomorrow 1pm')).toContain('Lunch with Sam tomorrow 1pm #social');
    expect(ta('alex')).toContain('Meeting with Alex #research');
  });
  it('stays quiet once the sentence has moved past the name, or is too short', () => {
    expect(ta('move journal club to fri')).toEqual([]);
    expect(ta('s')).toEqual([]);
  });
  it('“done …” offers open tasks and deadlines', () => {
    const task: CalEvent = { id: 'tk', calendarId: '', title: 'Email Jordan the plots', start: t(9, 7, 0), end: t(9, 8, 0), allDay: true, kind: 'task' };
    const out = typeahead('done em', [...events, task], [ALEX], DEFAULT_CALENDARS, [], NOW).map((x) => x.phrase);
    expect(out).toEqual(['Done Email Jordan the plots']);
  });
  it('never offers exactly what is already typed', () => {
    expect(ta('Lunch with Sam')).not.toContain('Lunch with Sam');
  });
});

describe('suggestion icons follow what the sentence does', () => {
  const act = (p: string) => phraseAction(p, DEFAULT_CALENDARS, NOW);
  it('commands by their verb, new things by their kind', () => {
    expect(act('Skip journal club thursday')).toBe('delete');
    expect(act('cancel all recurring Alex meetings')).toBe('delete');
    expect(act('Move pay rent to tomorrow')).toBe('move');
    expect(act('Push gym back 15 min')).toBe('shift');
    expect(act('shift telecon 30 min later')).toBe('shift');
    expect(act('extend thesis writing by 30 min')).toBe('resize');
    expect(act('done email Jordan')).toBe('done');
    expect(act('Lunch with Sam tomorrow 12:30')).toBe('event');
    expect(act('Work on NSERC proposal friday at 2 for 2h')).toBe('event');
    expect(act('email Jordan the plots')).toBe('task');
    expect(act('NSERC proposal due nov 18')).toBe('deadline');
  });
});
