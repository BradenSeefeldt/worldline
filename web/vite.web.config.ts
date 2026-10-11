// The full app as a web app for the iPhone (Add to Home Screen) — dist-web/, served from
// https://<user>.github.io/worldline/app/ by .github/workflows/pages.yml. `npm run build:web`.
// It works offline: a service worker (sw.js, written after the build with the list of files) keeps every file of
// the app on the phone; when online it checks for a newer version, used from the next launch.
import { createHash } from 'node:crypto';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
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
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(relative(OUT, join(d, f)))));
    walk(OUT);
    // Kept on the phone up front: everything the app needs offline — but not KaTeX's .woff / .ttf fonts (Safari uses the
    // .woff2 copies) or the city list behind the time-zone search (loaded only when that opens; kept once fetched).
    // That halves what installing it downloads (~1.9 → ~1 MB compressed).
    const later = (f: string) => /\.(woff|ttf)$/.test(f) || /city-timezones/.test(f);
    const list = files.filter((f) => f !== 'sw.js' && !later(f)).map((f) => `./${f}`);
    const version = createHash('sha256').update(list.join('\n') + pkg.version).digest('hex').slice(0, 12);
    writeFileSync(join(OUT, 'sw.js'), `// Keeps Worldline working offline (written by vite.web.config.ts).
const CACHE = 'worldline-${version}';
const FILES = ${JSON.stringify(['./', ...list])};
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // the page: the newest when online, the kept copy when not
    e.respondWith(fetch(req).catch(() => caches.match('./index.html', { ignoreVary: true }).then((r) => r || caches.match('./', { ignoreVary: true }))));
    return;
  }
  // by address alone: servers' Vary headers mustn't hide the kept copy; anything fetched later (a lazily loaded part) is kept too
  e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && new URL(req.url).pathname.includes('/assets/')) { const copy = res.clone(); void caches.open(CACHE).then((c) => c.put(req, copy)); }
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
