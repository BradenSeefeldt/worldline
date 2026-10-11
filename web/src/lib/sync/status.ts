/** Syncing between your devices, as the app shows it (Settings → Sync). */
export interface SyncStatus {
  on: boolean;
  state: 'off' | 'connecting' | 'synced' | 'sending' | 'offline';
  devices: Record<string, number>; // other devices seen (their key → last heard from, ms)
  lastIn: number; // last change received
  lastOut: number; // last change sent (reached at least one relay)
}
