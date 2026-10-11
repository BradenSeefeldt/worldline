// Where the app keeps your data. In the Mac app: a SQLite database — one file, worldline.db, in the app's own folder
// (~/Library/Application Support/<app id>/), written atomically, with a snapshot of each day's data kept for two
// weeks as a safety net. In a browser (development): the browser's localStorage, as before.
import type { StateStorage } from 'zustand/middleware';
import { isApp } from '../lib/platform';

type Db = { execute: (sql: string, args?: unknown[]) => Promise<unknown>; select: <T>(sql: string, args?: unknown[]) => Promise<T> };
let db: Promise<Db> | null = null;
const open = () =>
  (db ??= (async () => {
    const { default: Database } = await import('@tauri-apps/plugin-sql');
    const d = (await Database.load('sqlite:worldline.db')) as unknown as Db;
    await d.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL)');
    await d.execute('CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, value TEXT NOT NULL)');
    return d;
  })());

/** Set when the app starts with nothing saved yet (a new install): it starts empty rather than with demo data. */
export let firstRun = false;

let pending: { key: string; value: string } | null = null;
let timer = 0;
async function write() {
  clearTimeout(timer);
  const p = pending;
  pending = null;
  if (!p) return;
  const d = await open();
  await d.execute('INSERT INTO kv (key, value, updated) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = $2, updated = $3', [p.key, p.value, Date.now()]);
  // the day's first save also keeps a snapshot; the newest 14 days are kept
  const day = new Date().toISOString().slice(0, 10);
  await d.execute('INSERT OR IGNORE INTO snapshots (day, value) VALUES ($1, $2)', [day, p.value]);
  await d.execute('DELETE FROM snapshots WHERE day NOT IN (SELECT day FROM snapshots ORDER BY day DESC LIMIT 14)');
}
/** Write anything not yet saved (called when the window hides or closes). */
export const flush = () => write();

/** The daily snapshots kept in the database (newest first). The Mac app only. */
export async function listSnapshots(): Promise<string[]> {
  if (!isApp()) return [];
  const d = await open();
  return (await d.select<{ day: string }[]>('SELECT day FROM snapshots ORDER BY day DESC')).map((r) => r.day);
}

/** Replace everything with what was saved: a snapshot's day, or a backup's saved state (a JSON string as stored).
 *  The caller reloads the app afterwards. */
export async function replaceSaved(key: string, value: string) {
  pending = null;
  clearTimeout(timer);
  if (!isApp()) return localStorage.setItem(key, value);
  const d = await open();
  await d.execute('INSERT INTO kv (key, value, updated) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = $2, updated = $3', [key, value, Date.now()]);
}

/** A snapshot's saved state, as stored. */
export async function snapshotValue(day: string): Promise<string | null> {
  const d = await open();
  return (await d.select<{ value: string }[]>('SELECT value FROM snapshots WHERE day = $1', [day]))[0]?.value ?? null;
}

const sqlite: StateStorage = {
  getItem: async (key) => {
    const d = await open();
    const rows = await d.select<{ value: string }[]>('SELECT value FROM kv WHERE key = $1', [key]);
    if (!rows.length) firstRun = true;
    return rows[0]?.value ?? null;
  },
  // Saves are batched: typing fires many changes, and the database is written a moment after they stop.
  setItem: (key, value) => {
    pending = { key, value };
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(), 300);
  },
  removeItem: async (key) => {
    const d = await open();
    await d.execute('DELETE FROM kv WHERE key = $1', [key]);
  },
};

/** The storage the app's state is saved to. */
export const appStorage = (): StateStorage => (isApp() ? sqlite : localStorage);

if (isApp()) {
  // don't lose the last few keystrokes when the window goes away
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush());
  window.addEventListener('blur', () => void flush());
}
