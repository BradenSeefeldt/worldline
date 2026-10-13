// The landing page's build-time parts (book.html): the app's version and the QR code for the iPhone app, inlined.
import QRCode from 'qrcode';
import type { Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

const APP_URL = 'https://worldline-calendar.github.io/worldline/app/';

export const landing = (): Plugin => ({
  name: 'landing',
  async transformIndexHtml(html) {
    if (!html.includes('%QR%')) return html;
    const qr = await QRCode.toString(APP_URL, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    return html.replace('%QR%', qr.replace('<svg ', '<svg aria-hidden="true" ')).replaceAll('%APP_VERSION%', pkg.version);
  },
});
