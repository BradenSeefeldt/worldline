import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './data/store';
import { firstRun, flush, loadProblem, makeReadOnly, onLoadProblem } from './data/persist';
import { OpenElsewhere, Recovery } from './components/Recovery';
import { CrashScreen } from './components/CrashScreen';
import { isApp, routeLinksToBrowser } from './lib/platform';
import { runScheduling } from './data/schedSync';

const devNetwork = () => {
  try {
    return localStorage.getItem('wl-dev-network') === '1';
  } catch {
    return false;
  }
};
import './styles.css';
import { flushSync, resumeSync } from './data/syncEngine';
import { runAlerts } from './data/alerts';
import { runMacCalendars } from './data/macCalendars';

// In the Mac app the saved data comes from a database (asynchronously): show the app once it's loaded, so it never
// flashes the starting data first. A new install (nothing saved yet) starts empty, not with the demo.
// If the saved data can't be loaded, the recovery screen opens instead (nothing is written over it).
const loaded = new Promise<void>((r) => {
  if (useStore.persist.hasHydrated()) r();
  useStore.persist.onFinishHydration(() => r());
  onLoadProblem(r);
});
// The web version in a browser: one tab at a time owns the data. A second tab (or window) would hold its own copy and
// save over the first one's changes, and run sync twice — so it only says where Worldline is already open.
// "Use it here instead" (components/Recovery.tsx) takes the lock over: the old tab saves, then reloads as the second one.
const LOCK = 'worldline-app';
function ownTab(): Promise<boolean> {
  if (isApp() || !navigator.locks) return Promise.resolve(true);
  try {
    if (sessionStorage.getItem('wl-yielded')) {
      sessionStorage.removeItem('wl-yielded');
      return Promise.resolve(false);
    }
  } catch {
    /* no sessionStorage: fine */
  }
  return new Promise((r) => {
    navigator.locks
      .request(LOCK, { ifAvailable: true }, (lock) => (r(!!lock), lock ? new Promise(() => {}) : undefined))
      .catch(async () => {
        // another tab took over: save what's pending, stop saving, and step aside
        await flush();
        makeReadOnly();
        try {
          sessionStorage.setItem('wl-yielded', '1');
        } catch {
          /* fine */
        }
        new BroadcastChannel(LOCK).postMessage('saved'); // the taking tab loads only after this
        location.reload();
      });
  });
}

void Promise.all([loaded, ownTab()]).then(([, mine]) => {
  if (isApp()) document.documentElement.classList.add('in-app');
  if (!mine) {
    makeReadOnly();
    createRoot(document.getElementById('root')!).render(<OpenElsewhere />);
    return;
  }
  // The iPhone / web version: ask the browser to keep this site's data even when the device runs low on space.
  if (!isApp()) void navigator.storage?.persist?.().catch(() => undefined);
  if (loadProblem) {
    createRoot(document.getElementById('root')!).render(<Recovery reason={loadProblem} />);
    return;
  }
  // A new install starts empty (the Mac app, and the web / iPhone version); development keeps the demo data.
  if (firstRun && (isApp() || !import.meta.env.DEV)) useStore.getState().startFresh();
  // The web / iPhone version: keep every file on the device so it opens without internet (sw.js, vite.web.config.ts).
  if (!isApp() && !import.meta.env.DEV && 'serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  if (isApp()) {
    routeLinksToBrowser();
    // Closing the window: hide it and keep running (Settings → General, on by default) so scheduling links stay
    // live — or really quit. Either way, anything not yet saved is written first.
    // Quitting (⌘Q): save everything first, then quit (src-tauri/src/lib.rs asks, and quits anyway after 3 s).
    void Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]).then(([{ listen }, { invoke }]) =>
      listen('quit-requested', async () => {
        await Promise.race([Promise.all([flush(), flushSync()]), new Promise((r) => setTimeout(r, 2500))]);
        await invoke('quit_now');
      }),
    );
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win.onCloseRequested(async (e) => {
        await Promise.race([Promise.all([flush(), flushSync()]), new Promise((r) => setTimeout(r, 2500))]);
        if (useStore.getState().settings.keepRunning) {
          e.preventDefault();
          await win.hide();
        }
      });
    });
  }
  // Where to start (Settings → General / Calendar): the page you were on last unless you chose one; the default view.
  const st = useStore.getState();
  if (st.settings.startPage !== 'last') st.setPage(st.settings.startPage);
  if (st.settings.startPage === 'calendar') st.goToday();
  // (a window opened hidden reports no width: judge by the screen then, or a Mac would start in 3 Day)
  st.setView((window.innerWidth || screen.width) < 700 && st.settings.startView === 'week' ? '3day' : st.settings.startView);
  // A file dropped anywhere but a drop area (Import a file) does nothing — left alone, the page would be replaced by
  // the file. Drop areas handle their own events first.
  const strayFile = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (!(e.target as Element | null)?.closest?.('.ce-drop')) e.dataTransfer.dropEffect = 'none'; // no "+" cursor here
  };
  window.addEventListener('dragover', strayFile);
  window.addEventListener('drop', strayFile);
  // Scheduling links are answered by the Mac app (one device answering keeps bookings and availability consistent);
  // the iPhone / web version shows and copies them. Development runs it too, for testing.
  // (development publishes to the public relays only when asked: localStorage 'wl-dev-network' = '1')
  if (import.meta.env.DEV ? devNetwork() : isApp()) void runScheduling(); // data/schedSync.ts
  void resumeSync(); // syncing between your devices, if this one is set up (data/syncEngine.ts)
  runAlerts(); // reminders (data/alerts.ts)
  runMacCalendars(); // the Mac app: calendars on this Mac, kept in step both ways (data/macCalendars.ts)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <CrashScreen>
        <App />
      </CrashScreen>
    </StrictMode>,
  );
});
