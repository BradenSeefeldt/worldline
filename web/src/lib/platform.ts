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
