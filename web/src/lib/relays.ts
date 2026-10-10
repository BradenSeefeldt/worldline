// The network side of scheduling links: public Nostr relays. Every message goes to all of them (any one that keeps
// it is enough); reads ask all of them and merge. A relay that's down, slow or refuses is simply skipped.
import { SimplePool } from 'nostr-tools/pool';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';

/**
 * Chosen by testing (Oct 2026): free, no sign-up, accept kind 30078 from a brand-new key, return it by its tag, and
 * still serve events more than a year old. Run independently by different people in different places.
 * Relays that failed: paid or invite-only (nostr.wine, nostr.land, web-of-trust / NIP-05 relays), kind-restricted
 * (relay.nos.social, purplepag.es), short memory (relay.snort.social, nostr-pub.wellorder.net), gone (relay.nostr.band).
 * The guest page and the app share this list, so a later version can change it and old links keep working.
 */
export const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://offchain.pub',
  'wss://relay.nostr.net',
  'wss://nostr.oxtr.dev',
];

/** What the scheduling code needs from "the network" — the real relays, or an in-memory one in tests. */
export interface Transport {
  /** Send to every relay; resolves with how many accepted it. */
  publish: (ev: Event) => Promise<number>;
  /** Everything matching from every relay that answers within a few seconds (duplicates removed). */
  query: (filter: Filter) => Promise<Event[]>;
  /** New matching events as they arrive (and stored ones first). Returns a function that stops it. */
  subscribe: (filter: Filter, onEvent: (ev: Event) => void) => () => void;
}

export function relayTransport(relays = RELAYS): Transport {
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  return {
    publish: async (ev) => (await Promise.allSettled(pool.publish(relays, ev, { maxWait: 8000 }))).filter((r) => r.status === 'fulfilled').length,
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
