// Reordering the sidebar's cards by dragging. Pure: the order that's saved, and where a dragged card would land.

/** The saved order, made safe: unknown ids dropped, cards the saved order doesn't know (added in a later version)
 *  kept at their default place relative to their neighbours. */
export function orderedIds(saved: string[] | undefined, all: string[]): string[] {
  const known = (saved ?? []).filter((id, i, a) => all.includes(id) && a.indexOf(id) === i);
  const out = [...known];
  all.forEach((id, i) => {
    if (out.includes(id)) return;
    const before = all.slice(0, i).reverse().find((x) => out.includes(x)); // put it after its default predecessor
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, id);
  });
  return out;
}

/** Move one id to a new index. */
export function moveTo(order: string[], id: string, index: number): string[] {
  const rest = order.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

/**
 * Where a dragged card lands: its index among the others, from where its middle is now. `tops`/`heights` are the
 * cards' positions when the drag began (in order, the dragged one included); `center` is the dragged card's middle now.
 */
export function landingIndex(tops: number[], heights: number[], from: number, center: number): number {
  let index = 0;
  for (let i = 0; i < tops.length; i++) if (i !== from && center > tops[i] + heights[i] / 2) index++;
  return index;
}

/** How far each other card slides to make room while one is dragged from `from` to `to` (0 for most). */
export function shiftFor(i: number, from: number, to: number, room: number): number {
  if (i === from) return 0;
  if (from < to && i > from && i <= to) return -room; // the card moved down: those it passed move up
  if (from > to && i >= to && i < from) return room; // moved up: those it passed move down
  return 0;
}
