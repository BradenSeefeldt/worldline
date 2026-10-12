// The page someone you send a link to opens (hosted as a static page — code only, no data). It reads the link's
// keys from the address's "#…", fetches the encrypted free/busy from the relays, and sends the guest's booking or
// poll answer back the same way. Nothing about the guest is asked for or stored anywhere but their own browser.
import { useEffect, useMemo, useRef, useState } from 'react';
import { generateSecretKey, type Event } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { BookView, PollView, type MyBooking } from '../pages/GuestPage';
import { KIND, REFUSAL_KEEP, derive, latestPerGuest, openAvail, openGuestMsg, parseFragment, resolveHolds, sealGuestMsg, toWithdraw, withHolds, type Decoded, type LinkRef, type RemoteView, type Status } from '../lib/schedwire';
import type { Transport } from '../lib/relays';
import { useNow } from '../lib/hooks';
import { format } from 'date-fns';
import { fmtTime } from '../lib/format';

/** What this browser remembers about a link: its own bookings (the signed events, to send again if a relay lost
 *  them, and the host's answer once seen — the published answers are trimmed after a while) and its poll key +
 *  answer. Only in this browser's storage. */
interface Saved {
  bookings: { sk: string; ev: Event; start: number; lost?: boolean; dec?: Status }[]; // lost: withdrawn after losing a race
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
    for (const b of mine.bookings) if (!b.lost) void transport.send(b.ev).catch(() => 0);
    if (mine.poll?.ev) void transport.send(mine.poll.ev).catch(() => 0);
    return () => {
      stopA();
      stopM();
      clearTimeout(slow);
    };
  }, [ref, tags, transport]);

  const view = avail?.view ?? null;
  // The host's answers to this browser's bookings: remembered, since the published ones are trimmed after a while.
  // (A booking that seems to have lost a race on this page is NOT withdrawn here: the other request's clock may be
  // forged, and the host's app — which can tell — may still confirm this one. It's withdrawn only if the guest books
  // another time instead; see `confirm`.)
  useEffect(() => {
    if (!ref || !view || view.mode !== 'book') return;
    const fresh = saved.bookings.some((b) => view.decisions[b.ev.pubkey]?.id === b.ev.id && view.decisions[b.ev.pubkey].status !== b.dec);
    if (!fresh) return;
    const next = { ...saved, bookings: saved.bookings.map((b) => (view.decisions[b.ev.pubkey]?.id === b.ev.id ? { ...b, dec: view.decisions[b.ev.pubkey].status } : b)) };
    save(ref, next);
    setSaved(next);
  }, [view, saved, ref]);
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
  if (view.gone) {
    // their meeting went with the link: say so plainly
    const off = saved.bookings.filter((b) => !b.lost && b.start > now);
    return (
      <Card title={off.length ? 'This meeting was cancelled' : 'This link is closed'}>
        {off.map((b) => <p key={b.ev.id} className="gp-error">Your meeting on {format(b.start, 'EEEE, MMMM d')} at {fmtTime(b.start)} is cancelled{view.hostName ? ` — ${view.hostName} deleted this link` : ''}.</p>)}
        <p className="gp-empty">{off.length ? 'Ask for a new link if you’d like another time.' : 'It was deleted or replaced. Ask for a new one.'}</p>
      </Card>
    );
  }

  const all = [...msgs.values()];
  const minePks = new Set([...saved.bookings.map((b) => b.ev.pubkey), ...(saved.poll?.ev ? [saved.poll.ev.pubkey] : [])]);

  if (view.mode === 'book') {
    const { winners, losers } = resolveHolds(view, all, now);
    const shown = withHolds(view, winners, minePks, now);
    const myBookings: MyBooking[] = saved.bookings.map((b) => {
      const dec = view.decisions[b.ev.pubkey];
      if (dec && dec.id === b.ev.id) return { start: b.start, status: dec.status };
      if (b.dec) return { start: b.start, status: b.dec };
      if (b.lost || losers.some((h) => h.pk === b.ev.pubkey)) return { start: b.start, status: 'lost' };
      // the host's app has published long after this was sent and never answered it: it isn't going ahead
      if (view.updatedAt > b.ev.created_at * 1000 + REFUSAL_KEEP) return { start: b.start, status: 'expired' };
      return { start: b.start, status: 'pending' };
    });
    const confirm = async (start: number, name: string) => {
      const sk = generateSecretKey();
      // quotes the version of the times it was made against, so the host's app can check its clock (lib/schedwire.ts)
      const av = view.tok ? { at: avail!.at, tok: view.tok } : undefined;
      const ev = sealGuestMsg({ t: 'book', start, name, av }, ref, sk, Math.max(Math.floor(Date.now() / 1000), avail!.at + 1));
      if (!(await transport.send(ev).catch(() => false))) return { ok: false, reason: OFFLINE };
      // booking another time after losing a race: withdraw the one that lost, so both can't end up confirmed
      const lost = toWithdraw(saved.bookings.filter((b) => !b.lost).map((b) => ({ ...b, pk: b.ev.pubkey, id: b.ev.id })), view, losers);
      for (const b of lost) void transport.send(sealGuestMsg({ t: 'cancel' }, ref, hexToBytes(b.sk), b.ev.created_at + 1)).catch(() => 0);
      // Held from this moment: the page says "You're booked" at once. If someone else's request turns out to have come
      // first (it shows up within a second or two), the same rule every page and the host's app use marks this one
      // lost, and the watcher above withdraws it.
      const next: Saved = { ...saved, bookings: [...saved.bookings.map((b) => (lost.some((x) => x.id === b.ev.id) ? { ...b, lost: true } : b)), { sk: bytesToHex(sk), ev, start }] };
      save(ref, next);
      setSaved(next);
      setMsgs((m) => new Map(m).set(ev.pubkey, { pk: ev.pubkey, id: ev.id, at: ev.created_at, msg: { t: 'book', start, av } }));
      return { ok: true };
    };
    return <BookView key={view.id} v={shown} mine={myBookings} updatedAt={view.updatedAt} onConfirm={confirm} />;
  }

  // group poll: one answer per guest key, as in the host's results (a name typed twice is two answers)
  const others = latestPerGuest(all)
    .filter((d) => d.msg.t === 'poll' && !minePks.has(d.pk))
    .sort((a, b) => a.at - b.at)
    .map((d) => ({ name: (d.msg as { name: string }).name, cells: (d.msg as { cells: number[] }).cells }));
  const onSave = async (name: string, cells: number[]) => {
    const sk = saved.poll ? hexToBytes(saved.poll.sk) : generateSecretKey();
    const ev = sealGuestMsg({ t: 'poll', name, cells }, ref, sk, Math.max(Math.floor(Date.now() / 1000), (saved.poll?.ev?.created_at ?? 0) + 1, avail!.at + 1));
    if (!(await transport.send(ev).catch(() => false))) return { ok: false, reason: OFFLINE };
    const next = { ...saved, poll: { sk: bytesToHex(sk), ev, name, cells } };
    save(ref, next);
    setSaved(next);
    return { ok: true };
  };
  return <PollView key={view.id} v={withHolds(view, [], minePks, now)} others={others} mine={saved.poll ? { name: saved.poll.name, cells: saved.poll.cells } : null} updatedAt={view.updatedAt} onSave={onSave} />;
}
