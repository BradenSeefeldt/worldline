// Which relays to use, kept up to date without anyone checking by hand. Pure (no imports), so the weekly checker
// (scripts/check-relays.ts, run by .github/workflows/relays.yml) and the app share it.
//
// The list lives in public/relays.json, served next to the guest page on GitHub Pages. The app and the guest page
// read it when they start (falling back to the copy built in, then to BUILTIN). The weekly checker tests every relay
// in it plus the candidates, and opens a pull request swapping a failing relay for a working candidate; merging it
// updates every app and every guest page within minutes, no new release needed.
//
// Why old links and old apps keep working through a change: the guest page talks to the current relays AND every
// relay retired in the last year, so an app still on an older list (offline, couldn't fetch) still reaches guests.

export interface RelayList {
  updated: string; // YYYY-MM-DD
  relays: string[]; // in use: the app publishes and reads here
  retired: { url: string; since: string }[]; // taken out of use; the guest page still uses them for a year
  candidates: string[]; // tested every week; the best working one replaces a relay that fails
}

/** Built into the code: used when the list can't be fetched and nothing is cached. */
export const BUILTIN = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
  'wss://relay.illuminodes.com',
];

export const TARGET = 7; // relays in use
const MIN_WORKING = 3; // fewer than this passing in a check → assume the check itself is broken, change nothing
const GUEST_MAX = 12; // the guest page talks to at most this many
const RETIRED_DAYS = 365;

const isRelay = (u: unknown): u is string => typeof u === 'string' && /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(u) && u.length < 200;
const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const uniq = (a: string[]) => [...new Set(a)];

/** Read a fetched relays.json. Anything that doesn't look right → null (and the caller keeps what it had). */
export function parseRelayList(raw: unknown): RelayList | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = raw as Record<string, unknown>;
  if (!Array.isArray(x.relays)) return null;
  const relays = uniq(x.relays.filter(isRelay));
  if (relays.length < 2 || relays.length > 20) return null;
  const retired = Array.isArray(x.retired)
    ? x.retired.filter((r): r is { url: string; since: string } => !!r && typeof r === 'object' && isRelay((r as { url?: unknown }).url) && isDay((r as { since?: unknown }).since))
    : [];
  const candidates = Array.isArray(x.candidates) ? uniq(x.candidates.filter(isRelay)) : [];
  return { updated: isDay(x.updated) ? x.updated : '', relays, retired, candidates };
}

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** The guest page: the current relays, then ones retired within a year, then the built-in ones — at most 12. */
export function guestRelays(list: RelayList | null, today: string): string[] {
  const recent = (list?.retired ?? []).filter((r) => daysBetween(r.since, today) <= RETIRED_DAYS).map((r) => r.url);
  return uniq([...(list?.relays ?? []), ...recent, ...BUILTIN]).slice(0, GUEST_MAX);
}

/** The result of testing one relay: it took a message, gave it back, and still keeps old ones. */
export interface Probe {
  ok: boolean;
  ms: number; // how long the round trip took (lower is better)
  why?: string;
}

/**
 * The weekly checker's decision: keep relays that passed, replace failing ones with the fastest working candidates
 * (and top up to TARGET), retire what was removed (it becomes a candidate again, in case it comes back).
 * If hardly anything passed, the check itself is probably what's broken (the runner's network): change nothing.
 */
export function planRelayList(list: RelayList, results: Record<string, Probe>, today: string) {
  const passed = (u: string) => !!results[u]?.ok;
  const working = uniq([...list.relays, ...list.candidates]).filter(passed);
  if (working.length < MIN_WORKING) return { list, added: [] as string[], removed: [] as string[], trouble: `Only ${working.length} relay(s) passed — the check is probably broken; nothing changed.` };
  const keep = list.relays.filter(passed);
  const removed = list.relays.filter((u) => !passed(u));
  const added = list.candidates
    .filter((u) => passed(u) && !keep.includes(u))
    .sort((a, b) => results[a].ms - results[b].ms)
    .slice(0, Math.max(0, TARGET - keep.length));
  if (!removed.length && !added.length) return { list, added, removed, trouble: keep.length < 5 ? `Only ${keep.length} relays working and no candidates left — add candidates to relays.json.` : null };
  const next: RelayList = {
    updated: today,
    relays: [...keep, ...added],
    retired: [...list.retired.filter((r) => !added.includes(r.url) && daysBetween(r.since, today) <= RETIRED_DAYS), ...removed.map((url) => ({ url, since: today }))],
    candidates: uniq([...list.candidates.filter((u) => !added.includes(u)), ...removed]),
  };
  const trouble = next.relays.length < 5 ? `Only ${next.relays.length} relays working and no candidates left — add candidates to relays.json.` : null;
  return { list: next, added, removed, trouble };
}
