import { describe, expect, it } from 'vitest';
import { landingIndex, moveTo, orderedIds, shiftFor } from './reorder';

const ALL = ['tasks', 'deadlines', 'habits', 'scheduling', 'calendars'];

describe('the saved order', () => {
  it('nothing saved: the default order', () => expect(orderedIds(undefined, ALL)).toEqual(ALL));
  it('a saved order is used as is', () => expect(orderedIds(['calendars', 'tasks', 'habits', 'deadlines', 'scheduling'], ALL)).toEqual(['calendars', 'tasks', 'habits', 'deadlines', 'scheduling']));
  it('a card the saved order doesn’t know (new in a later version) goes after its usual neighbour', () => {
    expect(orderedIds(['calendars', 'tasks', 'deadlines', 'scheduling'], ALL)).toEqual(['calendars', 'tasks', 'deadlines', 'habits', 'scheduling']);
  });
  it('unknown or repeated ids are dropped', () => expect(orderedIds(['tasks', 'gone', 'tasks', ...ALL], ALL)).toEqual(ALL));
});

describe('dragging', () => {
  // five cards, 100 px tall, 10 px apart
  const tops = [0, 110, 220, 330, 440], h = [100, 100, 100, 100, 100];
  it('a card dragged past the middle of the next one swaps with it; not before', () => {
    expect(landingIndex(tops, h, 0, 50 + 40)).toBe(0); // moved 40 px: not past the next card's middle (160)
    expect(landingIndex(tops, h, 0, 50 + 120)).toBe(1);
    expect(landingIndex(tops, h, 0, 9999)).toBe(4);
    expect(landingIndex(tops, h, 4, -50)).toBe(0);
  });
  it('the cards it passes slide by its height + the gap', () => {
    expect([0, 1, 2, 3, 4].map((i) => shiftFor(i, 1, 3, 110))).toEqual([0, 0, -110, -110, 0]);
    expect([0, 1, 2, 3, 4].map((i) => shiftFor(i, 3, 0, 110))).toEqual([110, 110, 110, 0, 0]);
  });
  it('dropping puts it there', () => {
    expect(moveTo(ALL, 'tasks', 3)).toEqual(['deadlines', 'habits', 'scheduling', 'tasks', 'calendars']);
    expect(moveTo(ALL, 'calendars', 0)).toEqual(['calendars', 'tasks', 'deadlines', 'habits', 'scheduling']);
  });
});
