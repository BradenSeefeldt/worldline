// Reminders: which alerts fall when, and who gets none.
import { describe, expect, it } from 'vitest';
import { alertFor, describeAlert, upcomingAlerts, type AlertDefaults } from './alerts';
import { encodeEvent } from './recurrence';
import type { CalEvent, CalendarSource } from '../data/types';

const D: AlertDefaults = { alertMin: 10, alertAllDayMin: -540, alertDeadlineMin: 60 };
const cal = (x: Partial<CalendarSource> = {}): CalendarSource => ({ id: 'c', name: 'Personal', color: '#000', visible: true, account: 'Local', ...x });
const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const ev = (x: Partial<CalEvent>): CalEvent => ({ id: 'e', calendarId: 'c', title: 'Group meeting', start: t(20, 14), end: t(20, 15), allDay: false, ...x });
const day = (from: number) => [from, from + 3 * 86_400_000] as const;

describe('when an alert falls', () => {
  it('a timed event: the default (10 min) before it starts, with the time and place', () => {
    const [a] = upcomingAlerts([ev({ location: 'Room 1203' })], [cal()], D, ...day(t(20, 0)));
    expect(a.at).toBe(t(20, 13, 50));
    expect(a.title).toBe('Group meeting');
    expect(a.body).toMatch(/In 10 min · .*Room 1203/);
  });
  it('its own alert wins over the default; null means none', () => {
    expect(upcomingAlerts([ev({ alert: 60 })], [cal()], D, ...day(t(20, 0)))[0].at).toBe(t(20, 13));
    expect(upcomingAlerts([ev({ alert: null })], [cal()], D, ...day(t(20, 0)))).toEqual([]);
    expect(upcomingAlerts([ev({})], [cal()], { ...D, alertMin: null }, ...day(t(20, 0)))).toEqual([]);
  });
  it('an all-day event: counted from the start of its day (9 AM on the day)', () => {
    const allDay = encodeEvent(ev({ allDay: true, title: 'Conference', start: t(21, 0), end: t(22, 0) }));
    expect(upcomingAlerts([allDay], [cal()], D, ...day(t(20, 0)))[0].at).toBe(t(21, 9));
  });
  it('a deadline: before the due moment; a done one: never', () => {
    const due = ev({ kind: 'deadline', title: 'NSERC proposal', start: t(20, 17), end: t(20, 17) });
    const [a] = upcomingAlerts([due], [cal()], D, ...day(t(20, 0)));
    expect(a.at).toBe(t(20, 16));
    expect(a.title).toBe('⚑ NSERC proposal');
    expect(upcomingAlerts([{ ...due, done: true }], [cal()], D, ...day(t(20, 0)))).toEqual([]);
  });
  it('a repeating event: one alert per occurrence, each with its own key', () => {
    const weekly = ev({ id: 's', recurrence: { freq: 'weekly', interval: 1 }, start: t(19, 10), end: t(19, 11) });
    const list = upcomingAlerts([weekly], [cal()], D, t(18, 0), t(28, 0));
    expect(list.map((a) => a.at)).toEqual([t(19, 9, 50), t(26, 9, 50)]);
    expect(new Set(list.map((a) => a.key)).size).toBe(list.length);
    expect(list.every((a) => a.eventId === 's')).toBe(true);
  });
  it('only alerts inside the window, soonest first', () => {
    const list = upcomingAlerts([ev({ id: 'b', start: t(20, 16), end: t(20, 17) }), ev({ id: 'a' })], [cal()], D, t(20, 13, 55), t(20, 18));
    expect(list.map((a) => a.eventId)).toEqual(['b']); // a's alert (13:50) is before the window
  });
});

describe('who gets none', () => {
  it('a subscribed calendar: none unless its alerts are turned on (or the event has its own)', () => {
    const sub = cal({ url: 'https://example.org/feed.ics' });
    expect(alertFor(ev({}), sub, D)).toBeNull();
    expect(alertFor(ev({}), { ...sub, alerts: true }, D)).toBe(10);
    expect(alertFor(ev({ alert: 5 }), sub, D)).toBe(5);
  });
  it('a calendar with alerts turned off; a hidden calendar', () => {
    expect(alertFor(ev({}), cal({ alerts: false }), D)).toBeNull();
    expect(upcomingAlerts([ev({})], [cal({ visible: false })], D, ...day(t(20, 0)))).toEqual([]);
  });
  it('items drawn from the task list', () => {
    expect(upcomingAlerts([ev({ kind: 'task' })], [cal()], D, ...day(t(20, 0)))).toEqual([]);
  });
});

it('describes alerts in words', () => {
  expect(describeAlert(10, false)).toBe('10 minutes before');
  expect(describeAlert(0, false)).toBe('When it starts');
  expect(describeAlert(-540, true)).toBe('On the day, at 9 AM');
  expect(describeAlert(null, false)).toBe('None');
  expect(describeAlert(180, false)).toBe('3 hours before');
});
