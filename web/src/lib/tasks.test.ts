import { describe, expect, it } from 'vitest';
import { bucketTasks, guessKind, overdueDays, stripTaskPrefix, taskFromParsed, type Task } from './tasks';
import { parseQuick } from './quickparse';
import { DEFAULT_CALENDARS } from '../data/mock';
import { encodeDay } from './zone';

const NOW = new Date(2026, 9, 7, 19, 10);
const kind = (s: string) => guessKind(s, parseQuick(stripTaskPrefix(s), DEFAULT_CALENDARS, NOW));

describe('event, task or deadline?', () => {
  it.each([
    ['email Jordan the plots', 'task'],
    ['buy coffee filters', 'task'],
    ['Remind me to call the bank', 'task'],
    ['pay rent friday', 'task'],
    ['renew passport by oct 28', 'deadline'], // "by <date>" is a deadline
    ['submit receipts tomorrow', 'task'],
    ['todo: dentist friday 3pm', 'task'], // explicit prefix wins
    ['- water plants', 'task'],
    ['lunch with Sam tomorrow 12:30', 'event'],
    ['Lunch with Sam', 'event'], // a meal implies a time
    ['call Alex tomorrow at 3', 'event'], // a time makes it an appointment
    ["Mom's birthday oct 10", 'event'], // a date but not an action
    ['NSERC proposal due nov 18', 'deadline'],
    ['gym every monday 7am', 'event'],
  ])('%s → %s', (s, k) => expect(kind(s)).toBe(k));

  it('task title keeps the place; due is the date', () => {
    const t = taskFromParsed(parseQuick('pick up package at Shoppers friday', DEFAULT_CALENDARS, NOW));
    expect(t.title).toBe('Pick up package at Shoppers');
    expect(new Date(t.due!).toDateString()).toBe(new Date(2026, 9, 9).toDateString());
  });
});

describe('task buckets', () => {
  const day = (d: number) => encodeDay(new Date(2026, 9, d).getTime());
  let n = 0;
  const t = (title: string, extra: Partial<Task> = {}): Task => ({ id: `t${n++}`, title, createdAt: n, ...extra });
  const tasks = [
    t('overdue', { due: day(4) }),
    t('today', { due: day(7) }),
    t('later', { due: day(12) }),
    t('soon', { due: day(9) }),
    t('anytime'),
    t('step without date', { parentId: 'd1' }),
    t('done earlier today', { done: true, doneAt: new Date(2026, 9, 7, 10).getTime() }),
    t('done yesterday', { done: true, doneAt: new Date(2026, 9, 6, 10).getTime() }),
  ];
  const b = bucketTasks(tasks, NOW.getTime());
  it('sorts into Today / Upcoming / Anytime', () => {
    expect(b.today.map((x) => x.title)).toEqual(['overdue', 'today']);
    expect(b.upcoming.map((x) => x.title)).toEqual(['soon', 'later']);
    expect(b.anytime.map((x) => x.title)).toEqual(['anytime']); // checklist steps stay with their deadline
    expect(b.doneToday.map((x) => x.title)).toEqual(['done earlier today']);
  });
  it('overdue days', () => expect(overdueDays(tasks[0], NOW.getTime())).toBe(3));
});

describe('scheduled tasks and stats', () => {
  const base = { createdAt: 1 };
  it('a task blocked for today shows in Today; blocked for later stays where it was', () => {
    const tasks: Task[] = [{ id: 'g', title: 'Go grocery shopping', ...base }, { id: 'h', title: 'Haircut', ...base }];
    const sched = new Map([['g', new Date(2026, 9, 7, 12).getTime()], ['h', new Date(2026, 9, 9, 12).getTime()]]);
    const b = bucketTasks(tasks, NOW.getTime(), sched);
    expect(b.today.map((x) => x.id)).toEqual(['g']);
    expect(b.anytime.map((x) => x.id)).toEqual(['h']); // not moved, not hidden
  });
  it('counts done today and this week', async () => {
    const { doneStats } = await import('./tasks');
    const at = (d: number, h = 10) => new Date(2026, 9, d, h).getTime();
    const tasks: Task[] = [
      { id: '1', title: 'a', done: true, doneAt: at(7), ...base },
      { id: '2', title: 'b', done: true, doneAt: at(7, 15), ...base },
      { id: '3', title: 'c', done: true, doneAt: at(5), ...base }, // Monday
      { id: '4', title: 'd', done: true, doneAt: at(2), ...base }, // last week
      { id: '5', title: 'e', ...base },
    ];
    const s = doneStats(tasks, NOW.getTime());
    expect(s).toMatchObject({ today: 2, week: 3, perDay: [1, 0, 2, 0, 0, 0, 0], todayIndex: 2 });
  });
});
