// The network side of scheduling links: public Nostr relays. Every message goes to all of them (any one that keeps
// it is enough); reads ask all of them and merge. A relay that's down, slow or refuses is simply skipped.
import { SimplePool } from 'nostr-tools/pool';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { BUILTIN, parseRelayList, type RelayList } from './relaylist';

export { guestRelays, type RelayList } from './relaylist';

/** The relays in use (kept current by public/relays.json — see lib/relaylist.ts). Chosen by testing: free, no
 *  sign-up, accept kind 30078 from a brand-new key, return it by its tag, and still serve year-old events. */
export const RELAYS = BUILTIN;

/** What the scheduling code needs from "the network" — the real relays, or an in-memory one in tests. */
export interface Transport {
  /** Send to every relay; resolves with how many accepted it (waits for the slowest, up to 8 s). */
  publish: (ev: Event) => Promise<number>;
  /** Send to every relay; resolves true as soon as ONE has stored it (false if none can), the rest keep going in
   *  the background. For a guest pressing Save: the first relay is enough to be safe, no need to wait for the slowest. */
  send: (ev: Event) => Promise<boolean>;
  /** Everything matching from every relay that answers within a few seconds (duplicates removed). */
  query: (filter: Filter) => Promise<Event[]>;
  /** New matching events as they arrive (and stored ones first). Returns a function that stops it. */
  subscribe: (filter: Filter, onEvent: (ev: Event) => void) => () => void;
  /** How many relays it talks to (for "Live · on 6 of 7 relays"). */
  size?: number;
  /** Disconnect from everything (when switching to a new relay list). */
  close?: () => void;
  /** Which relays are connected right now (Settings → Scheduling). */
  health?: () => { url: string; ok: boolean }[];
}

/** The current relay list: fetched (and remembered for next time), else the last one remembered, else built in.
 *  A fetch that fails or returns nonsense never replaces a good list. */
export async function loadRelayList(url: string, cacheKey = 'wl-relays'): Promise<RelayList | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-cache' });
    clearTimeout(timer);
    const list = res.ok ? parseRelayList(await res.json()) : null;
    if (list) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(list));
      } catch {
        /* no storage: fine */
      }
      return list;
    }
  } catch {
    /* offline or blocked: fall back */
  }
  try {
    return parseRelayList(JSON.parse(localStorage.getItem(cacheKey) ?? 'null'));
  } catch {
    return null;
  }
}

export function relayTransport(relays = RELAYS): Transport {
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  return {
    size: relays.length,
    close: () => pool.destroy(),
    health: () => {
      const st = pool.listConnectionStatus();
      const norm = (u: string) => u.replace(/\/+$/, '');
      const live = new Map([...st].map(([u, ok]) => [norm(u), ok]));
      return relays.map((url) => ({ url, ok: !!live.get(norm(url)) }));
    },
    publish: async (ev) => (await Promise.allSettled(pool.publish(relays, ev, { maxWait: 8000 }))).filter((r) => r.status === 'fulfilled').length,
    send: (ev) => Promise.any(pool.publish(relays, ev, { maxWait: 8000 })).then(() => true, () => false),
    query: (filter) => pool.querySync(relays, filter, { maxWait: 7000 }),
    subscribe: (filter, onEvent) => {
      const sub = pool.subscribeMany(relays, filter, { onevent: onEvent });
      return () => sub.close();
    },
  };
}

/** A relay in memory, behaving like a real one for what we use (replaceable events keep only the newest). For tests. */
export function memoryTransport(opts: { down?: boolean } = {}): Transport & { events: Event[]; down: boolean } {
  const subs = new Set<{ filter: Filter; on: (ev: Event) => void }>();
  const t = {
    events: [] as Event[],
    down: !!opts.down,
    publish: async (ev: Event) => {
      if (t.down) return 0;
      const d = ev.tags.find((x) => x[0] === 'd')?.[1];
      const same = (e: Event) => e.kind === ev.kind && e.pubkey === ev.pubkey && e.tags.find((x) => x[0] === 'd')?.[1] === d;
      const cur = t.events.find(same);
      if (cur && cur.created_at >= ev.created_at) return 1; // relays keep the newer one
      t.events = [...t.events.filter((e) => !same(e)), ev];
      for (const s of subs) if (matchFilter(s.filter, ev)) s.on(ev);
      return 1;
    },
    send: async (ev: Event) => (await t.publish(ev)) > 0,
    query: async (filter: Filter) => (t.down ? [] : t.events.filter((e) => matchFilter(filter, e))),
    subscribe: (filter: Filter, on: (ev: Event) => void) => {
      const s = { filter, on };
      subs.add(s);
      if (!t.down) for (const e of t.events) if (matchFilter(filter, e)) on(e);
      return () => void subs.delete(s);
    },
  };
  return t;
}
