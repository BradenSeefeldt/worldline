// Automatic updates. Soon after launch and then once a day (Settings → About → "Check for updates automatically"):
//   · the Mac app: ask GitHub for the newest *published* release; if it's newer, download it in the background. The
//     download is signed — the app refuses anything not signed with the project's key (tauri.conf.json →
//     plugins.updater.pubkey). Then a small "Update ready · Restart" button appears; nothing restarts on its own.
//   · the iPhone / web version: read version.json next to the app (written by vite.web.config.ts); if the site has a
//     newer version, "Update now" reloads into it (the page is always fetched fresh when online — sw.js).
import type { Update } from '@tauri-apps/plugin-updater';
import { APP_VERSION, isApp } from './platform';
import { isNewer } from './backup';
import { flush } from '../data/persist';

/** Can this copy update itself? The Mac app, and the web version as built for the site (not development). */
export const canUpdate = () => isApp() || (!import.meta.env.DEV && typeof navigator !== 'undefined' && 'serviceWorker' in navigator);

/** The web version: the version the site has now, if it's newer than this one. */
async function siteVersion(): Promise<string | null> {
  const res = await fetch('./version.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`the site said ${res.status}`);
  const v = String(((await res.json()) as { version?: unknown }).version ?? '');
  return v && isNewer(v, APP_VERSION) ? v : null;
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'current' }
  | { state: 'downloading' | 'ready'; version: string }
  | { state: 'failed'; error: string };

let ready: Update | null = null;

/** Look for a newer version; download it if there is one. */
export async function checkForUpdate(report: (s: UpdateStatus) => void) {
  if (!canUpdate()) return;
  if (!isApp()) {
    report({ state: 'checking' });
    try {
      const v = await siteVersion();
      return report(v ? { state: 'ready', version: v } : { state: 'current' });
    } catch (e) {
      return report({ state: 'failed', error: navigator.onLine === false ? 'no internet connection' : String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
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
  if (!isApp()) {
    // the web version: everything saved, the service worker refreshed, then the page reloads into the new version
    await flush();
    await (await navigator.serviceWorker?.getRegistration())?.update().catch(() => undefined);
    return location.reload();
  }
  if (!ready) return;
  await flush();
  await ready.install();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
