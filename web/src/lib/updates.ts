// Automatic updates (the Mac app). Soon after launch and then once a day: ask GitHub for the newest *published*
// release; if it's newer, download it in the background. The download is signed — the app refuses anything not signed
// with the project's key (tauri.conf.json → plugins.updater.pubkey). Then a small "Update ready · Restart" button
// appears; nothing restarts on its own. Settings → About → "Check for updates automatically".
import type { Update } from '@tauri-apps/plugin-updater';
import { isApp } from './platform';
import { flush } from '../data/persist';

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'downloading' | 'ready'; version: string }
  | { state: 'failed'; error: string };

let ready: Update | null = null;

/** Look for a newer version; download it if there is one. */
export async function checkForUpdate(report: (s: UpdateStatus) => void) {
  if (!isApp()) return;
  if (ready) return report({ state: 'ready', version: ready.version });
  report({ state: 'checking' });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return report({ state: 'current' });
    report({ state: 'downloading', version: update.version });
    await update.download();
    ready = update;
    report({ state: 'ready', version: update.version });
  } catch (e) {
    report({ state: 'failed', error: String((e as Error)?.message ?? e).slice(0, 200) });
  }
}

/** Install the downloaded version and restart into it (everything is saved first). */
export async function restartToUpdate() {
  if (!ready) return;
  await flush();
  await ready.install();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
