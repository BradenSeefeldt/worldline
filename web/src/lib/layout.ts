// Pure geometry: where each event box goes. No React, so it is unit-tested directly.

export interface Placed<T> {
  item: T;
  col: number; // which sub-column of the day this event sits in
  cols: number; // how many sub-columns its overlap cluster needs
  span: number; // how many sub-columns it may stretch across (free space to its right)
}

/**
 * Side-by-side layout for timed events within one day.
 * Events that overlap (directly or through a chain) form a cluster; each cluster is split
 * into the fewest columns such that no two events in a column overlap.
 * `start`/`end` are minutes; very short events are treated as `minDur` long so they stay clickable.
 */
export function layoutDay<T extends { start: number; end: number }>(items: T[], minDur = 20): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Placed<T>[] = [];
  let cluster: { item: T; col: number; start: number; end: number }[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const n = colEnds.length;
    for (const c of cluster) {
      let span = 1;
      for (let k = c.col + 1; k < n; k++) {
        if (cluster.some((o) => o.col === k && o.start < c.end && c.start < o.end)) break;
        span++;
      }
      out.push({ item: c.item, col: c.col, cols: n, span });
    }
    cluster = [];
    colEnds = [];
    clusterEnd = -Infinity;
  };

  for (const it of sorted) {
    const end = Math.max(it.end, it.start + minDur);
    if (it.start >= clusterEnd) flush();
    let col = colEnds.findIndex((e) => e <= it.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(end);
    } else colEnds[col] = end;
    cluster.push({ item: it, col, start: it.start, end });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}

/**
 * Stack horizontal bars (spanning day columns a..b inclusive) into the lowest free lane.
 * Items must already be sorted in the order they should claim lanes.
 */
export function assignLanes<T extends { a: number; b: number }>(items: T[]): (T & { lane: number })[] {
  const laneEnds: number[] = [];
  return items.map((it) => {
    let lane = laneEnds.findIndex((end) => end < it.a);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.b);
    } else laneEnds[lane] = it.b;
    return { ...it, lane };
  });
}
