// The guest page alone (book.html → dist-guest/index.html), for GitHub Pages: `npm run build:guest`.
// Paths are relative (base './') so it works from https://<user>.github.io/worldline/.
import { copyFileSync, renameSync } from 'node:fs';
import { landing } from './vite.landing.ts';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// The built page (the landing page, or the guest page for a link) may load only its own files and talk only to itself (relays.json) and relays (wss:). Added at build time: the dev server
// needs inline scripts for live reload.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' wss:; base-uri 'none'; form-action 'none'";
const guestPage: Plugin = {
  name: 'guest-page',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  closeBundle: () => {
    renameSync('dist-guest/book.html', 'dist-guest/index.html'); // GitHub Pages serves index.html
    copyFileSync('../docs/screenshot.jpg', 'dist-guest/shot.jpg'); // the landing page's screenshot (the README's; kept out of public/: the apps don't need it)
    copyFileSync('scripts/install.sh', 'dist-guest/install.sh'); // curl -fsSL https://…/worldline/install.sh | sh
  },
};

export default defineConfig({
  plugins: [react(), landing(), guestPage],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  build: { outDir: 'dist-guest', emptyOutDir: true, rollupOptions: { input: 'book.html' } },
});
