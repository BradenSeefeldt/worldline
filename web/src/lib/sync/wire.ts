// Sync, part 2: what goes over the relays — pure functions, no network.
//
// A sync group is one 32-byte secret, shared by pairing (a QR code / a code to paste). From it come the encryption
// key and a random-looking tag the relays index messages by. Each device signs with its own throwaway key; only
// someone with the secret can make a message that decrypts, so relays (and anyone else) see ciphertext only.
//   · an update: one batch of changes (small), kept by relays for 30 days (an expiration tag)
//   · a snapshot: a device's whole document, in pieces (relays limit message size), replaced each time it's
//     republished — so a device that was off for months still catches up from snapshots + recent updates.
import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const KIND = 30078;
const PREFIX = 'wlsync1:';
const CHUNK = 24_000; // raw bytes per piece: base64 twice (inside, then the encryption) makes ~43 KB, under relays’ size limits
export const UPDATE_TTL = 30 * 86_400; // seconds an update is kept (a snapshot covers anything older)
const MAX_CONTENT = 100_000;

/** The message format. A message from a newer format is not read; the app says to update instead. */
export const WIRE_VERSION = 1;

export interface SyncKeys {
  key: Uint8Array; // encryption key
  tag: string; // what relays index this group's messages by
  snapTag: string; // a second tag on snapshot pieces only, so they can be asked for on their own
}

export const newSecret = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
export const newDeviceKey = () => bytesToHex(generateSecretKey());

export function deriveSync(secretHex: string): SyncKeys {
  const s = hexToBytes(secretHex);
  const k = (info: string) => hkdf(sha256, s, utf8ToBytes('worldline-sync'), utf8ToBytes(info), 32);
  return { key: k('v1/key'), tag: bytesToHex(k('v1/tag')).slice(0, 32), snapTag: bytesToHex(k('v1/snap')).slice(0, 32) };
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The code another device needs to join: "wlsync1:" + the secret. Shown as a QR code and as text to paste. */
export const pairingCode = (secretHex: string) => PREFIX + b64u(hexToBytes(secretHex));
/** Read a pasted / scanned code (spaces and line breaks forgiven). Null if it isn't one. */
export function parsePairingCode(text: string): string | null {
  const t = text.replace(/\s+/g, '');
  const i = t.indexOf(PREFIX);
  if (i < 0) return null;
  try {
    const b = unb64u(t.slice(i + PREFIX.length, i + PREFIX.length + 43));
    return b.length === 32 ? bytesToHex(b) : null;
  } catch {
    return null;
  }
}

// ---- compression (Yjs documents are mostly text: they shrink a lot). The browser's own CompressionStream where it
// has one (Safari 16.4+ / macOS 13.4+ / iOS 16.4+); older ones use fflate, which writes the same format (raw deflate).
const native = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
async function squash(data: Uint8Array): Promise<Uint8Array> {
  if (!native()) return (await import('fflate')).deflateSync(data);
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function unsquash(data: Uint8Array): Promise<Uint8Array> {
  if (!native()) return (await import('fflate')).inflateSync(data);
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const tagOf = (ev: Event, name: string) => ev.tags.find((t) => t[0] === name)?.[1];
const rand = () => bytesToHex(crypto.getRandomValues(new Uint8Array(8)));

/** One batch of changes, as a signed, encrypted message. */
export async function sealUpdate(update: Uint8Array, keys: SyncKeys, deviceSk: string, now = Date.now()): Promise<Event> {
  const t = Math.floor(now / 1000);
  const content = nip44.encrypt(JSON.stringify({ v: WIRE_VERSION, u: b64(await squash(update)) }), keys.key);
  return finalizeEvent({ kind: KIND, created_at: t, tags: [['d', `${keys.tag}:u:${rand()}`], ['t', keys.tag], ['expiration', String(t + UPDATE_TTL)]], content }, hexToBytes(deviceSk));
}

/** A device's whole document, as signed, encrypted pieces (each replaces the same piece from last time). */
export async function sealSnapshot(state: Uint8Array, keys: SyncKeys, deviceSk: string, now = Date.now()): Promise<Event[]> {
  const t = Math.floor(now / 1000);
  const packed = await squash(state);
  const id = rand();
  const n = Math.max(1, Math.ceil(packed.length / CHUNK));
  return Array.from({ length: n }, (_, i) => {
    const content = nip44.encrypt(JSON.stringify({ v: WIRE_VERSION, s: id, i, n, c: b64(packed.subarray(i * CHUNK, (i + 1) * CHUNK)) }), keys.key);
    return finalizeEvent({ kind: KIND, created_at: t, tags: [['d', `${keys.tag}:s:${i}`], ['t', keys.tag], ['t', keys.snapTag]], content }, hexToBytes(deviceSk));
  });
}

export type Opened =
  | { kind: 'update'; device: string; at: number; data: Uint8Array }
  | { kind: 'piece'; device: string; at: number; snap: string; i: number; n: number; data: Uint8Array }
  | { kind: 'newer'; device: string; at: number }; // from a newer Worldline, in a format this one can't read

/** Open a message: must carry this group's tag, be signed, and decrypt with the group key. Anything else → null. */
export async function openMessage(ev: Event, keys: SyncKeys, now = Date.now()): Promise<Opened | null> {
  if (ev.kind !== KIND || tagOf(ev, 't') !== keys.tag || ev.content.length > MAX_CONTENT || !verifyEvent(ev)) return null;
  const exp = Number(tagOf(ev, 'expiration'));
  if (exp && exp * 1000 < now) return null; // expired (a relay that ignores expiration still served it)
  let body: { v?: number; u?: string; s?: string; i?: number; n?: number; c?: string };
  try {
    body = JSON.parse(nip44.decrypt(ev.content, keys.key));
  } catch {
    return null;
  }
  if (typeof body?.v === 'number' && body.v > WIRE_VERSION) return { kind: 'newer', device: ev.pubkey, at: ev.created_at };
  try {
    if (typeof body.u === 'string') return { kind: 'update', device: ev.pubkey, at: ev.created_at, data: await unsquash(unb64(body.u)) };
    if (typeof body.s === 'string' && typeof body.c === 'string' && Number.isInteger(body.i) && Number.isInteger(body.n) && body.n! > 0 && body.n! <= 400 && body.i! < body.n!)
      return { kind: 'piece', device: ev.pubkey, at: ev.created_at, snap: body.s, i: body.i!, n: body.n!, data: unb64(body.c) };
  } catch {
    return null;
  }
  return null;
}

/** Collects snapshot pieces; hands back a device's whole snapshot once every piece of it has arrived. */
export class SnapshotAssembler {
  private parts = new Map<string, { n: number; at: number; pieces: (Uint8Array | undefined)[] }>();
  private done = new Set<string>();
  async add(p: Extract<Opened, { kind: 'piece' }>): Promise<Uint8Array | null> {
    const key = `${p.device}:${p.snap}`;
    if (this.done.has(key)) return null;
    const cur = this.parts.get(key) ?? { n: p.n, at: p.at, pieces: Array.from({ length: p.n }, () => undefined as Uint8Array | undefined) }; // filled, not holes (.some skips holes)
    if (cur.n !== p.n) return null;
    cur.pieces[p.i] = p.data;
    this.parts.set(key, cur);
    if (cur.pieces.some((x) => !x)) return null;
    this.parts.delete(key);
    this.done.add(key);
    const all = new Uint8Array(cur.pieces.reduce((s, x) => s + x!.length, 0));
    let o = 0;
    for (const x of cur.pieces) {
      all.set(x!, o);
      o += x!.length;
    }
    return unsquash(all);
  }
}
