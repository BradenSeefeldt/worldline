// Where the app keeps your data. In the Mac app: a SQLite database — one file, worldline.db, in the app's own folder
// (~/Library/Application Support/<app id>/), written atomically, with a snapshot of each day's data kept for two
// weeks as a safety net. In a browser (the iPhone / web version, and development): the browser's IndexedDB (no 5 MB
// cap like localStorage; anything saved in localStorage by an older version is moved over once).
//
// Safeguards:
//   · Saved data that can't be read (damaged, or the database won't open) is never written over: saving stops, the
//     app opens a recovery screen (components/Recovery.tsx) offering a snapshot or a backup, and the unreadable copy
//     is kept aside.
//   · A save that fails is kept and tried again (every few seconds, and on the next change); the app is told, once.
//   · Restoring (a snapshot or a backup file) first keeps what it replaces, so the restore can be undone.
import type { StateStorage } from 'zustand/middleware';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { isApp } from '../lib/platform';

// The browser's database (IndexedDB). Tests and very old browsers without it fall back to localStorage.
const hasIdb = typeof indexedDB !== 'undefined';
const browserGet = async (key: string): Promise<string | null> => {
  if (!hasIdb) return localStorage.getItem(key);
  const v = await idbGet<string>(key);
  if (v !== undefined) return v;
  const old = localStorage.getItem(key); // saved by an older version: move it over
  if (old !== null) {
    await idbSet(key, old);
    localStorage.removeItem(key);
  }
  return old;
};
const browserSet = (key: string, value: string) => (hasIdb ? idbSet(key, value) : Promise.resolve(localStorage.setItem(key, value)));
const browserDel = (key: string) => (hasIdb ? idbDel(key) : Promise.resolve(localStorage.removeItem(key)));

type Db = { execute: (sql: string, args?: unknown[]) => Promise<unknown>; select: <T>(sql: string, args?: unknown[]) => Promise<T> };
let db: Promise<Db> | null = null;
const open = () =>
  (db ??= (async () => {
    const { default: Database } = await import('@tauri-apps/plugin-sql');
    const d = (await Database.load('sqlite:worldline.db')) as unknown as Db;
    await d.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)');
    await d.execute('CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, value TEXT NOT NULL)');
    return d;
  })().catch((e) => {
    db = null; // try opening again next time
    throw e;
  }));

const BEFORE_RESTORE = '-before-restore'; // key suffix: what the last restore replaced
const UNREADABLE = '-unreadable'; // key suffix: saved data that couldn't be read, kept aside

/** Set when the app starts with nothing saved yet (a new install): it starts empty rather than with demo data. */
export let firstRun = false;

/** Why the saved data couldn't be loaded (null: it loaded fine). While set, nothing is saved. */
export let loadProblem: string | null = null;

/** Is this what the app saves (JSON with a `state` object)? */
export function readable(value: string): boolean {
  try {
    const v = JSON.parse(value) as { state?: unknown };
    return !!v && typeof v === 'object' && !!v.state && typeof v.state === 'object';
  } catch {
    return false;
  }
}

// ---- the two places data can live: the database (the app) or localStorage (a browser)
const kv = {
  get: async (key: string): Promise<string | null> => {
    if (!isApp()) return browserGet(key);
    const d = await open();
    return (await d.select<{ value: string }[]>('SELECT value FROM kv WHERE key = $1', [key]))[0]?.value ?? null;
  },
  set: async (key: string, value: string, snapshot = false) => {
    if (!isApp()) return browserSet(key, value);
    const d = await open();
    await d.execute('INSERT INTO kv (key, value, updated) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = $2, updated = $3', [key, value, Date.now()]);
    if (!snapshot) return;
    // the day's first save also keeps a snapshot; the newest 14 days are kept
    const day = new Date().toISOString().slice(0, 10);
    await d.execute('INSERT OR IGNORE INTO snapshots (day, value) VALUES ($1, $2)', [day, value]);
    await d.execute('DELETE FROM snapshots WHERE day NOT IN (SELECT day FROM snapshots ORDER BY day DESC LIMIT 14)');
  },
  del: async (key: string) => {
    if (!isApp()) return browserDel(key);
    const d = await open();
    await d.execute('DELETE FROM kv WHERE key = $1', [key]);
  },
};

// ---- saving: batched (typing fires many changes), retried if it fails, one write at a time (in order) so a slow or
// failed older write can never land after a newer one
let pending: { key: string; value: string } | null = null;
let timer = 0;
let failing = false;
let chain: Promise<void> = Promise.resolve();
let busy = 0;
const troubleListeners = new Set<(ok: boolean) => void>();
/** Hear when saving starts failing (false) and when it works again (true). */
export const onSaveTrouble = (fn: (ok: boolean) => void) => (troubleListeners.add(fn), () => void troubleListeners.delete(fn));

async function writeOnce() {
  const p = pending;
  pending = null;
  if (!p || loadProblem || readOnly) return;
  try {
    await kv.set(p.key, p.value, true);
    if (failing) {
      failing = false;
      troubleListeners.forEach((fn) => fn(true));
    }
  } catch (e) {
    console.error('Saving failed; will try again', e);
    pending ??= p; // keep it (unless something newer is already waiting — that replaces it)
    if (!failing) {
      failing = true;
      troubleListeners.forEach((fn) => fn(false));
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(), 5000);
  }
}
function write(): Promise<void> {
  clearTimeout(timer);
  busy++;
  chain = chain.then(writeOnce).finally(() => void busy--);
  return chain;
}
/** Write anything not yet saved (called when the window hides or closes, before quitting and before a restart). */
export const flush = () => {
  flushHooks.forEach((fn) => fn()); // (the store's own debounce hands over what it's holding first)
  return write();
};
const flushHooks = new Set<() => void>();
/** Run before every flush — data/store.ts hands over a save it's still holding. */
export const onFlush = (fn: () => void) => void flushHooks.add(fn);
/** Is everything the app holds saved (nothing waiting, nothing being written, the last write worked)? */
export const allSaved = () => !pending && !busy && !failing && !loadProblem && !readOnly;

const storage: StateStorage = {
  getItem: async (key) => {
    let value: string | null;
    try {
      value = await kv.get(key);
    } catch (e) {
      loadProblem = `The database couldn’t be opened (${String((e as Error)?.message ?? e).slice(0, 160)}).`;
      return null;
    }
    if (value === null) {
      firstRun = true;
      return null;
    }
    if (!readable(value)) {
      loadProblem = 'Your saved data couldn’t be read — it may have been damaged.';
      await kv.set(key + UNREADABLE, value).catch(() => undefined); // keep it aside, untouched
      return null;
    }
    return value;
  },
  setItem: (key, value) => {
    if (loadProblem || readOnly) return; // never write over data we couldn't read (or another tab's)
    pending = { key, value };
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(), isApp() ? 300 : 0);
  },
  removeItem: (key) => kv.del(key),
};

/** Other things kept beside the app's state, never in it (so never in a backup): the sync key, the sync document. */
export const sideStore = { get: kv.get, set: async (key: string, value: string) => void (readOnly || (await kv.set(key, value))), del: kv.del };

/** The storage the app's state is saved to. */
export const appStorage = (): StateStorage => storage;

/** Another tab or window of this web app holds the data (see main.tsx): this one never saves, so neither writes
 *  over the other's changes. */
let readOnly = false;
export const makeReadOnly = () => {
  readOnly = true;
  pending = null;
  clearTimeout(timer);
};

/** The hydration itself failed (e.g. a migration threw): treat it like unreadable data. */
const problemListeners = new Set<() => void>();
export function markLoadProblem(reason: string) {
  loadProblem ??= reason;
  problemListeners.forEach((fn) => fn());
}
/** Hear when loading fails outright (the app then shows the recovery screen instead of waiting forever). */
export const onLoadProblem = (fn: () => void) => void problemListeners.add(fn);

// ---- snapshots and restoring

/** The daily snapshots kept in the database (newest first). The Mac app only. */
export async function listSnapshots(): Promise<string[]> {
  if (!isApp()) return [];
  const d = await open();
  return (await d.select<{ day: string }[]>('SELECT day FROM snapshots ORDER BY day DESC')).map((r) => r.day);
}

/** A snapshot's saved state, as stored. */
export async function snapshotValue(day: string): Promise<string | null> {
  const d = await open();
  return (await d.select<{ value: string }[]>('SELECT value FROM snapshots WHERE day = $1', [day]))[0]?.value ?? null;
}

/** Replace everything with what was saved (a snapshot, a backup's state, or an undo), keeping what it replaces so the
 *  restore can be undone. The caller reloads the app afterwards. */
export async function replaceSaved(key: string, value: string) {
  if (!readable(value)) throw new Error('That isn’t data Worldline can load.');
  pending = null;
  clearTimeout(timer);
  const current = await kv.get(key).catch(() => null);
  if (current && readable(current)) await kv.set(key + BEFORE_RESTORE, current);
  await kv.set(key, value);
  loadProblem = null;
}

/** What the last restore replaced (to undo it), if anything. */
export const beforeRestore = (key: string) => kv.get(key + BEFORE_RESTORE).then((v) => (v && readable(v) ? v : null)).catch(() => null);

/** Start over from the recovery screen: an empty calendar; the unreadable data stays kept aside. */
export async function startOverKeepingUnreadable(key: string) {
  // (data that read fine but couldn't be loaded — from a newer version, or a failed migration — is kept aside too)
  const cur = await kv.get(key).catch(() => null);
  if (cur !== null) await kv.set(`${key}${UNREADABLE}-${new Date().toISOString()}`, cur); // never over an earlier copy kept aside
  await kv.del(key).catch(() => undefined);
  loadProblem = null;
}

if (isApp()) {
  // don't lose the last few keystrokes when the window goes away
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush());
  window.addEventListener('blur', () => void flush());
}
