// A backup file: everything you've made, in one .json you can keep anywhere and restore from
// (Settings → Data & Backups). The same saved state the app keeps in its database, with a small header.
export const BACKUP_FORMAT = 'worldline-backup';

export interface Backup {
  format: typeof BACKUP_FORMAT;
  savedAt: string; // ISO time
  appVersion: string;
  storeVersion: number; // the saved state's format (data/store.ts → persist version)
  state: Record<string, unknown>;
}

export const makeBackup = (state: Record<string, unknown>, storeVersion: number, appVersion: string, now = Date.now()): Backup => ({
  format: BACKUP_FORMAT, savedAt: new Date(now).toISOString(), appVersion, storeVersion, state,
});

/** Read a backup file. Anything that isn't one (or is from a newer app the store can't read) → an explanation. */
export function readBackup(text: string, storeVersion: number): { ok: true; backup: Backup } | { ok: false; reason: string } {
  let b: Partial<Backup>;
  try {
    b = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'That file isn’t a Worldline backup (it isn’t JSON).' };
  }
  if (!b || b.format !== BACKUP_FORMAT || !b.state || typeof b.state !== 'object') return { ok: false, reason: 'That file isn’t a Worldline backup.' };
  if (!Array.isArray(b.state.events) || !Array.isArray(b.state.calendars)) return { ok: false, reason: 'That backup looks damaged (no calendars or events in it).' };
  if (typeof b.storeVersion !== 'number' || b.storeVersion > storeVersion) return { ok: false, reason: 'That backup was made by a newer Worldline — update the app first.' };
  return { ok: true, backup: b as Backup };
}

/** "0.2.10" is newer than "0.2.9". */
export function isNewer(latest: string, current: string) {
  const a = latest.replace(/^v/, '').split('.').map(Number), b = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
