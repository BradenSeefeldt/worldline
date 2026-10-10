import { describe, expect, it } from 'vitest';
import { assignLanes, layoutDay } from './layout';

const ev = (id: string, start: number, end: number) => ({ id, start, end });
const byId = <T extends { item: { id: string } }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.item.id, x]));

describe('layoutDay', () => {
  it('gives non-overlapping events the full width', () => {
    const r = byId(layoutDay([ev('a', 600, 660), ev('b', 660, 720)]));
    expect(r.a).toMatchObject({ col: 0, cols: 1, span: 1 });
    expect(r.b).toMatchObject({ col: 0, cols: 1, span: 1 });
  });

  it('splits overlapping events into columns', () => {
    const r = byId(layoutDay([ev('a', 840, 900), ev('b', 840, 870), ev('c', 870, 960)]));
    expect(r.a.cols).toBe(2);
    expect(r.a.col).toBe(0);
    expect(r.b.col).toBe(1);
    expect(r.c.col).toBe(1); // reuses b's column once b has ended
  });

  it('lets an event stretch into free columns to its right', () => {
    // a overlaps b and c, but b and c don't overlap each other, so 2 columns suffice.
    // d starts after everything ends, so it begins a new full-width cluster.
    const r = byId(layoutDay([ev('a', 600, 720), ev('b', 600, 650), ev('c', 650, 700), ev('d', 720, 780)]));
    expect(r.a.cols).toBe(2);
    expect(r.d).toMatchObject({ col: 0, cols: 1, span: 1 }); // new cluster
  });

  it('treats tiny events as minDur long so they stay clickable', () => {
    const r = byId(layoutDay([ev('a', 600, 601), ev('b', 610, 640)], 20));
    expect(r.a.cols).toBe(2);
  });
});

describe('assignLanes', () => {
  it('stacks overlapping bars and reuses freed lanes', () => {
    const out = assignLanes([
      { id: 'a', a: 0, b: 2 },
      { id: 'b', a: 1, b: 1 },
      { id: 'c', a: 3, b: 4 },
    ]);
    expect(out.map((x) => x.lane)).toEqual([0, 1, 0]);
  });
});
