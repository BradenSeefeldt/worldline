import { describe, expect, it } from 'vitest';
import { SnapshotAssembler, deriveSync, newDeviceKey, newSecret, openMessage, pairingCode, parsePairingCode, sealSnapshot, sealUpdate, UPDATE_TTL } from './wire';

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
    expect(new TextDecoder().decode(got!.data)).toBe('Group meeting '.repeat(500));
  });
  it('someone without the secret can’t read or forge; an expired update is ignored', async () => {
    const ev = await sealUpdate(new Uint8Array([1, 2, 3]), keys, dev);
    expect(await openMessage(ev, deriveSync(newSecret()))).toBeNull();
    const other = deriveSync(newSecret());
    const forged = await sealUpdate(new Uint8Array([9]), { key: other.key, tag: keys.tag }, newDeviceKey()); // right tag, wrong key
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
});
