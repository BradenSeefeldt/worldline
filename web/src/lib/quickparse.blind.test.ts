// Independent test set written without looking at the parser (see quickparse.blind.json).
import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { parseQuick } from './quickparse';
import { DEFAULT_CALENDARS } from '../data/mock';
import cases from './quickparse.blind.json';

const NOW = new Date(2026, 9, 7, 19, 10);

describe('parseQuick — blind set', () => {
  it.each(cases as { input: string; title: string; start: string; end: string; loc?: string; cal?: string }[])('$input', (c) => {
    const r = parseQuick(c.input, DEFAULT_CALENDARS, NOW);
    const timed = c.start.length > 10;
    const got = {
      title: r.title,
      start: format(r.start, r.allDay ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm'),
      end: r.allDay ? format(r.end - 1, 'yyyy-MM-dd') : format(r.end, 'yyyy-MM-dd HH:mm'),
      loc: r.location,
      cal: r.calendarId,
    };
    expect(got).toEqual({ title: c.title, start: c.start, end: timed || !r.allDay ? c.end : c.end, loc: c.loc, cal: c.cal ?? got.cal });
  });
});
