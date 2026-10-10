import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { GuestPage } from './pages/GuestPage';
import { useStore } from './data/store';
import { firstRun } from './data/persist';
import { isApp, routeLinksToBrowser } from './lib/platform';
import './styles.css';

/** "#/book/<id>" is a scheduling link's guest page; everything else is your calendar. */
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const m = hash.match(/^#\/book\/([\w-]+)/);
  return m ? <GuestPage id={m[1]} /> : <App />;
}

// In the Mac app the saved data comes from a database (asynchronously): show the app once it's loaded, so it never
// flashes the starting data first. A new install (nothing saved yet) starts empty, not with the demo.
const loaded = useStore.persist.hasHydrated() ? Promise.resolve() : new Promise<void>((r) => useStore.persist.onFinishHydration(() => r()));
void loaded.then(() => {
  if (isApp()) {
    document.documentElement.classList.add('in-app');
    if (firstRun) useStore.getState().startFresh();
    routeLinksToBrowser();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
});
