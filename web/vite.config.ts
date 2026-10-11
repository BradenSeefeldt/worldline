/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

// Development only: /__fetch?url=… fetches a calendar link for the page (a browser page can't read other sites;
// the Mac app fetches them itself).
const devFetch = {
  name: 'dev-fetch',
  configureServer(server: { middlewares: { use: (path: string, fn: (req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }) => void) => void } }) {
    server.middlewares.use('/__fetch', async (req, res) => {
      const url = new URL(req.url ?? '', 'http://x').searchParams.get('url') ?? '';
      if (!/^https?:\/\//i.test(url)) return void ((res.statusCode = 400), res.end('bad url'));
      try {
        const r = await fetch(url, { headers: { Accept: 'text/calendar, text/plain, */*' } });
        res.statusCode = r.status;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(await r.text());
      } catch (e) {
        res.statusCode = 502;
        res.end(String(e));
      }
    });
  },
};

export default defineConfig({
  plugins: [react(), devFetch],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173 },
  // Tests read the stylesheet's text (theme.test.ts checks every theme defines every colour).
  test: { css: { include: [/styles\.css/] } },
});
