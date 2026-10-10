import { describe, expect, it } from 'vitest';
import published from '../../public/relays.json';
import { BUILTIN, TARGET, guestRelays, parseRelayList, planRelayList, type Probe, type RelayList } from './relaylist';

const R = (n: number) => `wss://r${n}.example.com`;
const list = (extra: Partial<RelayList> = {}): RelayList => ({ updated: '2026-10-01', relays: [1, 2, 3, 4, 5, 6, 7].map(R), retired: [], candidates: [8, 9, 10].map(R), ...extra });
const results = (fail: number[], ms: Record<number, number> = {}) =>
  Object.fromEntries(Array.from({ length: 12 }, (_, i) => i + 1).map((n) => [R(n), { ok: !fail.includes(n), ms: ms[n] ?? 1000 } as Probe]));

describe('the published list', () => {
  it('relays.json is valid, has the target number in use, and matches what is built in', () => {
    const file = parseRelayList(published)!;
    expect(file).not.toBeNull();
    expect(file.relays).toHaveLength(TARGET);
    expect(file.relays).toEqual(BUILTIN); // ship the code with the same list the file has
    expect(file.relays.some((u) => file.candidates.includes(u))).toBe(false);
  });
  it('a damaged or hostile list is refused (the app keeps what it had)', () => {
    expect(parseRelayList(null)).toBeNull();
    expect(parseRelayList({ relays: ['wss://only.one'] })).toBeNull();
    expect(parseRelayList({ relays: ['https://not-a-relay.com', 'javascript:alert(1)', 'ws://insecure.com'] })).toBeNull();
    expect(parseRelayList({ relays: [R(1), R(2), 'nonsense'] })!.relays).toEqual([R(1), R(2)]);
  });
});

describe('the guest page talks to current + recently retired relays', () => {
  it('so an app still on the old list reaches guests', () => {
    const l = list({ retired: [{ url: R(20), since: '2026-06-01' }, { url: R(21), since: '2025-01-01' }] });
    const g = guestRelays(l, '2026-10-10');
    expect(g.slice(0, 7)).toEqual(l.relays);
    expect(g).toContain(R(20));
    expect(g).not.toContain(R(21)); // retired more than a year ago
    expect(g.length).toBeLessThanOrEqual(12);
  });
  it('with no list at all it still has the built-in relays', () => {
    expect(guestRelays(null, '2026-10-10')).toEqual(BUILTIN);
  });
});

describe('the weekly check’s decision', () => {
  it('all working: no change', () => {
    const l = list();
    const p = planRelayList(l, results([]), '2026-10-10');
    expect(p.list).toBe(l); // unchanged
    expect(p.added).toEqual([]);
    expect(p.trouble).toBeNull();
  });
  it('a failing relay is swapped for the fastest working candidate, and retired (not forgotten)', () => {
    const p = planRelayList(list(), results([3, 8], { 9: 3000, 10: 500 }), '2026-10-10');
    expect(p.removed).toEqual([R(3)]);
    expect(p.added).toEqual([R(10)]);
    expect(p.list.relays).toEqual([1, 2, 4, 5, 6, 7, 10].map(R));
    expect(p.list.retired).toEqual([{ url: R(3), since: '2026-10-10' }]);
    expect(p.list.candidates).toEqual([R(8), R(9), R(3)]); // may come back later
    expect(p.list.updated).toBe('2026-10-10');
  });
  it('a retired relay that is re-added leaves the retired list', () => {
    const l = list({ relays: [1, 2, 4, 5, 6, 7].map(R), retired: [{ url: R(3), since: '2026-09-01' }], candidates: [R(3)] });
    const p = planRelayList(l, results([]), '2026-10-10');
    expect(p.added).toEqual([R(3)]);
    expect(p.list.retired).toEqual([]);
  });
  it('if almost nothing passes, the check is what’s broken: change nothing', () => {
    const p = planRelayList(list(), results([1, 2, 3, 4, 5, 6, 7, 8, 9]), '2026-10-10');
    expect(p.list.relays).toEqual(list().relays);
    expect(p.trouble).toMatch(/check is probably broken/);
  });
  it('running out of candidates is flagged', () => {
    const p = planRelayList(list({ candidates: [] }), results([1, 2, 3]), '2026-10-10');
    expect(p.list.relays).toHaveLength(4);
    expect(p.trouble).toMatch(/add candidates/);
  });
});
