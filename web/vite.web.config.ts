// The full app as a web app for the iPhone (Add to Home Screen) — dist-web/, served from
// https://<user>.github.io/worldline/app/ by .github/workflows/pages.yml. `npm run build:web`.
// It works offline: a service worker (sw.js, written after the build with the list of files) keeps every file of
// the app on the phone; when online it checks for a newer version, used from the next launch.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

const OUT = 'dist-web';

const webApp: Plugin = {
  name: 'web-app',
  // The page may load only its own files and talk only to itself and the relays. The one inline script (the theme
  // painted before the first frame) is allowed by its hash.
  transformIndexHtml(html) {
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    const csp = `default-src 'self'; script-src 'self' ${inline.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss:; media-src 'self' blob:; worker-src 'self'; base-uri 'none'; form-action 'none'`;
    return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  },
  closeBundle() {
    // what the app compares itself with to offer "Update now" (lib/updates.ts); never kept by the service worker
    writeFileSync(join(OUT, 'version.json'), JSON.stringify({ version: pkg.version }) + '\n');
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(relative(OUT, join(d, f)))));
    walk(OUT);
    // Kept on the phone up front: everything the app needs offline — but not KaTeX's fonts (fetched, and then kept, the
    // first time an equation is shown; offline before that, equations show in the system's fonts), the city list behind
    // the time-zone search (loaded only when that opens; kept once fetched).
    const later = (f: string) => /\.(woff2?|ttf)$/.test(f) || /city-timezones/.test(f) || f === 'version.json';
    const list = files.filter((f) => f !== 'sw.js' && !later(f)).map((f) => `./${f}`);
    // the version changes whenever any kept file's *contents* change (relays.json's new list included), not only names
    const hash = createHash('sha256').update(pkg.version);
    for (const f of list) hash.update(f).update(readFileSync(join(OUT, f)));
    const version = hash.digest('hex').slice(0, 12);
    writeFileSync(join(OUT, 'sw.js'), `// Keeps Worldline working offline (written by vite.web.config.ts).
const CACHE = 'worldline-${version}';
const FILES = ${JSON.stringify(['./', ...list])};
const FRESH = ['relays.json']; // asked for fresh each time (kept for offline): the relay list changes between releases
// (each copy notes when it was installed on this phone, to tell the newest older one)
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES).then(() => c.put('./__installed', new Response(String(Date.now()))))).then(() => self.skipWaiting())));
// The previous version's files stay one round, so a page still open from before can load its lazily loaded parts.
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then(async (ks) => {
  const others = ks.filter((k) => k.startsWith('worldline-') && k !== CACHE);
  const when = await Promise.all(others.map((k) => caches.open(k).then((c) => c.match('./__installed')).then((r) => (r ? r.text() : '0')).then(Number)));
  const previous = others[when.indexOf(Math.max(...when, -1))];
  return Promise.all(ks.filter((k) => k !== CACHE && k !== previous).map((k) => caches.delete(k)));
}).then(() => self.clients.claim())));
// The network, but not forever: a weak connection ("lie-fi") mustn't stop the app opening, and a server error counts as offline.
const network = (req, ms) => new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error('slow')), ms);
  fetch(req).then((res) => (clearTimeout(t), res.ok || res.type === 'opaqueredirect' ? ok(res) : fail(new Error(String(res.status)))), (err) => (clearTimeout(t), fail(err)));
});
const kept = (req) => caches.match(req, { ignoreVary: true });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // the page: the newest when online (within 3 s), the kept copy when not
    e.respondWith(network(req, 3000).catch(() => kept('./index.html').then((r) => r || kept('./')).then((r) => r || fetch(req))));
    return;
  }
  if (FRESH.some((f) => url.pathname.endsWith('/' + f))) {
    e.respondWith(network(req, 4000).then((res) => { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => kept(req).then((r) => r || fetch(req))));
    return;
  }
  // by address alone: servers' Vary headers mustn't hide the kept copy; anything fetched later (a lazily loaded part) is kept too
  e.respondWith(kept(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && url.pathname.includes('/assets/')) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
`);
  },
};

export default defineConfig({
  plugins: [react(), webApp],
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: OUT, emptyOutDir: true },
});
