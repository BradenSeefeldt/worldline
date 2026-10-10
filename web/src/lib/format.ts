const ampm = (h: number) => (h < 12 ? 'AM' : 'PM');
const h12 = (h: number) => h % 12 || 12;
const pad = (m: number) => String(m).padStart(2, '0');

/** "9 AM", "9:30 AM" */
export function fmtTime(t: number) {
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h12(h)}${m ? ':' + pad(m) : ''} ${ampm(h)}`;
}

/** Compact form for month cells: "9a", "2:30p" */
export function fmtTimeShort(t: number) {
  const d = new Date(t);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h12(h)}${m ? ':' + pad(m) : ''}${h < 12 ? 'a' : 'p'}`;
}

/** "10 – 11 AM", "11:30 AM – 1 PM" */
export function fmtTimeRange(a: number, b: number) {
  const ha = new Date(a).getHours();
  const hb = new Date(b).getHours();
  if (ampm(ha) === ampm(hb)) return `${fmtTime(a).replace(/ [AP]M$/, '')} – ${fmtTime(b)}`;
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}

/** Gutter labels: "9 AM", "Noon" */
export function fmtHour(h: number) {
  return h === 12 ? 'Noon' : `${h12(h)} ${ampm(h)}`;
}

export const cls = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
