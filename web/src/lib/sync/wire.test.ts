import { describe, expect, it } from 'vitest';
import { KIND, MAX_CONTENT, SnapshotAssembler, deriveSync, newDeviceKey, newSecret, openMessage, pairingCode, parsePairingCode, sealSnapshot, sealUpdate, sealUpdates, UPDATE_TTL } from './wire';

const keys = deriveSync(newSecret());
/** Random bytes that don't compress (the system source gives at most 64 KB per call). */
const noise = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
const dev = newDeviceKey();

describe('pairing code', () => {
  it('round-trips, forgiving spaces and line breaks; rejects anything else', () => {
    const s = newSecret();
    const code = pairingCode(s);
    expect(code).toMatch(/^wlsync1:[A-Za-z0-9_-]{43}$/);
    expect(parsePairingCode(code)).toBe(s);
    expect(parsePairingCode(`  ${code.slice(0, 20)}\n${code.slice(20)} `)).toBe(s);
    expect(parsePairingCode('wlsync1:short')).toBeNull();
    expect(parsePairingCode('https://example.com')).toBeNull();
  });
  it('different groups get different keys and tags', () => {
    const a = deriveSync(newSecret()), b = deriveSync(newSecret());
    expect(a.tag).not.toBe(b.tag);
  });
});

describe('messages', () => {
  it('an update round-trips, compressed and encrypted (relays see neither the data nor the size of the text)', async () => {
    const data = new TextEncoder().encode('Group meeting '.repeat(500));
    const ev = await sealUpdate(data, keys, dev);
    expect(ev.content.length).toBeLessThan(data.length / 3); // compressed
    expect(JSON.stringify(ev)).not.toContain('Group meeting');
    expect(ev.tags.find((t) => t[0] === 'expiration')).toBeTruthy();
    const got = await openMessage(ev, keys);
    expect(got?.kind).toBe('update');
    expect(new TextDecoder().decode((got as { data: Uint8Array }).data)).toBe('Group meeting '.repeat(500));
  });
  it('someone without the secret can’t read or forge; an expired update is ignored', async () => {
    const ev = await sealUpdate(new Uint8Array([1, 2, 3]), keys, dev);
    expect(await openMessage(ev, deriveSync(newSecret()))).toBeNull();
    const other = deriveSync(newSecret());
    const forged = await sealUpdate(new Uint8Array([9]), { ...keys, key: other.key }, newDeviceKey()); // right tag, wrong key
    expect(await openMessage(forged, keys)).toBeNull();
    const old = await sealUpdate(new Uint8Array([1]), keys, dev, Date.now() - (UPDATE_TTL + 60) * 1000);
    expect(await openMessage(old, keys)).toBeNull();
  });
  it('a big snapshot goes out in pieces and comes back whole, in any order', async () => {
    const big = noise(100_000); // random: doesn't compress, so it needs several pieces
    const pieces = await sealSnapshot(big, keys, dev);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.every((p) => p.content.length < 65_000)).toBe(true);
    const asm = new SnapshotAssembler();
    let whole: Uint8Array | null = null;
    for (const p of [...pieces].reverse()) {
      const o = await openMessage(p, keys);
      if (o?.kind === 'piece') whole = (await asm.add(o)) ?? whole;
    }
    expect(whole).toEqual(big);
  });
  it('pieces from an older snapshot never mix into a newer one', async () => {
    const asm = new SnapshotAssembler();
    const a = await sealSnapshot(noise(80_000), keys, dev);
    const b = await sealSnapshot(noise(80_000), keys, dev);
    const oa = await openMessage(a[0], keys), ob = await openMessage(b[1], keys);
    expect(await asm.add(oa as never)).toBeNull();
    expect(await asm.add(ob as never)).toBeNull(); // different snapshot ids: no whole snapshot yet
  });
  it('a small update is one message; a big one goes out in pieces, each under the size limit, that come back whole', async () => {
    expect(await sealUpdates(new Uint8Array([1, 2, 3]), keys, dev)).toHaveLength(1);
    const big = noise(300_000);
    const pieces = await sealUpdates(big, keys, dev);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.content.length < MAX_CONTENT)).toBe(true);
    expect(pieces.every((p) => p.tags.some((t) => t[0] === 'expiration'))).toBe(true); // kept 30 days, like any update
    expect(new Set(pieces.map((p) => p.tags.find((t) => t[0] === 'd')![1])).size).toBe(pieces.length); // never replace each other
    const asm = new SnapshotAssembler();
    let whole: Uint8Array | null = null;
    for (const p of pieces) {
      const o = await openMessage(p, keys);
      if (o?.kind === 'piece') whole = (await asm.add(o)) ?? whole;
    }
    expect(whole).toEqual(big);
  });
  it('snapshot pieces carry a second tag, so they can be asked for on their own', async () => {
    const [p] = await sealSnapshot(noise(1000), keys, dev);
    expect(p.tags.filter((t) => t[0] === 't').map((t) => t[1])).toEqual([keys.tag, keys.snapTag]);
    expect(keys.snapTag).not.toBe(keys.tag);
  });
  it('a message from a newer Worldline is recognised as such (not read)', async () => {
    const { finalizeEvent } = await import('nostr-tools/pure');
    const nip44 = await import('nostr-tools/nip44');
    const { hexToBytes } = await import('@noble/hashes/utils.js');
    const content = nip44.encrypt(JSON.stringify({ v: 2, x: 'something new' }), keys.key);
    const ev = finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'x'], ['t', keys.tag]], content }, hexToBytes(dev));
    expect((await openMessage(ev, keys))?.kind).toBe('newer');
  });
});

describe('older Macs and iPhones (no CompressionStream: Safari before 16.4)', () => {
  it('compress with fflate in the same format — each side reads the other’s messages', async () => {
    const data = new TextEncoder().encode('Thesis writing '.repeat(400));
    const modern = await sealUpdate(data, keys, dev);
    const saved = { C: globalThis.CompressionStream, D: globalThis.DecompressionStream };
    try {
      Object.assign(globalThis, { CompressionStream: undefined, DecompressionStream: undefined });
      const old = await sealUpdate(data, keys, dev);
      expect(old.content.length).toBeLessThan(data.length / 3);
      expect(new TextDecoder().decode(((await openMessage(modern, keys)) as { data: Uint8Array }).data)).toBe('Thesis writing '.repeat(400));
      Object.assign(globalThis, { CompressionStream: saved.C, DecompressionStream: saved.D });
      expect(new TextDecoder().decode(((await openMessage(old, keys)) as { data: Uint8Array }).data)).toBe('Thesis writing '.repeat(400));
    } finally {
      Object.assign(globalThis, { CompressionStream: saved.C, DecompressionStream: saved.D });
    }
  });
});

describe('unpacking', () => {
  it('a message that unpacks to more than MAX_UNPACKED is ignored, not unpacked', async () => {
    const { MAX_UNPACKED, sealUpdate, openMessage, deriveSync, newSecret, newDeviceKey } = await import('./wire');
    const keys = deriveSync(newSecret());
    const ev = await sealUpdate(new Uint8Array(MAX_UNPACKED + 1), keys, newDeviceKey());
    expect(ev.content.length).toBeLessThan(200_000);
    expect(await openMessage(ev, keys)).toBeNull();
    const ok = await sealUpdate(new Uint8Array(1_000_000), keys, newDeviceKey());
    expect((await openMessage(ok, keys))?.kind).toBe('update');
  });
});
