// Time zones. The calendar is always drawn in this computer's current zone; these helpers
// name zones, compare them, and convert all-day dates so they don't shift when you travel.

const DAY = 86_400_000;

/** This device's zone now. (Asked of Intl at most once a second: it's slow, and called for every event drawn.) */
let zoneSeen = { at: -Infinity, tz: '' };
export const localZone = () => {
  const now = Date.now();
  if (now - zoneSeen.at > 1000 || now < zoneSeen.at) zoneSeen = { at: now, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  return zoneSeen.tz;
};

/** "America/Toronto" → "Toronto", "America/Argentina/Buenos_Aires" → "Buenos Aires" */
export const zoneCity = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ');

/** Short name at instant t: "EDT", "CET", or "GMT+5:30" when there is no common abbreviation. */
export function zoneAbbr(tz: string, t = Date.now()) {
  const part = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(t).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const us = part('en-US');
  if (!us.startsWith('GMT')) return us;
  const gb = part('en-GB'); // Europe: "CET", "BST"
  return gb.startsWith('GMT') || gb.startsWith('UTC') ? us.replace('GMT', 'UTC') : gb;
}

// A zone's clock is read through Intl, never through this computer's own zone, so every device gets the same answer
// (one formatter per zone, kept: making them is the slow part).
const clocks = new Map<string, Intl.DateTimeFormat>();
const clock = (tz: string) => {
  let f = clocks.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    clocks.set(tz, f);
  }
  return f;
};

/** Offset from UTC in minutes at instant t (e.g. Toronto in summer → -240). Clocks change on a quarter hour, so the
 *  answer is kept per zone and quarter hour (reading a feed asks thousands of times). */
const offsets = new Map<string, number>();
const Q = 15 * 60_000;
export function zoneOffset(tz: string, t = Date.now()) {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 0;
  if (t % Q === 0 || !Number.isFinite(t)) return offsetAt(tz, t);
  const k = `${tz}|${Math.floor(t / Q)}`;
  let o = offsets.get(k);
  if (o === undefined) {
    const a = offsetAt(tz, Math.floor(t / Q) * Q);
    // (kept only when the quarter hour has one offset throughout — not across an old zone's odd-second change)
    if (a !== offsetAt(tz, Math.floor(t / Q) * Q + Q - 1000)) return offsetAt(tz, t);
    if (offsets.size > 100_000) offsets.clear();
    offsets.set(k, (o = a));
  }
  return o;
}
function offsetAt(tz: string, t: number) {
  const p: Record<string, number> = {};
  for (const x of clock(tz).formatToParts(t)) if (x.type !== 'literal') p[x.type] = +x.value;
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((wall - Math.floor(t / 1000) * 1000) / 60_000);
}

/** "UTC−4", "UTC+5:30" */
export function fmtOffset(minutes: number) {
  const sign = minutes < 0 ? '−' : '+';
  const a = Math.abs(minutes);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
}

/** Wall-clock parts of instant t in zone tz (this computer's zone if tz is missing). */
export function wallClock(t: number, tz?: string) {
  if (!tz || tz === localZone()) {
    const d = new Date(t);
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), min: d.getMinutes(), wd: d.getDay() };
  }
  const d = new Date(t + zoneOffset(tz, t) * 60_000); // its UTC fields are the wall clock in tz
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), wd: d.getUTCDay() };
}

/**
 * The instant of a wall-clock time in zone tz. A time that happens twice (the hour repeated when the clocks go back)
 * is the first of the two; a time that doesn't exist (skipped when they go forward) is read with the offset from
 * before the change, so 2:30 becomes 3:30. That is the rule JavaScript itself uses for this computer's zone, and
 * here it's worked out from the zone's offsets alone, so every device, whatever its own zone, gets the same instant
 * (an exception saved on one device must match its occurrence on another).
 */
export function instantOf(y: number, m: number, d: number, minutes: number, tz?: string) {
  if (!tz || tz === localZone()) {
    const x = new Date(y, m, d);
    x.setHours(0, minutes, 0, 0);
    return x.getTime();
  }
  const wall = Date.UTC(y, m, d, 0, minutes); // the wall clock read as if it were UTC
  if (tz === 'UTC' || tz === 'Etc/UTC') return wall;
  const before = zoneOffset(tz, wall - DAY), after = zoneOffset(tz, wall + DAY); // the offsets either side of any change
  const fits = [before, after].map((o) => wall - o * 60_000).filter((t) => zoneOffset(tz, t) * 60_000 === wall - t);
  return fits.length ? Math.min(...fits) : wall - before * 60_000;
}

// ---- all-day events are dates, not instants ---------------------------------------------
// Stored as UTC midnight of the date ("floating"), shown as local midnight of the same date,
// so "Oct 20 all-day" stays Oct 20 in Toronto, Paris or Tokyo.

/** Local midnight → stored date. */
export function encodeDay(localMidnight: number) {
  const d = new Date(localMidnight);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Stored date → local midnight. Also accepts old values saved as a local midnight (±12 h). */
export function decodeDay(t: number) {
  const d = new Date(t + DAY / 2);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

export const epochDay = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m, d) / DAY);
export const fromEpochDay = (e: number) => {
  const d = new Date(e * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
};
