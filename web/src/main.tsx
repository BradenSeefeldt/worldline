import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './data/store';
import { firstRun } from './data/persist';
import { isApp, routeLinksToBrowser } from './lib/platform';
import { startScheduleSync } from './data/schedSync';
import './styles.css';

// In the Mac app the saved data comes from a database (asynchronously): show the app once it's loaded, so it never
// flashes the starting data first. A new install (nothing saved yet) starts empty, not with the demo.
const loaded = useStore.persist.hasHydrated() ? Promise.resolve() : new Promise<void>((r) => useStore.persist.onFinishHydration(() => r()));
void loaded.then(() => {
  if (isApp()) {
    document.documentElement.classList.add('in-app');
    if (firstRun) useStore.getState().startFresh();
    routeLinksToBrowser();
  }
  startScheduleSync(); // scheduling links: publish free/busy, collect bookings and answers (data/schedSync.ts)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
