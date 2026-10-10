// Find a time zone by typing a city, province/state, country, or zone name ("Mountain", "MST").
// City data: the `city-timezones` package (~7,300 cities). It's large, so it's loaded only when
// the picker opens.
import { fmtOffset, zoneAbbr, zoneCity, zoneOffset } from './zone';
import { typoDistance } from './fuzzy';

export interface City {
  city: string;
  city_ascii: string;
  province: string;
  country: string;
  iso2: string;
  iso3: string;
  pop: number;
  timezone: string;
}

export interface ZoneHit {
  label: string; // "Calgary" — or "Mountain Time" for a whole zone
  sub: string; // "Alberta, Canada" — or "Denver, Phoenix, Calgary…"
  zone: string; // "America/Edmonton"
  isZone?: boolean;
}

interface ZoneInfo {
  zone: string;
  words: string[];
  pop: number; // total population of its cities, to rank zones
  cities: string[]; // biggest first
}

export interface ZoneIndex {
  entries: Entry[];
  zones: ZoneInfo[];
}

export interface Entry extends ZoneHit {
  name: string[]; // lowercase words of the place name
  region: string[]; // province/state words
  country: string[]; // country words + ISO codes
  zoneWords: string[]; // "mountain", "daylight", "mdt", "edmonton"…
  pop: number;
}

const norm = (s: unknown) =>
  String(s ?? '') // a few dataset entries have numbers or nulls in text fields
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // é → e
    .toLowerCase();
const wordsOf = (s: unknown) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Zone names to search by: abbreviation (MST/MDT), long names ("Mountain Standard Time"), city in the id. */
const zoneWordCache = new Map<string, string[]>();
function zoneWords(tz: string) {
  let w = zoneWordCache.get(tz);
  if (!w) {
    const jan = new Date(2026, 0, 15).getTime();
    const jul = new Date(2026, 6, 15).getTime();
    const long = (t: number) =>
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(t).find((p) => p.type === 'timeZoneName')?.value ?? '';
    w = [...new Set([...wordsOf(long(jan)), ...wordsOf(long(jul)), ...wordsOf(zoneAbbr(tz, jan)), ...wordsOf(zoneAbbr(tz, jul))])];
    zoneWordCache.set(tz, w);
  }
  return w;
}

export function buildIndex(cities: City[], zones: string[]): ZoneIndex {
  const out: Entry[] = cities
    .filter((c) => c.timezone)
    .map((c) => ({
      label: c.city,
      sub: [c.province, c.country].filter((x) => x && x !== c.city).join(', '),
      zone: c.timezone,
      name: wordsOf(c.city_ascii || c.city),
      region: wordsOf(c.province ?? ''),
      country: [...wordsOf(c.country), norm(c.iso2 ?? ''), norm(c.iso3 ?? '')],
      zoneWords: [...zoneWords(c.timezone), ...wordsOf(zoneCity(c.timezone))],
      pop: c.pop || 0,
    }));
  // Every zone is findable by its own name too ("Kathmandu", "Asia/Kolkata").
  for (const z of zones)
    out.push({ label: zoneCity(z), sub: z.split('/')[0].replace(/_/g, ' '), zone: z, name: wordsOf(zoneCity(z)), region: [], country: [], zoneWords: [...zoneWords(z), ...wordsOf(zoneCity(z))], pop: 0 });

  const byZone = new Map<string, ZoneInfo>();
  for (const e of out) {
    const z = byZone.get(e.zone) ?? { zone: e.zone, words: zoneWords(e.zone), pop: 0, cities: [] };
    z.pop += e.pop;
    if (e.pop) z.cities.push(e.label);
    byZone.set(e.zone, z);
  }
  const popOf = new Map(out.map((e) => [e.label, e.pop]));
  for (const z of byZone.values()) z.cities.sort((a, b) => (popOf.get(b) ?? 0) - (popOf.get(a) ?? 0));
  return { entries: out, zones: [...byZone.values()] };
}

/** A zone's everyday name: "Mountain Time", "Central European Time". */
function zoneName(tz: string) {
  const long = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(Date.now()).find((p) => p.type === 'timeZoneName')?.value ?? tz;
  return long.replace(/ (Standard|Daylight|Summer)( Time)?$/, ' Time');
}

/** Best matches for what's typed; every typed word must match something. */
export function searchZones(index: ZoneIndex, query: string, limit = 8): ZoneHit[] {
  const q = wordsOf(query);
  if (!q.length) return [];

  // Typing a zone's name ("mountain", "mst", "central european") → the zones themselves first.
  const zoneHits: ZoneHit[] = index.zones
    .filter((z) => q.join(' ').length >= 3 && z.pop > 0)
    .filter((z) => q.every((w, i) => z.words.some((x) => (i === q.length - 1 ? x.startsWith(w) : x === w))))
    .sort((a, b) => b.pop - a.pop)
    .slice(0, 3)
    .map((z) => ({ label: zoneName(z.zone), sub: z.cities.slice(0, 3).join(', '), zone: z.zone, isZone: true }));

  const scored: { e: Entry; s: number; fuzzy: boolean }[] = [];
  for (const e of index.entries) {
    let s = 0;
    let ok = true;
    let fuzzy = false;
    for (const [i, w] of q.entries()) {
      const last = i === q.length - 1; // the word still being typed may be partial
      const pre = (xs: string[]) => xs.some((x) => (last ? x.startsWith(w) : x === w || (w.length >= 3 && x.startsWith(w))));
      let best = 0;
      if (e.name.join(' ') === q.join(' ')) best = 5; // exactly the city
      else if (pre(e.name)) best = e.name[0].startsWith(w) ? 4 : 3;
      else if (w.length >= 5 && e.name.some((x) => typoDistance(w, last ? x.slice(0, w.length) : x) <= 1)) {
        best = 1.5; // "calagry"
        fuzzy = true;
      }
      // A whole province/state/country name ("ontario", "canada") lists its biggest cities.
      if (pre(e.region)) best = Math.max(best, e.region.includes(w) ? 4.5 : 2);
      if (pre(e.country)) best = Math.max(best, e.country.includes(w) ? 3.5 : 1.5);
      if (w.length >= 2 && pre(e.zoneWords)) best = Math.max(best, e.pop ? 1 : 2.5); // "mountain", "mst"
      if (!best) { ok = false; break; }
      s += best;
    }
    if (ok) scored.push({ e, s: s + Math.log10(e.pop + 10) * 0.5, fuzzy }); // bigger places first among equals
  }
  // Typo matches only when nothing matches properly.
  const exact = scored.filter((x) => !x.fuzzy);
  const pool = exact.length ? exact : scored;
  pool.sort((a, b) => b.s - a.s);
  const seen = new Set<string>();
  const hits: ZoneHit[] = [...zoneHits];
  for (const { e } of pool) {
    const key = `${e.label}|${e.sub}`;
    const same = `${e.label}|${e.zone}`; // a zone's own entry ("Toronto | America") duplicates the city
    if (seen.has(key) || (!e.pop && seen.has(same))) continue;
    seen.add(key);
    seen.add(same);
    hits.push({ label: e.label, sub: e.sub, zone: e.zone });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** "Mountain · MDT · UTC−6" for a result row. */
export function describeZone(tz: string, t = Date.now()) {
  const long = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(t).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const short = long.replace(/ (Standard|Daylight|Summer) Time$/, '').replace(/ Time$/, '');
  const abbr = zoneAbbr(tz, t);
  const off = fmtOffset(zoneOffset(tz, t));
  return abbr.startsWith('UTC') ? `${short} · ${off}` : `${short} · ${abbr} · ${off}`;
}

/** Local time there right now: "7:42 PM" */
export const timeIn = (tz: string, t = Date.now()) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t);
