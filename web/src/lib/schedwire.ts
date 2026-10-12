// Scheduling links between different people, carried by Nostr relays. Everything here is pure (no network): the
// keys, the link address, what goes in each message, the encryption, and the rules that decide who gets a slot.
// The network side is lib/relays.ts; your app's side is data/schedSync.ts; the guest's side is guest/RemoteGuest.tsx.
//
// The picture:
//   · Each link has its own keypair (host key) and a 32-byte secret. The address you send is
//       https://<guest page>/#<version · host public key · secret>
//     Everything after "#" stays in the guest's browser — it is never sent to GitHub or to any relay.
//   · Your app publishes the link's free/busy (exactly `publicView`, nothing more) as one replaceable event signed by
//     the host key and encrypted with a key derived from the secret. Only people with the link can read it; only
//     your app can write it (the signature).
//   · A guest's booking / poll answer is an event signed by a throwaway key of theirs, encrypted with the link key
//     (so other guests can see the slot is held, and so it proves they had the link). A booking's optional name is
//     sealed a second time, to the host key only.
//   · Relays see: random-looking keys, random-looking tags, ciphertext, and timestamps. Nothing else.
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { openChecker, publicView, type BookingLink, type LinkMode, type PollResponse, type PublicDay, type PublicView } from './booking';
import type { CalEvent } from '../data/types';

export const PROTO = 1; // link-address and message format version
export const KIND = 30078; // NIP-78 "application data": parameterized replaceable, accepted and kept by the big relays
const MIN = 60_000;
const DAY = 86_400_000;
const MAX_CONTENT = 120_000; // characters of ciphertext we're willing to decrypt
export const MAX_NAME = 80;
const MAX_CELLS = 4000;

// ---------------------------------------------------------------- keys and the link address

/** What your app keeps for each link (in its own database; never published). Hex strings. */
export interface LinkKeys {
  sk: string; // the host key (signs the link's availability)
  secret: string; // 32 bytes: the shared link secret
}

/** What a guest gets from the address. */
export interface LinkRef {
  hostPk: string; // hex
  secret: Uint8Array;
}

export function newLinkKeys(): LinkKeys {
  return { sk: bytesToHex(generateSecretKey()), secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) };
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const hostPkOf = (keys: LinkKeys) => getPublicKey(hexToBytes(keys.sk));
export const refOf = (keys: LinkKeys): LinkRef => ({ hostPk: hostPkOf(keys), secret: hexToBytes(keys.secret) });

/** The part after "#": version byte, host public key, secret — 65 bytes, 87 characters. */
export function linkFragment(keys: LinkKeys) {
  const out = new Uint8Array(65);
  out[0] = PROTO;
  out.set(hexToBytes(hostPkOf(keys)), 1);
  out.set(hexToBytes(keys.secret), 33);
  return b64u(out);
}

export const guestUrl = (base: string, keys: LinkKeys) => `${base}#${linkFragment(keys)}`;

/** Read an address's "#…" (with or without the "#"). Null if it's damaged or cut short (a mangled paste). */
export function parseFragment(hash: string): LinkRef | null {
  const s = hash.replace(/^#\/?/, '').trim();
  if (!/^[A-Za-z0-9_-]{87}$/.test(s)) return null;
  try {
    const b = unb64u(s);
    if (b.length !== 65 || b[0] !== PROTO) return null;
    const hostPk = bytesToHex(b.slice(1, 33));
    getPublicKey(b.slice(33)); // throws if it isn't a usable 32-byte value
    return { hostPk, secret: b.slice(33) };
  } catch {
    return null;
  }
}

/** Everything derived from the secret: the encryption key and the two tags relays index the events by. The tags look
 *  random, so nobody without the link can even ask a relay for this link's messages. */
export function derive(secret: Uint8Array) {
  const k = (info: string) => hkdf(sha256, secret, utf8ToBytes('worldline'), utf8ToBytes(info), 32);
  return { key: k('v1/key'), availTag: bytesToHex(k('v1/avail')).slice(0, 32), msgTag: bytesToHex(k('v1/msg')).slice(0, 32) };
}

// ---------------------------------------------------------------- the availability (host → guests)

export type Status = 'ok' | 'taken' | 'busy' | 'closed' | 'invalid' | 'cancelled';

/** A decision your app made about one guest's request (keyed by the guest's key). */
export interface Decision {
  id: string; // the request event's id
  status: Status;
  start: number;
  at?: number; // ms: when your app decided (kept in your database, not published)
}

/** What guests receive: the public view plus what the guest page needs to behave. */
export interface RemoteView extends PublicView {
  noticeMin: number;
  singleUse: boolean;
  updatedAt: number; // ms: when your app last published (shows guests how fresh it is)
  gone: boolean; // the link was deleted
  decisions: Record<string, Decision>;
  /** This version's token: a guest's booking quotes it (with `pubAt`) to show which version they booked against. */
  tok?: string;
  /** created_at (seconds) of the event this view came from (set when it's opened from the relays). */
  pubAt?: number;
}

type WireDay = [number, number[], number[]?];
interface WireAvail {
  v: number;
  mode: LinkMode;
  title: string;
  host: string;
  dur: number;
  loc?: string;
  note?: string;
  cell: number;
  notice?: number;
  single?: 1;
  closed?: 1;
  gone?: 1;
  final?: number; // minutes
  upd: number; // seconds
  days: WireDay[];
  dec?: Record<string, [string, Status, number]>;
  tok?: string;
}

/** Times as whole minutes, each after the first as the step from the one before ("30" over and over) — small enough
 *  that two months of a poll fit comfortably in one message. */
const deltas = (ms: number[]) => ms.map((t, i) => Math.round(t / MIN) - (i ? Math.round(ms[i - 1] / MIN) : 0));
const undeltas = (d: number[]) => {
  let acc = 0;
  return d.map((x) => (acc += x) * MIN);
};

export function toWire(view: PublicView, o: { noticeMin: number; singleUse: boolean; updatedAt: number; decisions?: Record<string, Decision>; gone?: boolean; tok?: string }): WireAvail {
  const dec = Object.fromEntries(Object.entries(o.decisions ?? {}).map(([pk, d]) => [pk, [d.id, d.status, Math.round(d.start / MIN)] as [string, Status, number]]));
  return {
    v: PROTO,
    mode: view.mode,
    title: view.title,
    host: view.hostName,
    dur: view.durationMin,
    ...(view.location ? { loc: view.location } : {}),
    ...(view.note ? { note: view.note } : {}),
    cell: view.cellMin,
    ...(o.noticeMin ? { notice: o.noticeMin } : {}),
    ...(o.singleUse ? { single: 1 as const } : {}),
    ...(view.closed ? { closed: 1 as const } : {}),
    ...(o.gone ? { gone: 1 as const } : {}),
    ...(view.finalStart ? { final: Math.round(view.finalStart / MIN) } : {}),
    upd: Math.floor(o.updatedAt / 1000),
    days: o.gone ? [] : view.days.map((d): WireDay => (d.cells ? [d.day, deltas(d.slots), deltas(d.cells)] : [d.day, deltas(d.slots)])),
    ...(Object.keys(dec).length ? { dec } : {}),
    ...(o.tok ? { tok: o.tok } : {}),
  };
}

const TOK = /^[0-9a-f]{32}$/;
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);
const isIntArr = (x: unknown, max = MAX_CELLS): x is number[] => Array.isArray(x) && x.length <= max && x.every(isInt);
const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : undefined);

/** Parse (and sanity-check) a decrypted availability. Anything malformed → null; extra fields from a newer app are
 *  ignored, so an old guest page never breaks on a newer link (and the page is always the newest anyway). */
export function fromWire(w: unknown, id = ''): RemoteView | null {
  if (!w || typeof w !== 'object') return null;
  const x = w as Partial<WireAvail>;
  if (!isInt(x.v) || x.v < 1 || (x.mode !== 'book' && x.mode !== 'poll') || !isInt(x.dur) || !isInt(x.cell) || !isInt(x.upd) || !Array.isArray(x.days)) return null;
  const days: PublicDay[] = [];
  for (const d of x.days) {
    if (!Array.isArray(d) || !isInt(d[0]) || !isIntArr(d[1])) return null;
    if (d[2] !== undefined && !isIntArr(d[2])) return null;
    days.push({ day: d[0], slots: undeltas(d[1]), ...(d[2] ? { cells: undeltas(d[2]) } : {}) });
  }
  const decisions: Record<string, Decision> = {};
  if (x.dec && typeof x.dec === 'object')
    for (const [pk, v] of Object.entries(x.dec))
      if (/^[0-9a-f]{64}$/.test(pk) && Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string' && isInt(v[2])) decisions[pk] = { id: v[0], status: v[1] as Status, start: v[2] * MIN };
  return {
    id,
    mode: x.mode,
    title: str(x.title, 200) ?? '',
    hostName: str(x.host, MAX_NAME) ?? '',
    durationMin: x.dur,
    location: str(x.loc, 500),
    note: str(x.note, 2000),
    cellMin: x.cell,
    days,
    closed: !!x.closed || !!x.gone,
    finalStart: isInt(x.final) ? x.final * MIN : undefined,
    responses: [],
    noticeMin: isInt(x.notice) ? x.notice : 0,
    singleUse: !!x.single,
    updatedAt: x.upd * 1000,
    gone: !!x.gone,
    decisions,
    ...(typeof x.tok === 'string' && TOK.test(x.tok) ? { tok: x.tok } : {}),
  };
}

const json = (content: string) => {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
};
const tagOf = (ev: Event, name: string) => ev.tags.find((t) => t[0] === name)?.[1];
const decryptWith = (ev: Event, key: Uint8Array) => {
  if (ev.content.length > MAX_CONTENT) return null;
  try {
    return nip44.decrypt(ev.content, key);
  } catch {
    return null; // wrong key (no link), tampered, or not ours
  }
};

/** Each published version carries a token only your app can make (a keyed hash of its created_at under the host
 *  key). A booking quotes the version it was made against — its created_at and token — so your app knows the request
 *  can't be older than that version: a guest can't claim to have asked before they could have seen the times. */
export const availToken = (sk: string, createdAt: number) => bytesToHex(hmac(sha256, hexToBytes(sk), utf8ToBytes(`worldline/v1/avail/${createdAt}`))).slice(0, 32);

/** The signed availability event. `createdAt` (seconds) must keep increasing for relays to keep the newest one — see
 *  `nextCreatedAt`. */
export function sealAvail(view: RemoteView | PublicView, keys: LinkKeys, o: Parameters<typeof toWire>[1], createdAt: number): Event {
  const { key, availTag } = derive(hexToBytes(keys.secret));
  const wire = toWire(view, { ...o, tok: availToken(keys.sk, createdAt) });
  return finalizeEvent({ kind: KIND, created_at: createdAt, tags: [['d', availTag]], content: nip44.encrypt(JSON.stringify(wire), key) }, hexToBytes(keys.sk));
}

/** A guest reads the availability: must be signed by the link's host key, carry the right tag, and decrypt. */
export function openAvail(ev: Event, ref: LinkRef): RemoteView | null {
  const { key, availTag } = derive(ref.secret);
  if (ev.kind !== KIND || ev.pubkey !== ref.hostPk || tagOf(ev, 'd') !== availTag || !verifyEvent(ev)) return null;
  const text = decryptWith(ev, key);
  const view = text === null ? null : fromWire(json(text), ref.hostPk.slice(0, 16));
  return view && { ...view, pubAt: ev.created_at };
}

/** Relays keep the replaceable event with the largest created_at, so each publish must be later than the last one —
 *  even if this Mac's clock was once wrong and has since been set back. */
export const nextCreatedAt = (nowMs: number, last = 0) => Math.max(Math.floor(nowMs / 1000), last + 1);

/** Several relays may hold different versions: the newest valid one wins. */
export function newestAvail(events: Event[], ref: LinkRef): { view: RemoteView; at: number } | null {
  let best: { view: RemoteView; at: number } | null = null;
  for (const ev of events) {
    if (best && ev.created_at <= best.at) continue;
    const view = openAvail(ev, ref);
    if (view) best = { view, at: ev.created_at };
  }
  return best;
}

// ---------------------------------------------------------------- guests' messages (guest → host, readable by link holders)

/** `av` on a booking: the published version it was made against — its created_at (seconds) and token. */
export type BookedAgainst = { at: number; tok: string };
export type GuestMsg = { t: 'book'; start: number; name?: string; av?: BookedAgainst } | { t: 'poll'; name: string; cells: number[] } | { t: 'cancel' };

/** A message as decoded. `name` on a booking is only there for the host (other guests can't open it). */
export interface Decoded {
  pk: string; // the guest's key: one current message per guest per link (replaceable)
  id: string;
  at: number; // created_at, seconds (the guest's clock)
  msg: GuestMsg;
  /** Seconds: when your app first saw it arrive live (after the relays had sent what they'd stored). Unset for a
   *  message read from storage (sent while your app wasn't listening). */
  seen?: number;
}

/** A guest signs a message with their own throwaway key. */
export function sealGuestMsg(msg: GuestMsg, ref: LinkRef, guestSk: Uint8Array, createdAt: number): Event {
  const { key, msgTag } = derive(ref.secret);
  let body: Record<string, unknown>;
  if (msg.t === 'book') {
    const name = msg.name?.trim().slice(0, MAX_NAME);
    // the name is sealed to the host key alone — other guests see that the slot is held, not by whom
    body = {
      v: PROTO, t: 'book', s: Math.round(msg.start / MIN),
      ...(name ? { n: nip44.encrypt(name, nip44.getConversationKey(guestSk, ref.hostPk)) } : {}),
      ...(msg.av ? { a: msg.av.at, k: msg.av.tok } : {}),
    };
  } else if (msg.t === 'poll') body = { v: PROTO, t: 'poll', name: msg.name.trim().slice(0, MAX_NAME), c: msg.cells.slice(0, MAX_CELLS).map((c) => Math.round(c / MIN)) };
  else body = { v: PROTO, t: 'cancel' };
  return finalizeEvent({ kind: KIND, created_at: createdAt, tags: [['d', msgTag]], content: nip44.encrypt(JSON.stringify(body), key) }, guestSk);
}

/** A name a guest typed, as shown and stored: one line, no control characters or text-direction overrides (which
 *  could make a name display as something else), trimmed and capped. */
export const cleanName = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

/** Decode a guest's message with the link (guests and host). With `hostSk`, a booking's sealed name is opened too. */
export function openGuestMsg(ev: Event, ref: LinkRef, hostSk?: Uint8Array): Decoded | null {
  const { key, msgTag } = derive(ref.secret);
  if (ev.kind !== KIND || tagOf(ev, 'd') !== msgTag || ev.pubkey === ref.hostPk || !verifyEvent(ev)) return null;
  const text = decryptWith(ev, key);
  const b = text === null ? null : (json(text) as Record<string, unknown> | null);
  if (!b || typeof b !== 'object' || !isInt(b.v)) return null;
  const base = { pk: ev.pubkey, id: ev.id, at: ev.created_at };
  if (b.t === 'book' && isInt(b.s)) {
    let name: string | undefined;
    if (hostSk && typeof b.n === 'string' && b.n.length < 1000)
      try {
        name = cleanName(nip44.decrypt(b.n, nip44.getConversationKey(hostSk, ev.pubkey))) || undefined;
      } catch {
        /* unreadable name: book without it */
      }
    const av = isInt(b.a) && typeof b.k === 'string' && TOK.test(b.k) ? { at: b.a, tok: b.k } : undefined;
    return { ...base, msg: { t: 'book', start: b.s * MIN, ...(name ? { name } : {}), ...(av ? { av } : {}) } };
  }
  if (b.t === 'poll' && typeof b.name === 'string' && cleanName(b.name) && isIntArr(b.c)) return { ...base, msg: { t: 'poll', name: cleanName(b.name), cells: b.c.map((c) => c * MIN) } };
  if (b.t === 'cancel') return { ...base, msg: { t: 'cancel' } };
  return null;
}

/** Replaceable events: keep only each guest's newest message (relays should do this already; not all do promptly). */
export function latestPerGuest(msgs: Decoded[]): Decoded[] {
  const m = new Map<string, Decoded>();
  for (const d of msgs) {
    const cur = m.get(d.pk);
    if (!cur || d.at > cur.at || (d.at === cur.at && d.id < cur.id)) m.set(d.pk, d);
  }
  return [...m.values()];
}

// ---------------------------------------------------------------- who gets a slot

export interface Hold {
  pk: string;
  id: string;
  at: number;
  start: number;
  end: number;
}

/** How long a refusal stays in what your app publishes after it was made — and, to match, how long an unanswered
 *  request keeps holding a time on other guests' pages after your app last published (so a refusal that has dropped
 *  out can't come back as a hold). */
export const REFUSAL_KEEP = 14 * DAY;
/** Requests for meetings more than this long over are ignored, and your app forgets its answers to them. */
export const KEEP_AFTER = 30 * DAY;
const LIVE_SLACK = 60; // seconds: a request seen live may say it was made up to this much before it arrived (relay delay)

const byArrival = (a: { at: number; id: string }, b: { at: number; id: string }) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** Can a guest's page believe a booking's time? It must quote the version of the times it was made against and can't
 *  be older than that version; when it quotes the very version this page has, the token must match. (A guest page
 *  can't check an older version's token — your app can, and its answer is final.) */
function credible(d: Decoded, view: RemoteView) {
  const av = d.msg.t === 'book' ? d.msg.av : undefined;
  if (!av || d.at < av.at) return false;
  return !(view.pubAt !== undefined && view.tok && av.at === view.pubAt && av.tok !== view.tok);
}

/**
 * Bookings your app hasn't answered yet, as every guest page sees them: the earliest request (then the smaller event
 * id, so everyone breaks a tie the same way) holds a slot; a later overlapping one loses. A request for a time that
 * isn't on offer holds nothing (so junk can't block real times), nor does one whose time can't be believed (see
 * `credible`), nor one made more than REFUSAL_KEEP before your app last published (it was answered long ago). A
 * single-use link: only the first request holds. Your app applies the same rule (plus your calendar, and a check of
 * the clock no guest page can make — `askedAt`), and its published answer is what finally counts.
 */
export function resolveHolds(view: RemoteView, msgs: Decoded[], now: number) {
  const len = view.durationMin * MIN;
  const offered = new Set(view.days.flatMap((d) => d.slots));
  const stale = view.updatedAt - REFUSAL_KEEP;
  const pending = latestPerGuest(msgs)
    .filter((d) => d.msg.t === 'book' && view.decisions[d.pk]?.id !== d.id && credible(d, view) && d.at * 1000 >= stale)
    .map((d) => ({ pk: d.pk, id: d.id, at: d.at, start: (d.msg as { start: number }).start, end: (d.msg as { start: number }).start + len }))
    .filter((h) => h.end > now)
    .sort(byArrival);
  const winners: Hold[] = [];
  const losers: Hold[] = [];
  for (const h of pending) {
    const ok = offered.has(h.start) && !winners.some((w) => overlap(w, h)) && !(view.singleUse && winners.length);
    (ok ? winners : losers).push(h);
  }
  return { winners, losers };
}

/** The guest's view with times other people are holding taken out (their own holds stay, marked as theirs). */
export function withHolds(view: RemoteView, winners: Hold[], mine: Set<string>, now: number): RemoteView {
  const others = winners.filter((w) => !mine.has(w.pk));
  const len = view.durationMin * MIN;
  const earliest = now + view.noticeMin * MIN;
  const closed = view.closed || (view.singleUse && others.length > 0);
  return {
    ...view,
    closed,
    days: view.days
      .map((d) => ({ ...d, slots: d.slots.filter((s) => s >= earliest && !others.some((w) => overlap(w, { start: s, end: s + len }))) }))
      .filter((d) => view.mode === 'poll' || d.slots.length > 0),
  };
}

/** A guest booking a new time: which of this browser's earlier requests to withdraw — ones that lost a race on this
 *  page and that your app hasn't answered. Never done on its own: a request that "lost" to one with a forged early
 *  clock stays in, and your app (which can tell) may still confirm it. */
export function toWithdraw<B extends { pk: string; id: string }>(mine: B[], view: RemoteView, losers: Hold[]): B[] {
  return mine.filter((b) => view.decisions[b.pk]?.id !== b.id && losers.some((h) => h.pk === b.pk && h.id === b.id));
}

// ---------------------------------------------------------------- your app: answer the requests

export interface Accept {
  pk: string;
  id: string;
  start: number;
  name: string;
  at: number;
}

/**
 * When your app takes a booking request to have been made (seconds) — what decides "earliest wins" and the notice.
 *  · It quotes a version of your times with a token that checks out: its own clock is believed, but never earlier than
 *    that version (it can't have asked before it could see the times). Earlier than that: a forged clock → null.
 *  · It doesn't (or the token is wrong): when your app saw it.
 *  · Seen live: never earlier than a minute before it arrived, whatever its clock says.
 *  · Never later than now (a clock set in the future can't dodge the notice).
 */
export function askedAt(d: Decoded, sk: string | undefined, nowSec: number): number | null {
  const av = d.msg.t === 'book' ? d.msg.av : undefined;
  const genuine = !!av && !!sk && av.tok === availToken(sk, av.at);
  if (genuine && d.at < av!.at) return null;
  let t = genuine ? d.at : (d.seen ?? nowSec);
  if (d.seen !== undefined) t = Math.min(Math.max(t, d.seen - LIVE_SLACK), d.seen);
  return Math.min(t, nowSec);
}

/**
 * Your app's answer to new booking requests, in the order they were made (`askedAt`): each is checked against your
 * calendar *now* (so a time that became busy is refused) and against the bookings accepted before it. Notice ("not
 * sooner than 4 h") is judged from when the guest asked, so a request made while the app was closed for days still
 * counts. Requests for meetings more than KEEP_AFTER over are ignored.
 * `events`: your calendar's events around the link's dates (occurrences expanded).
 */
/** The most requests answered in one go (the earliest; any more wait for the next round). */
export const MAX_BATCH = 500;

export function planBookings(link: BookingLink, events: CalEvent[], msgs: Decoded[], now: number) {
  const decided = link.decisions ?? {};
  const len = link.durationMin * MIN;
  const nowSec = Math.floor(now / 1000);
  const fresh = latestPerGuest(msgs)
    .filter((d) => d.msg.t === 'book' && decided[d.pk]?.id !== d.id && d.msg.start + len > now - KEEP_AFTER)
    .map((d) => ({ d, asked: askedAt(d, link.nostr?.sk, nowSec) }))
    .sort((a, b) => byArrival({ at: a.asked ?? 0, id: a.d.id }, { at: b.asked ?? 0, id: b.d.id }));
  const accepts: Accept[] = [];
  const decisions: Record<string, Decision> = {};
  // meetings this link already booked (still on your calendar), then the ones accepted in this batch
  const taken: { start: number; end: number }[] = events.filter((e) => e.bookedVia === link.id).map((e) => ({ start: e.start, end: e.end }));
  let closed = !!link.closed;
  const open = openChecker(link, events); // (the link's times and your busy times, worked out once for the batch)
  for (const { d, asked } of fresh.slice(0, MAX_BATCH)) {
    const start = (d.msg as { start: number }).start;
    let status: Status;
    if (closed) status = 'closed';
    else if (asked === null || !open(start, asked * 1000, false)) status = 'invalid'; // a forged clock, or not a time this link offered then
    else if (taken.some((t) => overlap(t, { start, end: start + len }))) status = 'taken';
    else if (!open(start, asked * 1000)) status = 'busy';
    else status = 'ok';
    decisions[d.pk] = { id: d.id, status, start, at: now };
    if (status !== 'ok' || asked === null) continue;
    accepts.push({ pk: d.pk, id: d.id, start, name: (d.msg as { name?: string }).name ?? '', at: asked });
    taken.push({ start, end: start + len });
    if (link.singleUse) closed = true;
  }
  return { accepts, decisions };
}

/** Poll answers → the link's responses: one per guest key — each guest's newest answer, only cells the poll offers.
 *  Answers are never merged by name: someone typing a name that's already there adds their own answer beside it and
 *  can't replace it; a guest changes their answer from the browser they gave it in (it keeps their key). Worked out
 *  from the whole inbox each time, so the result doesn't depend on the order answers arrived in. */
/** The most answers one poll keeps. */
export const MAX_ANSWERS = 300;

export function mergeResponses(link: BookingLink, msgs: Decoded[], offeredCells: Set<number>): { responses: PollResponse[]; changed: string[] } {
  const prev = new Map(link.responses.map((r) => [r.id, r]));
  const updated = new Map<string, PollResponse>();
  for (const d of latestPerGuest(msgs).sort(byArrival)) {
    if (d.msg.t !== 'poll') continue;
    const p = prev.get(d.pk);
    if (p && p.updatedAt >= d.at * 1000) continue;
    updated.set(d.pk, { id: d.pk, name: d.msg.name, cells: [...new Set(d.msg.cells.filter((c) => offeredCells.has(c)))].sort((a, b) => a - b), updatedAt: d.at * 1000 });
  }
  // at most MAX_ANSWERS (the earliest guests): a flood of made-up answers can't bury the poll or fill your devices
  const kept = new Set(link.responses.map((r) => r.id));
  for (const id of [...updated.keys()]) if (!kept.has(id) && kept.size >= MAX_ANSWERS) updated.delete(id); else kept.add(id);
  return { responses: [...link.responses.filter((r) => !updated.has(r.id)), ...updated.values()], changed: [...updated.values()].map((r) => r.name) };
}

/** Decisions guests still need to see: drop ones for meetings more than two days past (keeps the message small). */
export const liveDecisions = (decisions: Record<string, Decision> | undefined, durationMin: number, now: number) =>
  Object.fromEntries(Object.entries(decisions ?? {}).filter(([, d]) => d.start + durationMin * MIN > now - 2 * 86_400_000));

const refusal = (s: Status) => s !== 'ok' && s !== 'cancelled';
/** Every start time the link's days and hours give, busy or not, whatever the notice. */
const gridOf = (link: BookingLink) => new Set(publicView(link, [], -Infinity).days.flatMap((d) => d.slots));
/** At most `max`: confirmed and cancelled meetings first, then the most recent refusals. */
function capDecisions(dec: Record<string, Decision>, max: number) {
  const e = Object.entries(dec);
  if (e.length <= max) return dec;
  e.sort(([, a], [, b]) => Number(refusal(a.status)) - Number(refusal(b.status)) || (b.at ?? b.start) - (a.at ?? a.start));
  return Object.fromEntries(e.slice(0, max));
}

/** The most answers published at once (each is ~200 characters; the whole message must stay well under 120,000). */
export const MAX_PUBLISHED = 200;

/** What guests are told about each booking: your app's answers, plus "cancelled" for a booked meeting that's no longer
 *  on your calendar (you deleted it, or deleted the link) — so their page stops saying "confirmed". A refusal is
 *  published only for a time the link offers and for REFUSAL_KEEP after it was made, and at most MAX_PUBLISHED
 *  answers go out (confirmed ones first), so a flood of junk requests can't make the message too big to open. */
export function publishedDecisions(link: BookingLink, events: CalEvent[], now: number): Record<string, Decision> {
  const grid = gridOf(link);
  const out: Record<string, Decision> = Object.fromEntries(
    Object.entries(liveDecisions(link.decisions, link.durationMin, now))
      .filter(([, d]) => !refusal(d.status) || (grid.has(d.start) && (d.at ?? d.start) > now - REFUSAL_KEEP))
      .map(([pk, d]) => [pk, { id: d.id, status: d.status, start: d.start }]),
  );
  const onCalendar = new Set(events.map((e) => e.id));
  for (const b of link.bookings)
    if (b.guestKey && b.eventId && b.end > now && !onCalendar.has(b.eventId)) out[b.guestKey] = { id: b.id, status: 'cancelled', start: b.start };
  return capDecisions(out, MAX_PUBLISHED);
}

/** The most answers your app keeps for one link. */
export const MAX_KEPT = 1000;

/** What your app keeps of its answers (`link.decisions`): answers about meetings more than KEEP_AFTER over go (such
 *  old requests are ignored anyway), refusals of times the link never offered go (junk — never published), and at
 *  most MAX_KEPT stay (confirmed ones first). Times count from the newest answer, so this needs no clock. */
export function pruneDecisions(link: BookingLink, decisions: Record<string, Decision>): Record<string, Decision> {
  const now = Math.max(0, ...Object.values(decisions).map((d) => d.at ?? 0));
  const grid = gridOf(link);
  const len = link.durationMin * MIN;
  const kept = Object.fromEntries(Object.entries(decisions).filter(([, d]) => (!now || d.start + len > now - KEEP_AFTER) && (!refusal(d.status) || grid.has(d.start))));
  return capDecisions(kept, MAX_KEPT);
}
