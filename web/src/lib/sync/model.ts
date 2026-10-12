// Sync, part 1: the app's data as a CRDT document (Yjs) — pure functions, no network.
//
// Each collection (events, tasks, …) is a map from id to a record, and each record is a map from field to value, so
// two devices editing different items, or different fields of one item, merge cleanly; the same field edited on both
// keeps the later edit. Deleting removes the id. A record's place in its list (the board's column order) is a field
// too (`_o`). Habit history (habit → day → amount) is one flat map keyed "habit␁day".
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

/** Yjs stores JSON: no undefined (a missing field is "not set"). */
const clean = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function writeCollection(doc: Y.Doc, name: string, prev: Rec[] | undefined, next: Rec[]) {
  if (prev === next) return;
  const ymap = doc.getMap<Y.Map<unknown>>(name);
  const prevById = new Map((prev ?? []).map((r, i) => [r.id, { r, i }]));
  const keep = new Set<string>();
  next.forEach((rec, i) => {
    keep.add(rec.id);
    const before = prevById.get(rec.id);
    if (before && before.r === rec && before.i === i && ymap.has(rec.id)) return; // untouched (same object, same place)
    let y = ymap.get(rec.id);
    if (!y) {
      y = new Y.Map();
      ymap.set(rec.id, y);
    }
    const fields = new Set([...Object.keys(rec), ...y.keys()]);
    for (const f of fields) {
      if (f === ORDER) continue;
      const v = clean(rec[f]);
      if (v === undefined) {
        if (y.has(f)) y.delete(f);
      } else if (!same(y.get(f), v)) y.set(f, v);
    }
    if (y.get(ORDER) !== i) y.set(ORDER, i);
  });
  for (const id of [...ymap.keys()]) if (!keep.has(id) && (prevById.has(id) || !prev)) ymap.delete(id);
}

function writeNested(doc: Y.Doc, name: string, prev: Nested | undefined, next: Nested) {
  if (prev === next) return;
  const ymap = doc.getMap<unknown>(name);
  const seen = new Set<string>();
  for (const [outer, inner] of Object.entries(next ?? {})) {
    if (prev && prev[outer] === inner) {
      for (const k of Object.keys(inner ?? {})) seen.add(outer + SEP + k);
      continue;
    }
    for (const [k, v] of Object.entries(inner ?? {})) {
      const key = outer + SEP + k;
      seen.add(key);
      if (!same(ymap.get(key), v)) ymap.set(key, clean(v));
    }
  }
  for (const key of [...ymap.keys()]) {
    const outer = key.slice(0, key.indexOf(SEP));
    if (!seen.has(key) && (!prev || prev[outer] !== next?.[outer])) ymap.delete(key);
  }
}

function writeSingles(doc: Y.Doc, name: string, keys: readonly string[], prev: Record<string, unknown> | undefined, next: Record<string, unknown>) {
  const ymap = doc.getMap<unknown>(name);
  for (const k of keys) {
    if (prev && prev[k] === next[k] && ymap.has(k)) continue;
    const v = clean(next[k]);
    if (v === undefined) ymap.delete(k);
    else if (!same(ymap.get(k), v)) ymap.set(k, v);
  }
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
    const before = new Map((prev[c] ?? []).map((r) => [r.id, r]));
    const rows: { rec: Rec; o: number }[] = [];
    ymap.forEach((y, id) => {
      const obj = y.toJSON() as Record<string, unknown>;
      const o = typeof obj[ORDER] === 'number' ? (obj[ORDER] as number) : 0;
      delete obj[ORDER];
      const rec = { ...obj, id } as Rec;
      const old = before.get(id);
      rows.push({ rec: old && same(old, rec) ? old : rec, o });
    });
    rows.sort((a, b) => a.o - b.o || (a.rec.id < b.rec.id ? -1 : 1));
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
