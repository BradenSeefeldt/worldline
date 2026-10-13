import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { parseCommand } from './commands';
import { DEFAULT_CALENDARS } from '../data/mock';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 9, 7, 19, 10); // Wed Oct 7 2026, 7:10 PM
let n = 0;
const ev = (title: string, d: number, h: number, m: number, mins = 60, extra: Partial<CalEvent> = {}): CalEvent => {
  const start = new Date(2026, 9, d, h, m).getTime();
  return { id: `e${n++}`, calendarId: 'research', title, start, end: start + mins * 60_000, allDay: false, ...extra };
};
const allDay = (title: string, d: number, days = 1): CalEvent => ({
  id: `e${n++}`, calendarId: 'personal', title, allDay: true,
  start: new Date(2026, 9, d).getTime(), end: new Date(2026, 9, d + days).getTime(),
});

const EVENTS: CalEvent[] = [
  ev('Plasma meeting', 1, 11, 0), // last week (past)
  ev('Plasma meeting', 8, 11, 0), // this week
  ev('Plasma meeting', 15, 11, 0), // next week
  ev('Meeting with Alex', 9, 14, 0),
  ev('Suresh meeting', 12, 10, 0),
  ev('Dept lunch talk', 6, 12, 0), // this week, already past
  ev('Dept lunch talk', 8, 12, 0),
  ev('Dept lunch talk', 13, 12, 0),
  ev('Journal club', 9, 11, 0),
  ev('Gym', 8, 7, 30),
  ev('Dentist', 13, 9, 0),
  ev('Telecon with Robin', 8, 16, 0, 30),
  ev('Catch up with Sam', 9, 16, 0),
  ev('Thesis writing', 8, 9, 0, 120),
  ev('Group meeting', 8, 10, 0),
  ev('Project meeting', 8, 15, 0),
  allDay('Cottage weekend', 17, 2),
];

const fmt = (t: number) => format(t, 'EEE MMM d HH:mm');
const run = (s: string) => parseCommand(s, EVENTS, DEFAULT_CALENDARS, NOW);
const target = (s: string) => run(s)?.matches[0]?.title;
const firstWhen = (s: string) => fmt(run(s)!.matches[0].start);
const planned = (s: string) => {
  const c = run(s)!;
  const p = c.plan(c.matches[0])!;
  return `${fmt(p.start)} → ${format(p.end, 'HH:mm')}`;
};

describe('commands: finding the event', () => {
  it('skip plasma meeting this week → this week’s, not last or next', () => {
    expect(run('skip plasma meeting this week')!.kind).toBe('delete');
    expect(firstWhen('skip plasma meeting this week')).toBe('Thu Oct 8 11:00');
    expect(firstWhen('Skip the plasma meeting next week.')).toBe('Thu Oct 15 11:00');
  });
  it('with no scope, picks the next upcoming one', () => {
    expect(firstWhen('cancel plasma meeting')).toBe('Thu Oct 8 11:00');
  });
  it('handles possessives, missing apostrophes, plurals and typos', () => {
    expect(target("cancel Alex's meeting")).toBe('Meeting with Alex');
    expect(target('cancel Alexs meeting')).toBe('Meeting with Alex');
    expect(target('skip journl club')).toBe('Journal club');
    expect(target('delete telcon with robin')).toBe('Telecon with Robin');
  });
  it('“all” applies to every match in scope', () => {
    const c = run('skip all lunch talks this week')!;
    expect(c.all).toBe(true);
    expect(c.matches.map((e) => fmt(e.start))).toEqual(['Thu Oct 8 12:00']); // Tuesday's already happened
  });
  it('narrows by time: “the 3pm meeting tomorrow”', () => {
    expect(target('skip the 3pm meeting tomorrow')).toBe('Project meeting');
  });
  it('does not delete on a partial match — “gym membership” is not “Gym”', () => {
    const c = run('Cancel gym membership tomorrow')!;
    expect(c.kind).toBe('delete');
    expect(c.matches).toHaveLength(0);
  });
});

describe('commands: moving', () => {
  it("move Alex's meeting to tues at 3pm", () => {
    expect(run('move Alexs meeting to tues at 3pm')!.kind).toBe('move');
    expect(planned('move Alexs meeting to tues at 3pm')).toBe('Tue Oct 13 15:00 → 16:00');
  });
  it('Move doctor tommorrow to friday — misspelled date words still work', () => {
    const events = [...EVENTS, ev('Doctor', 8, 15, 0)];
    const c = parseCommand('Move doctor tommorrow to friday', events, DEFAULT_CALENDARS, NOW)!;
    expect(c.matches[0]?.title).toBe('Doctor');
    const p = c.plan(c.matches[0])!;
    expect(`${fmt(p.start)} → ${format(p.end, 'HH:mm')}`).toBe('Fri Oct 9 15:00 → 16:00');
    expect(parseCommand('skip plasma meeting on thrusday', EVENTS, DEFAULT_CALENDARS, NOW)!.matches[0]?.title).toBe('Plasma meeting');
  });
  it('date only keeps the time; time only keeps the day', () => {
    expect(planned('move journal club to friday next week')).toBe('Fri Oct 16 11:00 → 12:00');
    expect(planned('move dentist to 4pm')).toBe('Tue Oct 13 16:00 → 17:00');
    expect(planned('reschedule dentist to monday')).toBe('Mon Oct 12 09:00 → 10:00');
  });
  it('bare 1–7 is PM, ranges set the length, "next week" moves by 7 days', () => {
    expect(planned('move suresh meeting to friday at 2')).toBe('Fri Oct 9 14:00 → 15:00');
    expect(planned('move suresh meeting to thursday 2-4')).toBe('Thu Oct 8 14:00 → 16:00');
    expect(planned('push suresh meeting to next week')).toBe('Mon Oct 19 10:00 → 11:00');
    expect(planned('Reschedule the journal club to tomorrow morning.')).toBe('Thu Oct 8 09:00 → 10:00');
  });
  it('moves the occurrence nearest the new time, even one earlier today', () => {
    const events = [...EVENTS, ev('Jordan meeting', 7, 14, 0), ev('Jordan meeting', 21, 14, 0)];
    const c = parseCommand('move Jordan meeting to friday at 3', events, DEFAULT_CALENDARS, NOW)!;
    expect(fmt(c.matches[0].start)).toBe('Wed Oct 7 14:00'); // today's (just happened) → Friday
    const d = parseCommand('move Jordan meeting to oct 23 at 3', events, DEFAULT_CALENDARS, NOW)!;
    expect(fmt(d.matches[0].start)).toBe('Wed Oct 21 14:00');
  });
  it('moves all-day events by date', () => {
    const c = run('move cottage weekend to oct 24')!;
    const p = c.plan(c.matches[0])!;
    expect(p.allDay).toBe(true);
    expect(format(p.start, 'MMM d')).toBe('Oct 24');
    expect(format(p.end - 1, 'MMM d')).toBe('Oct 25');
  });
  it('a title that merely starts with "move" is a new event, not a command', () => {
    expect(run('Move out of apartment saturday')).toBeNull();
    expect(run('Lunch with Sam tomorrow')).toBeNull();
  });
});

describe('commands: shifting and resizing', () => {
  it('shift suresh meeting by half hour early', () => {
    const c = run('shift suresh meeting by half hour early')!;
    expect(c.kind).toBe('shift');
    expect(c.summary).toBe('30 min earlier');
    expect(planned('shift suresh meeting by half hour early')).toBe('Mon Oct 12 09:30 → 10:30');
  });
  it('understands many phrasings', () => {
    expect(planned('push the telecon back an hour')).toBe('Thu Oct 8 17:00 → 17:30');
    expect(planned('delay telecon by 15 min')).toBe('Thu Oct 8 16:15 → 16:45');
    expect(planned('move journal club 30 minutes later')).toBe('Fri Oct 9 11:30 → 12:30');
    expect(planned('bring group meeting forward 30 minutes')).toBe('Thu Oct 8 09:30 → 10:30');
    expect(planned('move standup earlier by 15 min'.replace('standup', 'group meeting'))).toBe('Thu Oct 8 09:45 → 10:45');
    expect(planned('push dentist back a day')).toBe('Wed Oct 14 09:00 → 10:00');
    expect(planned('push plasma meeting back a week')).toBe('Thu Oct 15 11:00 → 12:00');
    expect(planned('shift suresh meeting an hour and a half later')).toBe('Mon Oct 12 11:30 → 12:30');
  });
  it('takes the direction next to the amount, not from the title', () => {
    expect(target('push catch up with Sam back 30 min')).toBe('Catch up with Sam');
    expect(planned('push catch up with Sam back 30 min')).toBe('Fri Oct 9 16:30 → 17:30');
  });
  it('extend / shorten change only the end', () => {
    expect(planned('extend thesis writing by 30 min')).toBe('Thu Oct 8 09:00 → 11:30');
    expect(planned('shorten thesis writing by an hour')).toBe('Thu Oct 8 09:00 → 10:00');
  });
});

describe('commands: deadlines', () => {
  const dl = (id: string, title: string, d: number, extra: Partial<CalEvent> = {}): CalEvent => {
    const t = new Date(2026, 9, d, 17).getTime();
    return { id, calendarId: 'research', title, start: t, end: t, allDay: false, kind: 'deadline', ...extra };
  };
  const evs = [...EVENTS, dl('n', 'NSERC proposal', 28), dl('a', 'AAS abstract', 5), dl('x', 'Old report', 20, { done: true })];
  const c = (s: string) => parseCommand(s, evs, DEFAULT_CALENDARS, NOW)!;
  it('ticks off a deadline in several phrasings, including an overdue one', () => {
    expect(c('done NSERC proposal').kind).toBe('done');
    expect(c('done NSERC proposal').matches[0].id).toBe('n');
    expect(c('mark nserc proposal as done').matches[0].id).toBe('n');
    expect(c('submitted the NSERC deadline').matches[0].id).toBe('n');
    expect(c('finished AAS abstract').matches[0].id).toBe('a'); // was due Oct 5
  });
  it('ignores ones already done, and ordinary events', () => {
    expect(c('done old report').matches).toHaveLength(0);
    expect(c('done journal club').matches).toHaveLength(0);
  });
  it('moving a deadline keeps it a moment', () => {
    const m = c('push NSERC deadline to nov 20');
    expect(m.kind).toBe('move');
    const p = m.plan(m.matches[0])!;
    expect(format(p.start, 'MMM d HH:mm')).toBe('Nov 20 17:00');
    expect(p.end).toBe(p.start);
  });
});

describe('commands: tasks', () => {
  const task = (id: string, title: string, d?: number): CalEvent => {
    const t = new Date(2026, 9, d ?? 7).getTime();
    return { id, calendarId: '', title, start: t, end: t + 86_400_000, allDay: true, kind: 'task' };
  };
  const evs = [...EVENTS, task('t1', 'Email Jordan the plots'), task('t2', 'Pay rent', 9), task('t3', 'Buy coffee filters')];
  const c = (s: string) => parseCommand(s, evs, DEFAULT_CALENDARS, NOW)!;
  it('done / drop / move work on tasks', () => {
    expect(c('done email jordan').matches[0].id).toBe('t1');
    expect(c('drop coffee filters').matches[0].id).toBe('t3');
    const m = c('move pay rent to monday');
    expect(m.matches[0].id).toBe('t2');
    expect(format(m.plan(m.matches[0])!.start, 'EEE MMM d')).toBe('Mon Oct 12');
  });
});
