// Realistic phrases (typed and dictated) and what a person would expect them to mean.
// Reference time: Wed Oct 7 2026, 7:10 PM.
import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { parseQuick } from './quickparse';
import { DEFAULT_CALENDARS } from '../data/mock';

const NOW = new Date(2026, 9, 7, 19, 10);

interface Expect {
  title: string;
  start: string; // 'yyyy-MM-dd HH:mm' for timed, 'yyyy-MM-dd' for all-day
  end?: string; // timed: 'HH:mm' or 'yyyy-MM-dd HH:mm'; all-day: last day 'yyyy-MM-dd'
  loc?: string;
  cal?: string;
}

const CASES: [string, Expect][] = [
  // basics
  ["Lunch with Sam tomorrow 12:30 at Fran's", { title: 'Lunch with Sam', start: '2026-10-08 12:30', end: '13:30', loc: "Fran's" }],
  ['group meeting fri 3-4pm', { title: 'Group meeting', start: '2026-10-09 15:00', end: '16:00' }],
  ['dentist next tuesday', { title: 'Dentist', start: '2026-10-13' }],
  ['conference oct 20 - oct 23', { title: 'Conference', start: '2026-10-20', end: '2026-10-23' }],
  ['climbing sat 2pm for 3h #social', { title: 'Climbing', start: '2026-10-10 14:00', end: '17:00', cal: 'social' }],
  ['Gym', { title: 'Gym', start: '2026-10-07 20:00', end: '21:00' }],
  ['seminar friday 11am', { title: 'Seminar', start: '2026-10-09 11:00' }],
  ['pick up package', { title: 'Pick up package', start: '2026-10-07 20:00' }],

  // bare numbers: 1–7 mean PM, a passed time rolls to tomorrow
  ['call mom at 7', { title: 'Call mom', start: '2026-10-08 19:00' }],
  ['call mom at 7:30', { title: 'Call mom', start: '2026-10-07 19:30' }],
  ['call mom at 8', { title: 'Call mom', start: '2026-10-08 08:00' }],
  ['Call Will at 4', { title: 'Call Will', start: '2026-10-08 16:00' }],
  ['dinner with Ana sat 7 at Pai', { title: 'Dinner with Ana', start: '2026-10-10 19:00', loc: 'Pai' }],
  ['call Alex tomorrow 3:30', { title: 'Call Alex', start: '2026-10-08 15:30' }],
  ['dentist tmrw 9am', { title: 'Dentist', start: '2026-10-08 09:00' }],
  ['3pm tomorrow call with Jordan', { title: 'Call with Jordan', start: '2026-10-08 15:00' }],
  ['flux tube meeting w/ Alex wed 10am', { title: 'Flux tube meeting w/ Alex', start: '2026-10-14 10:00' }],

  // dictation style
  ['Lunch with Sam tomorrow at noon.', { title: 'Lunch with Sam', start: '2026-10-08 12:00' }],
  ['Schedule a meeting with Alex on Friday at 2 PM.', { title: 'Meeting with Alex', start: '2026-10-09 14:00' }],
  ['Remind me to call the bank tomorrow at 9', { title: 'Call the bank', start: '2026-10-08 09:00' }],
  ['Dentist appointment on October 15th at 3:30 p.m.', { title: 'Dentist appointment', start: '2026-10-15 15:30' }],
  ['Add coffee with Priya Thursday at 10:30 a.m.', { title: 'Coffee with Priya', start: '2026-10-08 10:30' }],
  ['tomorrow: dentist 9am', { title: 'Dentist', start: '2026-10-08 09:00' }],

  // misspelled date words
  ['dentist tommorrow at 3', { title: 'Dentist', start: '2026-10-08 15:00' }],
  ['lunch with Sam tomorow', { title: 'Lunch with Sam', start: '2026-10-08 12:00' }],
  ['seminar wendesday 2pm', { title: 'Seminar', start: '2026-10-14 14:00' }],
  ['call Alex tursday at 10', { title: 'Call Alex', start: '2026-10-08 10:00' }],
  ['call Alex thrusday at 10', { title: 'Call Alex', start: '2026-10-08 10:00' }],
  ['run saterday mornign', { title: 'Run', start: '2026-10-10 09:00' }],
  ['tax deadline febuary 28', { title: 'Tax deadline', start: '2027-02-28 17:00', end: '17:00' }],
  ['drinks tonihgt at 8', { title: 'Drinks', start: '2026-10-07 20:00' }],
  ['Moon party at noon tomorrow', { title: 'Moon party', start: '2026-10-08 12:00' }],
  ['ice cream sundae friday', { title: 'Ice cream sundae', start: '2026-10-09' }],

  // names that look like dates
  ['Coffee with June tomorrow at 10', { title: 'Coffee with June', start: '2026-10-08 10:00' }],
  ['Call Jan friday', { title: 'Call Jan', start: '2026-10-09' }],
  ['Meeting with May on May 5', { title: 'Meeting with May', start: '2027-05-05' }],

  // parts of day and meals
  ['run tomorrow morning', { title: 'Run', start: '2026-10-08 09:00' }],
  ['Drinks friday evening', { title: 'Drinks', start: '2026-10-09 18:00' }],
  ['study tonight', { title: 'Study', start: '2026-10-07 19:00' }],
  ['run tomorrow morning at 7', { title: 'Run', start: '2026-10-08 07:00' }],
  ['breakfast with Lee at 7', { title: 'Breakfast with Lee', start: '2026-10-08 07:00' }],
  ['lunch with Sam friday', { title: 'Lunch with Sam', start: '2026-10-09 12:00' }],
  ['dinner with Ana', { title: 'Dinner with Ana', start: '2026-10-08 18:30' }],
  ['Thanksgiving dinner monday', { title: 'Thanksgiving dinner', start: '2026-10-12 18:30' }],

  // ranges
  ['11-1 tomorrow workshop', { title: 'Workshop', start: '2026-10-08 11:00', end: '13:00' }],
  ['office hours between 2 and 3 tomorrow', { title: 'Office hours', start: '2026-10-08 14:00', end: '15:00' }],
  ['from 2 to 4 friday review', { title: 'Review', start: '2026-10-09 14:00', end: '16:00' }],
  ['2pm to 4:30pm thursday tutorial', { title: 'Tutorial', start: '2026-10-08 14:00', end: '16:30' }],
  ['late shift 10pm-2am sat', { title: 'Late shift', start: '2026-10-10 22:00', end: '2026-10-11 02:00' }],
  ['9-10 standup monday', { title: 'Standup', start: '2026-10-12 09:00', end: '10:00' }],
  ['movie tonight 8-10', { title: 'Movie', start: '2026-10-07 20:00', end: '22:00' }],
  ['12-1 lunch seminar thursday', { title: 'Lunch seminar', start: '2026-10-08 12:00', end: '13:00' }],

  // spoken / unusual time formats
  ['call Jordan at three tomorrow', { title: 'Call Jordan', start: '2026-10-08 15:00' }],
  ['meeting at half past 3 friday', { title: 'Meeting', start: '2026-10-09 15:30' }],
  ['seminar quarter to 5 thursday', { title: 'Seminar', start: '2026-10-08 16:45' }],
  ['telecon at 1530 thursday', { title: 'Telecon', start: '2026-10-08 15:30' }],
  ["meeting at 3 o'clock tomorrow", { title: 'Meeting', start: '2026-10-08 15:00' }],
  ['submit abstract eod friday', { title: 'Submit abstract', start: '2026-10-09 17:00' }],

  // dates
  ['rent due the 15th', { title: 'Rent due', start: '2026-10-15 17:00', end: '17:00' }],
  ['haircut on the 3rd', { title: 'Haircut', start: '2026-11-03' }],
  ['flight dec 3rd 9am', { title: 'Flight', start: '2026-12-03 09:00' }],
  ['committee meeting thursday after next at 2', { title: 'Committee meeting', start: '2026-10-15 14:00' }],
  ['tax deadline 10/30', { title: 'Tax deadline', start: '2026-10-30 17:00', end: '17:00' }],
  ['party in 2 weeks', { title: 'Party', start: '2026-10-21' }],
  ['check simulation in 2 hours', { title: 'Check simulation', start: '2026-10-07 21:10' }],
  ['check simulation in 30 min', { title: 'Check simulation', start: '2026-10-07 19:40', end: '20:40' }],
  ['retreat this weekend', { title: 'Retreat', start: '2026-10-10', end: '2026-10-11' }],
  ["Mom's birthday oct 10", { title: "Mom's birthday", start: '2026-10-10' }],
  ['submit report by friday', { title: 'Submit report', start: '2026-10-09 17:00', end: '17:00' }],
  ['Cottage weekend oct 16-18', { title: 'Cottage weekend', start: '2026-10-16', end: '2026-10-18' }],
  ['road trip this weekend', { title: 'Road trip', start: '2026-10-10', end: '2026-10-11' }],
  ['coffee with Ana tues at 3', { title: 'Coffee with Ana', start: '2026-10-13 15:00' }],
  ['all day hackathon saturday', { title: 'Hackathon', start: '2026-10-10' }],

  // durations
  ['workout tomorrow 6pm for an hour and a half', { title: 'Workout', start: '2026-10-08 18:00', end: '19:30' }],
  ['call with Alex friday 10am for 30 minutes', { title: 'Call with Alex', start: '2026-10-09 10:00', end: '10:30' }],
  ['review tomorrow 2pm 1h30', { title: 'Review', start: '2026-10-08 14:00', end: '15:30' }],
  ['standup monday 9:30 for 15 min', { title: 'Standup', start: '2026-10-12 09:30', end: '09:45' }],
  ['defense practice friday 1pm for half an hour', { title: 'Defense practice', start: '2026-10-09 13:00', end: '13:30' }],

  // locations
  ["Coffee at Balzac's with Sam tomorrow 3", { title: 'Coffee with Sam', start: '2026-10-08 15:00', loc: "Balzac's" }],
  ['Talk at the Fields Institute friday 4pm', { title: 'Talk', start: '2026-10-09 16:00', loc: 'the Fields Institute' }],
  ['Look at data tomorrow', { title: 'Look at data', start: '2026-10-08' }],
  ['meeting in MP 1318 thursday 2pm', { title: 'Meeting', start: '2026-10-08 14:00', loc: 'MP 1318' }],
  ['yoga @ the studio tomorrow 7am', { title: 'Yoga', start: '2026-10-08 07:00', loc: 'the studio' }],
  ['work from home friday', { title: 'Work from home', start: '2026-10-09' }],
  ['Dinner at 7pm at Pai', { title: 'Dinner', start: '2026-10-08 19:00', loc: 'Pai' }],
  ['study session at the library tomorrow 2pm', { title: 'Study session at the library', start: '2026-10-08 14:00' }],
];

function describeResult(r: ReturnType<typeof parseQuick>) {
  const out: Expect = {
    title: r.title,
    start: format(r.start, r.allDay ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm'),
  };
  return { ...out, end: r.allDay ? format(r.end - 1, 'yyyy-MM-dd') : format(r.end, 'yyyy-MM-dd HH:mm'), loc: r.location, cal: r.calendarId };
}

describe('parseQuick — realistic phrases', () => {
  it.each(CASES)('%s', (input, want) => {
    const got = describeResult(parseQuick(input, DEFAULT_CALENDARS, NOW));
    expect(got.title).toBe(want.title);
    expect(got.start).toBe(want.start);
    if (want.end) expect(got.end).toBe(want.end.length === 5 ? `${want.start.slice(0, 10)} ${want.end}` : want.end);
    else if (want.start.length === 10) expect(got.end).toBe(want.start); // one all-day day
    else expect(got.end).toBe(format(new Date(want.start.replace(' ', 'T')).getTime() + 3600_000, 'yyyy-MM-dd HH:mm'));
    expect(got.loc).toBe(want.loc);
    if (want.cal) expect(got.cal).toBe(want.cal);
  });
});

describe('parseQuick — repeating events', () => {
  const r = (s: string) => parseQuick(s, DEFAULT_CALENDARS, NOW);
  const f = (t: number) => format(t, 'EEE MMM d HH:mm');
  it.each([
    ['weekly meeting on friday with Alex 3pm', 'Meeting with Alex', 'Fri Oct 9 15:00', { freq: 'weekly', interval: 1, byDay: [5] }],
    ['Alex 1:1 every other friday at 3', 'Alex 1:1', 'Fri Oct 9 15:00', { freq: 'weekly', interval: 2, byDay: [5] }],
    ['Alex meeting fridays at 3', 'Alex meeting', 'Fri Oct 9 15:00', { freq: 'weekly', interval: 1, byDay: [5] }],
    ['standup every weekday 9:30', 'Standup', 'Thu Oct 8 09:30', { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] }],
    ['gym every mon and wed 7am', 'Gym', 'Mon Oct 12 07:00', { freq: 'weekly', interval: 1, byDay: [1, 3] }],
    ['daily standup at 10am', 'Standup', 'Thu Oct 8 10:00', { freq: 'daily', interval: 1 }],
    ['journal club on tuesdays and thursdays at noon', 'Journal club', 'Thu Oct 8 12:00', { freq: 'weekly', interval: 1, byDay: [2, 4] }],
    ['Seminar biweekly wednesday 2pm', 'Seminar', 'Wed Oct 14 14:00', { freq: 'weekly', interval: 2, byDay: [3] }],
  ])('%s', (input, title, start, rule) => {
    const p = r(input);
    expect(p.title).toBe(title);
    expect(f(p.start)).toBe(start);
    expect(p.recurrence).toMatchObject(rule);
  });
  it('monthly and yearly all-day', () => {
    const rent = r('rent monthly on the 1st');
    expect(rent.allDay).toBe(true);
    expect(format(rent.start, 'MMM d')).toBe('Nov 1');
    expect(rent.recurrence).toMatchObject({ freq: 'monthly', interval: 1 });
    const bday = r("Mom's birthday every year oct 20");
    expect(bday.title).toBe("Mom's birthday");
    expect(bday.recurrence).toMatchObject({ freq: 'yearly' });
  });
  it('end dates: until, for N weeks, for N sessions', () => {
    expect(format(r('group meeting every monday 10am until dec 14').recurrence!.until!, 'MMM d HH:mm')).toBe('Dec 14 23:59');
    expect(format(r('yoga every tuesday 6pm for 10 weeks').recurrence!.until!, 'MMM d')).toBe('Dec 21'); // last class Dec 15
    expect(format(r('therapy every thursday at 4 for 6 sessions').recurrence!.until!, 'MMM d')).toBe('Nov 12');
  });
  it('ordinary sentences do not become repeats', () => {
    expect(r('move Alex meeting to tues at 3pm').recurrence).toBeUndefined();
    expect(r('Cottage weekend oct 16-18').recurrence).toBeUndefined();
    expect(r('Lunch with Sam tomorrow').recurrence).toBeUndefined();
  });
});

describe('parseQuick — deadlines', () => {
  const r = (s: string) => parseQuick(s, DEFAULT_CALENDARS, NOW);
  const f = (t: number) => format(t, 'EEE MMM d HH:mm');
  it.each([
    ['NSERC proposal due nov 18', 'NSERC proposal', 'Wed Nov 18 17:00', 14],
    ['abstract due fri 3pm', 'Abstract due', 'Fri Oct 9 15:00', 14],
    ['Deadline for AAS abstract oct 30', 'AAS abstract', 'Fri Oct 30 17:00', 14],
    ['finish slides by thursday', 'Finish slides', 'Thu Oct 8 17:00', 14],
    ['thesis ch 4 due in 2 weeks, needs 10 days', 'Thesis ch 4', 'Wed Oct 21 17:00', 10],
    ['grant report due dec 1 needs 3 weeks', 'Grant report', 'Tue Dec 1 17:00', 21],
    ['referee report due tomorrow morning', 'Referee report', 'Thu Oct 8 09:00', 14],
  ])('%s', (input, title, due, lead) => {
    const p = r(input);
    expect(p.title).toBe(title);
    expect(f(p.start)).toBe(due);
    expect(p.end).toBe(p.start);
    expect(p.allDay).toBe(false);
    expect(p.deadline?.leadDays).toBe(lead);
  });
  it('ordinary events are not deadlines', () => {
    expect(r('Dinner hosted by Sam friday').deadline).toBeUndefined();
    expect(r('Lunch with Sam tomorrow').deadline).toBeUndefined();
    expect(r('Dinner hosted by Sam friday').title).toBe('Dinner hosted by Sam');
  });
});
