// The guest page alone (book.html → dist-guest/index.html), for GitHub Pages: `npm run build:guest`.
// Paths are relative (base './') so it works from https://<user>.github.io/worldline/.
import { renameSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The built page may load only its own files and talk only to relays (wss:). Added at build time: the dev server
// needs inline scripts for live reload.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src wss:; base-uri 'none'; form-action 'none'";
const guestPage: Plugin = {
  name: 'guest-page',
  transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  closeBundle: () => renameSync('dist-guest/book.html', 'dist-guest/index.html'), // GitHub Pages serves index.html
};

export default defineConfig({
  plugins: [react(), guestPage],
  base: './',
  build: { outDir: 'dist-guest', emptyOutDir: true, rollupOptions: { input: 'book.html' } },
});
