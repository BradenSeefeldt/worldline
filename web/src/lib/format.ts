// Every time the app prints goes through these, so Settings → General → Time format (12 / 24-hour) applies everywhere.
import { prefs } from './prefs';

const ampm = (h: number) => (h < 12 ? 'AM' : 'PM');
const h12 = (h: number) => h % 12 || 12;
const pad = (m: number) => String(m).padStart(2, '0');
const clock24 = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "9 AM", "9:30 AM" · 24-hour: "09:00", "09:30" */
export function fmtTime(t: number) {
  const d = new Date(t);
  if (prefs.hour24) return clock24(d);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h12(h)}${m ? ':' + pad(m) : ''} ${ampm(h)}`;
}

/** A time without AM/PM, for a column that already says it: "9:30" · 24-hour: "09:30" */
export function fmtTimeBare(t: number) {
  const d = new Date(t);
  return prefs.hour24 ? clock24(d) : `${h12(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact form for month cells: "9a", "2:30p" · 24-hour: "9:00", "14:30" */
export function fmtTimeShort(t: number) {
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  if (prefs.hour24) return `${h}:${pad(m)}`;
  return `${h12(h)}${m ? ':' + pad(m) : ''}${h < 12 ? 'a' : 'p'}`;
}

/** "10 – 11 AM", "11:30 AM – 1 PM" · 24-hour: "10:00 – 11:00" */
export function fmtTimeRange(a: number, b: number) {
  if (prefs.hour24) return `${fmtTime(a)} – ${fmtTime(b)}`;
  const ha = new Date(a).getHours();
  const hb = new Date(b).getHours();
  if (ampm(ha) === ampm(hb)) return `${fmtTime(a).replace(/ [AP]M$/, '')} – ${fmtTime(b)}`;
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}

/** Gutter labels: "9 AM", "Noon" · 24-hour: "09:00", "12:00" */
export function fmtHour(h: number) {
  if (prefs.hour24) return `${pad(h)}:00`;
  return h === 12 ? 'Noon' : `${h12(h)} ${ampm(h)}`;
}

/** "Tue, Oct 13, 2:00 PM" (toasts) */
export const fmtWhen = (t: number) => `${new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmtTime(t)}`;

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
