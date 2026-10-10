import { describe, expect, it } from 'vitest';
import { countdown, urgency } from './deadlines';
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
    [0.5, 'closing'],
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
});
