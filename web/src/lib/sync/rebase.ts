// When changes arrive from another device, the undo history is moved onto them: undoing your own last edit must not
// also undo (or bring back) what the other device did. Pure.
type Rec = { id: string };

/** Apply the difference between `before` and `after` (records by id) to `target` (an older copy of the same list). */
export function rebaseList<T extends Rec>(target: T[], before: T[], after: T[]): T[] {
  if (before === after) return target;
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  const out = target.filter((r) => !(b.has(r.id) && !a.has(r.id))).map((r) => (b.get(r.id) !== a.get(r.id) && a.has(r.id) ? a.get(r.id)! : r));
  const have = new Set(out.map((r) => r.id));
  for (const r of after) if (!b.has(r.id) && !have.has(r.id)) out.push(r);
  return out;
}

/** The same for maps of maps (habit history): outer keys that changed take the new value. */
export function rebaseNested<T extends Record<string, unknown>>(target: T, before: T, after: T): T {
  if (before === after) return target;
  const out: Record<string, unknown> = { ...target };
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] === after[k]) continue;
    if (k in after) out[k] = after[k];
    else delete out[k];
  }
  return out as T;
}
