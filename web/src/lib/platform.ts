// The few things that differ between the Mac app (Tauri) and a plain browser: reading a calendar link from another
// site, opening a link in your browser, opening a folder in Finder. Everything else is the same code.

/** Running inside the Mac app (rather than a browser tab). */
export const isApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The text at a URL. The app fetches it natively; a browser page can't read other sites directly, so in development
 *  it goes through the dev server (see vite.config.ts). */
export async function fetchText(url: string): Promise<string> {
  let res: Response;
  if (isApp()) {
    const { fetch } = await import('@tauri-apps/plugin-http');
    res = await fetch(url, { method: 'GET', headers: { Accept: 'text/calendar, text/plain, */*' } });
  } else {
    res = await fetch(`/__fetch?url=${encodeURIComponent(url)}`);
  }
  if (!res.ok) throw new Error(res.status === 404 ? 'not found (404) — check the link' : `the server said ${res.status}`);
  return res.text();
}

/** Open a web link in the default browser. */
export async function openExternal(url: string) {
  if (isApp()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener,noreferrer');
}

/** A local path that the app can open in Finder ("~/papers", "/Users/…"); cluster:… and the like are not. */
export const isLocalPath = (p: string) => /^(~|\/)/.test(p.trim());

/** Open a folder or file in Finder (the app), or copy its path (a browser can't). Returns what happened. */
export async function openPath(path: string): Promise<'opened' | 'copied'> {
  const p = path.trim();
  if (isApp() && isLocalPath(p)) {
    const [{ openPath: open }, { homeDir }] = await Promise.all([import('@tauri-apps/plugin-opener'), import('@tauri-apps/api/path')]);
    await open(p.startsWith('~') ? (await homeDir()).replace(/\/$/, '') + p.slice(1) : p);
    return 'opened';
  }
  await navigator.clipboard?.writeText(p).catch(() => {});
  return 'copied';
}

/** In the app, links meant for a new tab open in the browser instead (the app has no tabs). */
export function routeLinksToBrowser() {
  if (!isApp()) return;
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || !/^https?:|^mailto:/i.test(a.href)) return;
    e.preventDefault();
    void openExternal(a.href);
  }, true);
  window.open = ((url?: string | URL) => {
    if (url) void openExternal(String(url));
    return null;
  }) as typeof window.open;
}

/** Save text to a file the person chooses: the Mac's Save panel in the app (a browser download in a browser).
 *  Resolves false if they cancelled. */
export async function saveFile(name: string, text: string, mime = 'text/plain'): Promise<boolean> {
  if (isApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('save_file', { name, contents: text }); // the Save panel is shown by the native side (lib.rs)
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

/** Open at login (the Mac app; a browser can't). */
export const autostart = {
  get: async () => (isApp() ? (await import('@tauri-apps/plugin-autostart')).isEnabled() : false),
  set: async (on: boolean) => {
    if (!isApp()) return;
    const a = await import('@tauri-apps/plugin-autostart');
    await (on ? a.enable() : a.disable());
  },
};

/** The app's version (from package.json, at build time). */
export const APP_VERSION: string = __APP_VERSION__;

/** Uninstall (the Mac app): quits, then the app and all its data go to one folder in the Trash (lib.rs → uninstall). */
export async function uninstallApp() {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('uninstall');
}

/** Can this copy fetch calendar links (.ics) itself? The Mac app can (and development, through the dev server); the
 *  web / iPhone version can't — browsers can't read other sites' feeds — so its subscribed calendars come from the Mac
 *  through sync. */
export const canFetchFeeds = () => isApp() || import.meta.env.DEV;
