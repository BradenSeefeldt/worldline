// The page someone you send a link to opens (hosted as a static page — code only, no data). It reads the link's
// keys from the address's "#…", fetches the encrypted free/busy from the relays, and sends the guest's booking or
// poll answer back the same way. Nothing about the guest is asked for or stored anywhere but their own browser.
import { useEffect, useMemo, useRef, useState } from 'react';
import { generateSecretKey, type Event } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { BookView, PollView, type MyBooking } from '../pages/GuestPage';
import { KIND, derive, latestPerGuest, openAvail, openGuestMsg, parseFragment, resolveHolds, sealGuestMsg, withHolds, type Decoded, type LinkRef, type RemoteView } from '../lib/schedwire';
import type { Transport } from '../lib/relays';
import { useNow } from '../lib/hooks';

/** What this browser remembers about a link: its own bookings (the signed events, to send again if a relay lost
 *  them) and its poll key + answer. Only in this browser's storage. */
interface Saved {
  bookings: { sk: string; ev: Event; start: number; lost?: boolean }[]; // lost: someone else's request came first
  poll?: { sk: string; ev?: Event; name: string; cells: number[] };
}
const storeKey = (ref: LinkRef) => `wl-link-${ref.hostPk.slice(0, 16)}`;
const load = (ref: LinkRef): Saved => {
  try {
    return { bookings: [], ...(JSON.parse(localStorage.getItem(storeKey(ref)) ?? '{}') as Partial<Saved>) };
  } catch {
    return { bookings: [] };
  }
};
const save = (ref: LinkRef, s: Saved) => {
  try {
    localStorage.setItem(storeKey(ref), JSON.stringify(s));
  } catch {
    /* private mode: it just won't be remembered */
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OFFLINE = 'Couldn’t reach the network — check your connection and try again.';

function Card({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="gp-card"><h1 className="gp-title">{title}</h1>{children}</div>;
}

export function RemoteGuest({ transport, hash }: { transport: Transport; hash: string }) {
  const ref = useMemo(() => parseFragment(hash), [hash]);
  const tags = useMemo(() => (ref ? derive(ref.secret) : null), [ref]);
  const [avail, setAvail] = useState<{ view: RemoteView; at: number } | null>(null);
  const [msgs, setMsgs] = useState<Map<string, Decoded>>(new Map());
  const [phase, setPhase] = useState<'loading' | 'slow' | 'ready'>('loading');
  const [saved, setSaved] = useState<Saved>(() => (ref ? load(ref) : { bookings: [] }));
  const now = useNow(30_000);
  const best = useRef(0);
  const latest = useRef<RemoteView | null>(null); // the newest availability, for code that awaits
  latest.current = avail?.view ?? null;

  useEffect(() => {
    if (!ref || !tags) return;
    best.current = 0;
    const stopA = transport.subscribe({ kinds: [KIND], authors: [ref.hostPk], '#d': [tags.availTag] }, (ev) => {
      if (ev.created_at <= best.current) return;
      const view = openAvail(ev, ref);
      if (!view) return;
      best.current = ev.created_at;
      setAvail({ view, at: ev.created_at });
      setPhase('ready');
    });
    const stopM = transport.subscribe({ kinds: [KIND], '#d': [tags.msgTag] }, (ev) => {
      const d = openGuestMsg(ev, ref);
      if (!d) return;
      setMsgs((m) => {
        const cur = m.get(d.pk);
        if (cur && (cur.at > d.at || (cur.at === d.at && cur.id <= d.id))) return m;
        return new Map(m).set(d.pk, d);
      });
    });
    const slow = setTimeout(() => setPhase((p) => (p === 'loading' ? 'slow' : p)), 9000);
    // send this browser's own messages again: if a relay dropped them, this puts them back
    const mine = load(ref);
    for (const b of mine.bookings) if (!b.lost) void transport.publish(b.ev).catch(() => 0);
    if (mine.poll?.ev) void transport.publish(mine.poll.ev).catch(() => 0);
    return () => {
      stopA();
      stopM();
      clearTimeout(slow);
    };
  }, [ref, tags, transport]);

  const view = avail?.view ?? null;
  useEffect(() => {
    document.title = view ? `${view.title}${view.hostName ? ` · ${view.hostName}` : ''}` : 'Worldline';
  }, [view]);

  if (!ref) return <Card title="This link is incomplete"><p className="gp-empty">Part of the address seems to be missing. Copy the whole link again (everything after the #, too).</p></Card>;
  if (!view)
    return phase === 'loading' ? (
      <Card title="Loading…"><p className="gp-empty"><i className="gp-dot" />Fetching open times</p></Card>
    ) : (
      <Card title="Can’t find this link yet">
        <p className="gp-empty">Either it hasn’t been published yet (the calendar that made it publishes as soon as it’s online), or this device can’t reach the network. This page keeps trying — it will appear here on its own.</p>
      </Card>
    );
  if (view.gone) return <Card title="This link is closed"><p className="gp-empty">It was deleted or replaced. Ask for a new one.</p></Card>;

  const all = [...msgs.values()];
  const minePks = new Set([...saved.bookings.map((b) => b.ev.pubkey), ...(saved.poll?.ev ? [saved.poll.ev.pubkey] : [])]);

  if (view.mode === 'book') {
    const { winners, losers } = resolveHolds(view, all, now);
    const shown = withHolds(view, winners, minePks, now);
    const myBookings: MyBooking[] = saved.bookings.map((b) => {
      const dec = view.decisions[b.ev.pubkey];
      if (dec && dec.id === b.ev.id) return { start: b.start, status: dec.status };
      if (b.lost || losers.some((h) => h.pk === b.ev.pubkey)) return { start: b.start, status: 'lost' };
      return { start: b.start, status: 'pending' };
    });
    const confirm = async (start: number, name: string) => {
      const sk = generateSecretKey();
      const ev = sealGuestMsg({ t: 'book', start, name }, ref, sk, Math.max(Math.floor(Date.now() / 1000), avail!.at + 1));
      const acks = await transport.publish(ev).catch(() => 0);
      if (!acks) return { ok: false, reason: OFFLINE };
      const next: Saved = { ...saved, bookings: [...saved.bookings, { sk: bytesToHex(sk), ev, start }] };
      save(ref, next);
      // Two people clicking the same time within a second or two: wait a moment, look again, and apply the rule
      // every page and the host's app use (earliest request wins).
      await sleep(2500);
      const fresh = await transport.query({ kinds: [KIND], '#d': [tags!.msgTag] }).catch(() => [] as Event[]);
      const decoded = latestPerGuest([...all, ...fresh.map((e) => openGuestMsg(e, ref)).filter((d): d is Decoded => !!d), { pk: ev.pubkey, id: ev.id, at: ev.created_at, msg: { t: 'book', start } }]);
      setMsgs(new Map(decoded.map((d) => [d.pk, d])));
      setSaved(next);
      const cur = latest.current ?? view;
      const dec = cur.decisions[ev.pubkey];
      if (dec?.id === ev.id && dec.status !== 'ok') return { ok: true }; // the host's app already answered: the page shows why
      if (resolveHolds(cur, decoded, Date.now()).losers.some((h) => h.pk === ev.pubkey)) {
        void transport.publish(sealGuestMsg({ t: 'cancel' }, ref, sk, ev.created_at + 1)).catch(() => 0);
        const kept = { ...next, bookings: next.bookings.map((b) => (b.ev.id === ev.id ? { ...b, lost: true } : b)) };
        save(ref, kept);
        setSaved(kept);
        return { ok: false, reason: '' }; // the page says why (the booking is remembered as lost)
      }
      return { ok: true };
    };
    return <BookView key={view.id} v={shown} mine={myBookings} updatedAt={view.updatedAt} onConfirm={confirm} />;
  }

  // group poll
  const answers = latestPerGuest(all).filter((d) => d.msg.t === 'poll' && !minePks.has(d.pk));
  const byName = new Map<string, { name: string; cells: number[] }>();
  for (const d of answers.sort((a, b) => a.at - b.at)) if (d.msg.t === 'poll') byName.set(d.msg.name.toLowerCase(), { name: d.msg.name, cells: d.msg.cells });
  const onSave = async (name: string, cells: number[]) => {
    const sk = saved.poll ? hexToBytes(saved.poll.sk) : generateSecretKey();
    const ev = sealGuestMsg({ t: 'poll', name, cells }, ref, sk, Math.max(Math.floor(Date.now() / 1000), (saved.poll?.ev?.created_at ?? 0) + 1, avail!.at + 1));
    const acks = await transport.publish(ev).catch(() => 0);
    if (!acks) return { ok: false, reason: OFFLINE };
    const next = { ...saved, poll: { sk: bytesToHex(sk), ev, name, cells } };
    save(ref, next);
    setSaved(next);
    return { ok: true };
  };
  return <PollView key={view.id} v={withHolds(view, [], minePks, now)} others={[...byName.values()]} mine={saved.poll ? { name: saved.poll.name, cells: saved.poll.cells } : null} updatedAt={view.updatedAt} onSave={onSave} />;
}
