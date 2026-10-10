import { describe, expect, it } from 'vitest';
import blindJson from './quickparse.blind.json';
import quickparseSrc from './quickparse.test.ts?raw';
import commandsSrc from './commands.test.ts?raw';
import typeaheadSrc from './typeahead.test.ts?raw';
import suggestSrc from './suggest.test.ts?raw';
import comboSrc from './quickparse.combo.test.ts?raw';
import { parseHabitLog } from './habitlog';
import { dayOf, type Habit } from './habits';
import { makeDemoHabits } from '../data/mock';

const NOW = new Date(2026, 9, 7, 19, 10); // Wed Oct 7 2026, 7:10 PM
const TODAY = dayOf(NOW.getTime());
const h = (title: string, extra: Partial<Habit> = {}): Habit => ({ id: title, title, color: '#000', kind: 'check', goal: 1, period: 'day', createdAt: 0, ...extra });
const HABITS: Habit[] = [
  h('Gym', { goal: 3, period: 'week', match: 'gym' }),
  h('Read', { kind: 'count', goal: 20, unit: 'pages' }),
  h('Meditate'),
  h('Run', { kind: 'count', goal: 15, period: 'week', unit: 'km' }),
  h('Write', { kind: 'count', goal: 30, unit: 'min', match: 'writing' }),
  h('Climb', { goal: 2, period: 'week' }),
  h('No phone in bed', { kind: 'avoid', goal: 0 }),
];
const log = (s: string) => {
  const p = parseHabitLog(s, HABITS, NOW);
  return p && { habit: p.habit.title, day: p.day - TODAY, amount: p.amount };
};

describe('logging a habit from quick add', () => {
  it('reads the ways people say it', () => {
    expect(log('did gym')).toEqual({ habit: 'Gym', day: 0, amount: 1 });
    expect(log('gym done')).toEqual({ habit: 'Gym', day: 0, amount: 1 });
    expect(log('Logged gym yesterday.')).toEqual({ habit: 'Gym', day: -1, amount: 1 });
    expect(log('meditated')).toEqual({ habit: 'Meditate', day: 0, amount: 1 });
    expect(log('meditated this morning')).toEqual({ habit: 'Meditate', day: 0, amount: 1 });
    expect(log('read 20 pages')).toEqual({ habit: 'Read', day: 0, amount: 20 });
    expect(log('Read 35')).toEqual({ habit: 'Read', day: 0, amount: 35 });
    expect(log('did my reading')).toEqual({ habit: 'Read', day: 0, amount: 20 }); // the day's goal
    expect(log('ran 5k')).toEqual({ habit: 'Run', day: 0, amount: 5 });
    expect(log('ran 5.5 km last night')).toEqual({ habit: 'Run', day: -1, amount: 5.5 });
    expect(log('wrote for 45 min')).toEqual({ habit: 'Write', day: 0, amount: 45 });
    expect(log('writing 1.5 hours')).toEqual({ habit: 'Write', day: 0, amount: 90 }); // hours → the habit's minutes
    expect(log('20pages read')).toEqual({ habit: 'Read', day: 0, amount: 20 });
  });
  it('steps aside unless every word is accounted for', () => {
    for (const s of [
      'gym', 'Read', 'climb', 'meditate', // a bare name is an event title
      'gym tomorrow', 'gym at 7', 'Gym 7am', 'gym with Sam', 'gym 2', 'meditate 10 min', // dates, times, people, nonsense amounts
      'read 20 pages tomorrow', 'Read flux tube paper friday', "read Alex's draft", 'run to the store',
      'ran 5 pages', // a unit that isn't the habit's
      'did the dishes', 'done email Jordan', 'did 20', // a verb, but no habit
      'no phone in bed', 'did no phone in bed', // avoid habits aren't logged from the box
      'read 20 pages and ran 5k', // two things at once
    ]) expect(log(s), s).toBeNull();
  });
  it('archived habits and ambiguity are left alone', () => {
    expect(parseHabitLog('did gym', [h('Gym', { archived: true })], NOW)).toBeNull();
    expect(parseHabitLog('did gym', [h('Gym'), h('gym', { id: 'b' })], NOW)).toBeNull(); // two fit: don't guess
  });

  // The promise: adding this never changes what quick add already does. Every sentence from the
  // parser's and commands' test sets, plus the stress test's building blocks recombined, must be left alone —
  // even with habits named like the things in them.
  it('claims none of the existing quick-add test sentences', () => {
    const habits = [...HABITS, ...makeDemoHabits(NOW).habits, h('Coffee'), h('Dentist'), h('Call Jan', { kind: 'count', goal: 1, unit: 'min' })];
    const strings = (src: string) => [...src.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2]);
    const blind = (blindJson as { input: string }[]).map((c) => c.input);
    const cases = [...strings(quickparseSrc), ...strings(commandsSrc), ...strings(typeaheadSrc), ...strings(suggestSrc)].filter((s) => /[a-z]/i.test(s) && s.length > 2);
    // The stress test's parts, recombined (title × date × time).
    const combo = comboSrc;
    const listOf = (name: string) => {
      const block = combo.slice(combo.indexOf(`const ${name}`), combo.indexOf('];', combo.indexOf(`const ${name}`)));
      return [...block.matchAll(/\[\s*'([^']*)'|(?<!\[)'([^']+)'(?=,\s*(?:'|$|\n))/g)].map((m) => m[1] ?? m[2]).filter(Boolean);
    };
    const titles = listOf('TITLES'), dates = listOf('DATES').filter((d) => !/^\d{4}-/.test(d)), times = listOf('TIMES').filter((t) => !/^\d\d:\d\d$/.test(t));
    expect(titles.length).toBeGreaterThan(5);
    expect(dates.length).toBeGreaterThan(5);
    expect(times.length).toBeGreaterThan(5);
    const combos: string[] = [];
    for (const t of titles) for (const d of dates) for (const tm of times) combos.push(`${t} ${d} ${tm}`, `${d} ${tm} ${t}`);
    // And sentences built on purpose around the habits' own words.
    const tricky = [
      'Gym tomorrow 7am', 'gym w/ Sam fri 6pm', 'Run club thursday at 6', 'Writing session 2-4', 'thesis writing block mon 9-12',
      'Read group 3pm', 'Meditation class sat 10am', 'climbing with Sasha saturday', 'push gym back 30 min', 'skip gym tomorrow',
      'move climb to friday', 'done gym fees', 'did gym fees', 'read 20 pages of Dune friday', 'ran into Alex at noon',
      'cancel all gym', 'extend writing by 30 min', 'gym every monday at 6pm', 'run 5k every saturday at 8am',
    ];
    const all = [...blind, ...cases, ...combos, ...tricky];
    expect(all.length).toBeGreaterThan(1500);
    const claimed = all.filter((s) => parseHabitLog(s, habits, NOW));
    expect(claimed).toEqual([]);
  });
});
