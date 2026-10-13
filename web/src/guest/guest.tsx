// The guest page (book.html → GitHub Pages, when the address carries a scheduling link — see entry.ts). Light or dark follows the visitor's device.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemoteGuest } from './RemoteGuest';
import { guestRelays, loadRelayList, relayTransport, type Transport } from '../lib/relays';
import { localeUses24h, setPrefs } from '../lib/prefs';

// Times on this page follow the guest's own clock style (24-hour in most of the world).
setPrefs({ hour24: localeUses24h() });
import '../styles.css';

const mq = window.matchMedia('(prefers-color-scheme: dark)');
const theme = () => {
  document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
  document.documentElement.dataset.mode = mq.matches ? 'dark' : 'light';
};
theme();

function Root({ transport }: { transport: Transport }) {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    mq.addEventListener('change', theme);
    return () => {
      window.removeEventListener('hashchange', on);
      mq.removeEventListener('change', theme);
    };
  }, []);
  return (
    <div className="gp">
      <RemoteGuest key={hash} transport={transport} hash={hash} />
      <div className="gp-foot">Private: only people with this link can see these times. <a href="https://github.com/worldline-calendar/worldline" target="_blank" rel="noreferrer">Worldline</a></div>
    </div>
  );
}

// The relays: the current list (next to this page) plus any retired within the last year, so a link made by an app
// still on an older list works too (lib/relaylist.ts).
void loadRelayList('./relays.json').then((list) => {
  const transport = relayTransport(guestRelays(list, new Date().toISOString().slice(0, 10)));
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root transport={transport} />
    </StrictMode>,
  );
});
