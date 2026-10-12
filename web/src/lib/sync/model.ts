// Sync, part 1: the app's data as a CRDT document (Yjs) — pure functions, no network.
//
// Each collection (events, tasks, …) is a map from id to a record, and each record is a map from field to value, so
// two devices editing different items, or different fields of one item, merge cleanly. A device writes only the
// fields it changed. The same field changed on two devices before either saw the other's change: both settle on the
// same one, but Yjs picks it by the two editing sessions' random ids (`clientID`) — not by which edit was later.
// Deleting removes the id (and beats a concurrent edit). Only the board's columns store a place in their list (`_o`,
// see ORDERED). Habit history (habit → day → amount) is one flat map keyed "habit␁day".
// Only what belongs to you syncs — your data, name, home zone and the settings about you — not what belongs to a
// device (its theme, its current view, its window behaviour).
import * as Y from 'yjs';

export const COLLECTIONS = ['calendars', 'events', 'tasks', 'habits', 'projects', 'threads', 'projectLog', 'links'] as const;
export const NESTED = ['habitLog', 'habitNotes'] as const;
export const PROFILE = ['myName', 'homeZone', 'defaultCalendarId', 'skipped', 'dismissed'] as const;
export const SETTINGS = ['weekStartsOn', 'hour24', 'defaultEventMin', 'dueMinutes', 'leadDays', 'suggest', 'habitsFromCalendar', 'linkDefaults', 'dayStartHour', 'hideWeekends', 'weekNumbers', 'subsRefreshMin', 'alertMin', 'alertAllDayMin', 'alertDeadlineMin'] as const;

/** The synced data's format. Bump it when a synced record changes shape in a way an older copy would get wrong (and
 *  convert old records when reading). A device finding a newer format in the document stops syncing and asks to be
 *  updated, rather than writing old-format records over new ones. */
export const SYNC_SCHEMA = 2; // 2: Projects pages can hold code blocks (an older copy would show them as nothing, then save that)
/** The newest format any device has written into this document (1 for documents from before this was recorded). */
export const docSchema = (doc: Y.Doc) => Math.max(1, Number(doc.getMap('meta').get('schema')) || 1);

type Rec = { id: string } & Record<string, unknown>;
type Nested = Record<string, Record<string | number, unknown>>;
/** The part of the app's state that syncs. */
export type Synced = { [K in (typeof COLLECTIONS)[number]]: Rec[] } & { [K in (typeof NESTED)[number]]: Nested } & {
  [K in (typeof PROFILE)[number]]: unknown;
} & { settings: Record<string, unknown> };

const SEP = '\u0001';
const ORDER = '_o';
/** Lists whose order is yours (you drag the board's columns): each record keeps a place (`_o`, a number the list is
 *  sorted by), written only when the record is added or moved — never renumbered, so a deletion costs nothing. Other
 *  lists keep no order in the document: each device keeps its own, new arrivals at the end. (Documents from before
 *  this have `_o` on every record, its old index: still read, never rewritten.) */
const ORDERED = new Set<string>(['projects']);

/** Yjs stores JSON: no undefined (a missing field is "not set"). */
const clean = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Set one value (undefined: remove it), only if it differs — so writing the same thing again sends nothing. */
function put(y: Y.Map<unknown>, key: string, value: unknown) {
  const v = clean(value);
  if (v === undefined) {
    if (y.has(key)) y.delete(key);
  } else if (!same(y.get(key), v)) y.set(key, v);
}

/**
 * Only what changed here between `prev` and `next` is written, field by field. The document may already hold another
 * device's newer changes that this device's data doesn't show yet (they're shown ~150 ms after they arrive); writing
 * this device's stale copy of those fields would undo them. For the same reason, a record changed here that the
 * document no longer has was deleted on another device: the deletion stands. `prev` missing: write everything.
 */
function writeCollection(doc: Y.Doc, name: string, prev: Rec[] | undefined, next: Rec[]) {
  if (prev === next) return;
  const ymap = doc.getMap<Y.Map<unknown>>(name);
  const prevById = prev && new Map(prev.map((r) => [r.id, r]));
  for (const rec of next) {
    const before = prevById?.get(rec.id);
    if (before === rec) continue; // untouched here
    let y = ymap.get(rec.id);
    if (!y) {
      if (before) continue; // deleted on another device
      y = new Y.Map();
      ymap.set(rec.id, y);
    }
    const fields = before ? new Set([...Object.keys(before), ...Object.keys(rec)]) : new Set([...Object.keys(rec), ...y.keys()]);
    for (const f of fields) if (f !== ORDER && !(before && same(before[f], rec[f]))) put(y, f, rec[f]);
  }
  const keep = new Set(next.map((r) => r.id));
  for (const id of prev ? prev.map((r) => r.id) : [...ymap.keys()]) if (!keep.has(id) && ymap.has(id)) ymap.delete(id);
  if (ORDERED.has(name)) writeOrder(ymap, prev, next);
}

/** The indexes of the longest run of `vals` (in order, not necessarily adjacent) that strictly increases. O(n²): for
 *  short lists only (the board's columns). */
function increasing(vals: (number | undefined)[]): Set<number> {
  const len = vals.map(() => 0), from = vals.map(() => -1);
  let best = -1;
  vals.forEach((v, i) => {
    if (v === undefined) return;
    len[i] = 1;
    for (let j = 0; j < i; j++)
      if (vals[j] !== undefined && vals[j]! < v && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        from[i] = j;
      }
    if (best < 0 || len[i] > len[best]) best = i;
  });
  const out = new Set<number>();
  for (let i = best; i >= 0; i = from[i]) out.add(i);
  return out;
}

/** Records of an ordered list added or moved here get a new place between their neighbours; the rest keep theirs.
 *  (Moved: not in the longest run that kept its order since `prev` — with no `prev`, the longest run already in order
 *  in the document.) */
function writeOrder(ymap: Y.Map<Y.Map<unknown>>, prev: Rec[] | undefined, next: Rec[]) {
  const live = next.filter((r) => ymap.has(r.id));
  const rows = live.map((r) => ymap.get(r.id)!);
  const key = (y: Y.Map<unknown>) => (typeof y.get(ORDER) === 'number' ? (y.get(ORDER) as number) : undefined);
  const prevAt = prev && new Map(prev.map((r, i) => [r.id, i]));
  const stays = increasing(prevAt ? live.map((r) => prevAt.get(r.id)) : rows.map(key));
  const place = rows.map((y, i) => (stays.has(i) ? key(y) : undefined));
  let worn = false; // places split so finely they no longer differ (many moves into one gap): renumber the list, once
  for (let i = 0; i < rows.length; i++) {
    if (place[i] !== undefined) continue;
    let j = i;
    while (j < rows.length && place[j] === undefined) j++; // a run to place: i … j-1, spread evenly between lo and hi
    const lo = i > 0 ? place[i - 1] : undefined, hi = j < rows.length ? place[j] : undefined;
    for (let k = i; k < j; k++) {
      const n = k - i + 1;
      if (lo === undefined) place[k] = hi === undefined ? k : hi - (j - k);
      else if (hi === undefined || hi <= lo) place[k] = lo + n; // (hi ≤ lo: another device reordered those meanwhile)
      else {
        place[k] = lo + ((hi - lo) * n) / (j - i + 1);
        worn ||= !(place[k]! > place[k - 1]! && place[k]! < hi);
      }
    }
    i = j - 1;
  }
  rows.forEach((y, i) => {
    const p = worn ? i : place[i]!;
    if (key(y) !== p) y.set(ORDER, p);
  });
}

/** Habit history: as for records, only the days changed here are written. */
function writeNested(doc: Y.Doc, name: string, prev: Nested | undefined, next: Nested) {
  if (prev === next) return;
  const ymap = doc.getMap<unknown>(name);
  if (!prev) {
    const seen = new Set<string>();
    for (const [outer, inner] of Object.entries(next ?? {}))
      for (const [k, v] of Object.entries(inner ?? {})) {
        seen.add(outer + SEP + k);
        put(ymap, outer + SEP + k, v);
      }
    for (const key of [...ymap.keys()]) if (!seen.has(key)) ymap.delete(key);
    return;
  }
  for (const outer of new Set([...Object.keys(prev), ...Object.keys(next ?? {})])) {
    const a = prev[outer], b = next?.[outer];
    if (a === b) continue;
    for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) if (!same(a?.[k], b?.[k])) put(ymap, outer + SEP + k, b?.[k]);
  }
}

function writeSingles(doc: Y.Doc, name: string, keys: readonly string[], prev: Record<string, unknown> | undefined, next: Record<string, unknown>) {
  const ymap = doc.getMap<unknown>(name);
  for (const k of keys) if (!(prev && same(prev[k], next[k]))) put(ymap, k, next[k]);
}

/**
 * Write this device's changes into the document. `prev` is what was written last time (to skip untouched parts fast;
 * pass null the first time — then everything is written). Run inside one transaction so it goes out as one update.
 */
export function writeLocal(doc: Y.Doc, prev: Synced | null, next: Synced, origin: unknown = 'local') {
  doc.transact(() => {
    for (const c of COLLECTIONS) writeCollection(doc, c, prev?.[c], next[c] ?? []);
    for (const n of NESTED) writeNested(doc, n, prev?.[n], next[n] ?? {});
    writeSingles(doc, 'profile', PROFILE, prev ?? undefined, next as unknown as Record<string, unknown>);
    writeSingles(doc, 'settings', SETTINGS, prev?.settings, next.settings ?? {});
    const meta = doc.getMap<unknown>('meta');
    if (docSchema(doc) < SYNC_SCHEMA || !meta.has('schema')) meta.set('schema', Math.max(SYNC_SCHEMA, docSchema(doc)));
  }, origin);
}

/** Read the document back as app state. Records are reused from `prev` when unchanged, so the app redraws only what
 *  changed. Anything the document doesn't have (a fresh document) is left out, so the caller keeps its own. */
export function readDoc(doc: Y.Doc, prev: Partial<Synced> = {}): Partial<Synced> {
  const out: Partial<Synced> = {};
  for (const c of COLLECTIONS) {
    const ymap = doc.getMap<Y.Map<unknown>>(c);
    const before = new Map((prev[c] ?? []).map((r, i) => [r.id, { r, i }]));
    const rows: { rec: Rec; o: number; at: number }[] = [];
    ymap.forEach((y, id) => {
      const obj = y.toJSON() as Record<string, unknown>;
      const o = typeof obj[ORDER] === 'number' ? (obj[ORDER] as number) : Infinity;
      delete obj[ORDER];
      const rec = { ...obj, id } as Rec;
      const old = before.get(id);
      rows.push({ rec: old && same(old.r, rec) ? old.r : rec, o, at: old ? old.i : Infinity });
    });
    const cmp = (x: number | string, y: number | string) => (x === y ? 0 : x < y ? -1 : 1);
    // ordered lists by their places; others as this device had them, new arrivals after (by an old document's
    // place where there is one, then as the document lists them)
    if (ORDERED.has(c)) rows.sort((a, b) => cmp(a.o, b.o) || cmp(a.rec.id, b.rec.id));
    else rows.sort((a, b) => cmp(a.at, b.at) || cmp(a.o, b.o));
    const list = rows.map((r) => r.rec);
    const old = prev[c];
    (out as Record<string, unknown>)[c] = old && old.length === list.length && old.every((r, i) => r === list[i]) ? old : list;
  }
  for (const n of NESTED) {
    const ymap = doc.getMap<unknown>(n);
    const nested: Nested = {};
    ymap.forEach((v, key) => {
      const i = key.indexOf(SEP);
      const outer = key.slice(0, i), inner = key.slice(i + 1);
      (nested[outer] ??= {})[/^-?\d+$/.test(inner) ? Number(inner) : inner] = v;
    });
    const old = prev[n];
    for (const [k, v] of Object.entries(nested)) if (old?.[k] && same(old[k], v)) nested[k] = old[k];
    (out as Record<string, unknown>)[n] = old && same(old, nested) ? old : nested;
  }
  const profile = doc.getMap<unknown>('profile');
  for (const k of PROFILE) if (profile.has(k)) (out as Record<string, unknown>)[k] = profile.get(k);
  const settings = doc.getMap<unknown>('settings');
  if (settings.size) out.settings = Object.fromEntries(SETTINGS.filter((k) => settings.has(k)).map((k) => [k, settings.get(k)]));
  return out;
}

/** The slice of the app's state that syncs. */
export function pick(state: Record<string, unknown>): Synced {
  const s = state as Record<string, unknown> & { settings?: Record<string, unknown> };
  const out: Record<string, unknown> = {};
  for (const k of [...COLLECTIONS, ...NESTED, ...PROFILE]) out[k] = s[k];
  out.settings = Object.fromEntries(SETTINGS.map((k) => [k, s.settings?.[k]]));
  return out as Synced;
}

/** Is there anything in the document yet? (A device joining starts from what the others have.) */
export const docIsEmpty = (doc: Y.Doc) => COLLECTIONS.every((c) => doc.getMap(c).size === 0) && doc.getMap('profile').size === 0;
