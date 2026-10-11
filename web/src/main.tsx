import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './data/store';
import { firstRun, flush } from './data/persist';
import { isApp, routeLinksToBrowser } from './lib/platform';
import { runScheduling } from './data/schedSync';
import './styles.css';

// In the Mac app the saved data comes from a database (asynchronously): show the app once it's loaded, so it never
// flashes the starting data first. A new install (nothing saved yet) starts empty, not with the demo.
const loaded = useStore.persist.hasHydrated() ? Promise.resolve() : new Promise<void>((r) => useStore.persist.onFinishHydration(() => r()));
void loaded.then(() => {
  if (isApp()) {
    document.documentElement.classList.add('in-app');
    if (firstRun) useStore.getState().startFresh();
    routeLinksToBrowser();
    // Closing the window: hide it and keep running (Settings → General, on by default) so scheduling links stay
    // live — or really quit. Either way, anything not yet saved is written first.
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      void win.onCloseRequested(async (e) => {
        await flush();
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
  st.setView(window.innerWidth < 700 && st.settings.startView === 'week' ? '3day' : st.settings.startView);
  // A file dropped anywhere but a drop area (Import a file) does nothing — left alone, the page would be replaced by
  // the file. Drop areas handle their own events first.
  const strayFile = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (!(e.target as Element | null)?.closest?.('.ce-drop')) e.dataTransfer.dropEffect = 'none'; // no "+" cursor here
  };
  window.addEventListener('dragover', strayFile);
  window.addEventListener('drop', strayFile);
  void runScheduling(); // scheduling links: publish free/busy, collect bookings and answers (data/schedSync.ts)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
