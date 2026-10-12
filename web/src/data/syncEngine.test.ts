// Sync end to end: this app (the real store + engine) and a second device (a phone, simulated with the same document
// and message code), talking through an in-memory relay.
import { leaks } from '../lib/leaks';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Event } from 'nostr-tools/pure';
import { memoryTransport } from '../lib/relays';
import { KIND, SnapshotAssembler, deriveSync, newDeviceKey, newSecret, openMessage, sealUpdate } from '../lib/sync/wire';
import { pick, readDoc, writeLocal, type Synced } from '../lib/sync/model';

const mem = new Map<string, string>();
let failAppSaves = false;
const localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (failAppSaves && k === 'calendar-v1') throw new Error('disk full');
    mem.set(k, v);
  },
  removeItem: (k: string) => void mem.delete(k) };
const noop = () => {};
Object.assign(globalThis, {
  localStorage,
  window: { innerWidth: 1200, localStorage, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) },
  document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
});
let useStore: typeof import('./store').useStore;
let startEngine: typeof import('./syncEngine').startEngine;
let catchUpFrom: typeof import('./syncEngine').catchUpFrom;
let readConfig: typeof import('./syncEngine').readConfig;
let resumeSync: typeof import('./syncEngine').resumeSync;
let replaceSaved: typeof import('./persist').replaceSaved;
beforeAll(async () => {
  ({ useStore } = await import('./store'));
  ({ startEngine, catchUpFrom, readConfig, resumeSync } = await import('./syncEngine'));
  ({ replaceSaved } = await import('./persist'));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const relay = memoryTransport();
const secret = newSecret();
const keys = deriveSync(secret);
const relayDefault = relay, keysDefault = keys;

/** The phone: a document fed from the relay's messages, and a way to make an edit and send it. */
function phone(relay: ReturnType<typeof memoryTransport> = relayDefault, keys = keysDefault) {
  const doc = new Y.Doc();
  const asm = new SnapshotAssembler();
  const device = newDeviceKey();
  const seen = new Set<string>();
  return {
    doc,
    async pull() {
      for (const ev of await relay.query({ kinds: [KIND], '#t': [keys.tag] })) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        const m = await openMessage(ev as Event, keys);
        if (m?.kind === 'update') Y.applyUpdate(doc, m.data, 'remote');
        else if (m?.kind === 'piece') {
          const whole = await asm.add(m);
          if (whole) Y.applyUpdate(doc, whole, 'remote');
        }
      }
      return readDoc(doc) as Synced;
    },
    async edit(change: (s: Synced) => Synced) {
      const before = readDoc(doc) as Synced;
      const updates: Uint8Array[] = [];
      const on = (u: Uint8Array, origin: unknown) => origin === 'phone' && updates.push(u);
      doc.on('update', on);
      writeLocal(doc, before, change(before), 'phone');
      doc.off('update', on);
      await relay.publish(await sealUpdate(Y.mergeUpdates(updates), keys, device));
    },
  };
}

const ev = (id: string, title: string, extra = {}) => ({ id, calendarId: 'personal', title, start: Date.UTC(2026, 9, 20, 15), end: Date.UTC(2026, 9, 20, 16), allDay: false, ...extra });

describe('syncing between this app and a phone', () => {
  const p = phone();
  let engine: ReturnType<typeof startEngine>;

  it('turning sync on publishes this device’s data; the phone gets all of it', async () => {
    const st = useStore.getState();
    st.startFresh();
    useStore.setState({ events: [ev('e1', 'Group meeting')], myName: 'Sam' });
    engine = startEngine({ secret, device: newDeviceKey() }, relay, 'create');
    await sleep(900); // the first snapshot goes out ~0.5 s after turning on
    const got = await p.pull();
    expect(got.events.map((e) => e.title)).toEqual(['Group meeting']);
    expect(got.myName).toBe('Sam');
    expect(got.calendars.length).toBeGreaterThan(0);
  });

  it('an event added on the phone appears here', async () => {
    await p.edit((s) => ({ ...s, events: [...s.events, ev('e2', 'Dentist')] }));
    await sleep(300);
    expect(useStore.getState().events.map((e) => e.title).sort()).toEqual(['Dentist', 'Group meeting']);
    expect(useStore.getState().sync.state).toBe('synced');
  });

  it('an edit here reaches the phone', async () => {
    useStore.getState().updateEvent('e1', { title: 'Group meeting (room 1203)' });
    await engine.flush();
    const got = await p.pull();
    expect(got.events.find((e) => e.id === 'e1')?.title).toBe('Group meeting (room 1203)');
  });

  it('both edit the same event offline — different fields: both edits survive on both devices', async () => {
    useStore.getState().updateEvent('e2', { title: 'Dentist (Dr. Lee)' });
    await p.edit((s) => ({ ...s, events: s.events.map((e) => (e.id === 'e2' ? { ...e, location: 'Bloor St' } : e)) }));
    await engine.flush();
    await sleep(300);
    const here = useStore.getState().events.find((e) => e.id === 'e2')!;
    const there = (await p.pull()).events.find((e) => e.id === 'e2')!;
    expect(here).toMatchObject({ title: 'Dentist (Dr. Lee)', location: 'Bloor St' });
    expect(there).toMatchObject({ title: 'Dentist (Dr. Lee)', location: 'Bloor St' });
  });

  it('undoing your own last edit doesn’t undo what the phone did meanwhile', async () => {
    const st = useStore.getState();
    st.updateEvent('e1', { title: 'Mine, to undo' });
    await p.edit((s) => ({ ...s, events: [...s.events, ev('e3', 'From the phone')] }));
    await sleep(300);
    useStore.getState().undo();
    const titles = useStore.getState().events.map((e) => e.title);
    expect(titles).toContain('From the phone');
    expect(titles).not.toContain('Mine, to undo');
  });

  it('a deletion on the phone removes it here', async () => {
    await p.edit((s) => ({ ...s, events: s.events.filter((e) => e.id !== 'e3') }));
    await sleep(300);
    expect(useStore.getState().events.some((e) => e.id === 'e3')).toBe(false);
  });

  it('a new device joining gets the group’s data in place of its own', async () => {
    engine.stop();
    // this app becomes a brand-new device with its own unrelated data, then joins
    useStore.setState({ events: [ev('junk', 'Not mine')], myName: 'Someone else' });
    const joined = startEngine({ secret, device: newDeviceKey() }, relay, 'join');
    await sleep(400);
    const s = useStore.getState();
    expect(s.events.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(s.myName).toBe('Sam');
    expect(pick(s as unknown as Record<string, unknown>).events.some((e) => e.id === 'junk')).toBe(false);
    joined.stop();
  });

  it('nothing on the relay is readable without the secret', () => {
    const all = JSON.stringify(relay.events);
    for (const word of ['Dentist', 'Group meeting', 'Sam', 'Bloor']) expect(leaks(all, word)).toBe(false);
  });
});

describe('catching up after being away', () => {
  const DAY = 86_400_000, now = Date.UTC(2026, 9, 11);
  const cfg = { secret, device: newDeviceKey() };
  it('recently synced: asks only for what’s new (less a day, for clocks that disagree)', () => {
    expect(catchUpFrom({ ...cfg, seenAt: now - 2 * DAY, fullAt: now - 3 * DAY }, 'resume', now)).toBe((now - 3 * DAY) / 1000);
  });
  it('everything: when joining or starting, never caught up, 25+ days away, no full catch-up for a week, or a clock gone wrong', () => {
    expect(catchUpFrom({ ...cfg, seenAt: now - DAY, fullAt: now - DAY }, 'join', now)).toBeUndefined();
    expect(catchUpFrom({ ...cfg, seenAt: now - DAY, fullAt: now - DAY }, 'create', now)).toBeUndefined();
    expect(catchUpFrom(cfg, 'resume', now)).toBeUndefined();
    expect(catchUpFrom({ ...cfg, seenAt: now - 26 * DAY, fullAt: now - 26 * DAY }, 'resume', now)).toBeUndefined();
    expect(catchUpFrom({ ...cfg, seenAt: now - DAY, fullAt: now - 8 * DAY }, 'resume', now)).toBeUndefined();
    expect(catchUpFrom({ ...cfg, seenAt: now + 5 * DAY, fullAt: now - DAY }, 'resume', now)).toBeUndefined();
  });
  it('a resumed device subscribes with "since"; a joining one asks for everything, snapshots on their own too', async () => {
    const filters: Record<string, unknown>[] = [];
    const spy = { ...memoryTransport(), subscribe: (f: Record<string, unknown>) => (filters.push(f), () => {}) } as unknown as Parameters<typeof startEngine>[1];
    const seenAt = Date.now() - 86_400_000;
    const e1 = startEngine({ secret, device: newDeviceKey(), seenAt, fullAt: seenAt }, spy, 'resume');
    await sleep(50);
    expect(filters).toEqual([{ kinds: [KIND], '#t': [keys.tag], since: Math.floor((seenAt - 86_400_000) / 1000) }]);
    e1.stop();
    filters.length = 0;
    const e2 = startEngine({ secret, device: newDeviceKey() }, spy, 'join');
    await sleep(50);
    expect(filters).toEqual([{ kinds: [KIND], '#t': [keys.tag] }, { kinds: [KIND], '#t': [keys.snapTag] }]);
    e2.stop();
  });
});

describe('a device running a newer Worldline', () => {
  it('data in a newer format pauses sync here: nothing is applied or sent, and the app says to update', async () => {
    const r = memoryTransport();
    useStore.getState().startFresh();
    useStore.setState({ events: [ev('mine', 'Mine')] });
    const e = startEngine({ secret: newSecret(), device: newDeviceKey() }, r, 'create');
    await e.flush();
    const sent = r.events.length;
    // a newer device's update: a record in a new shape and a newer format number
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(e.doc));
    const updates: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => updates.push(u));
    other.transact(() => {
      other.getMap('meta').set('schema', 99);
      const rec = new Y.Map();
      other.getMap('events').set('future', rec);
      rec.set('title', 'New shape');
    });
    Y.applyUpdate(e.doc, Y.mergeUpdates(updates), 'remote');
    await sleep(250);
    expect(useStore.getState().sync.state).toBe('update-needed');
    expect(useStore.getState().events.some((x) => x.id === 'future')).toBe(false);
    useStore.getState().updateEvent('mine', { title: 'Edited while paused' });
    await e.flush();
    expect(r.events.length).toBe(sent);
    e.stop();
  });
});

describe('saving the document on this device', () => {
  it('waits for the app’s own data to be saved: while that fails, the document on disk stays as it was', async () => {
    const r = memoryTransport();
    useStore.getState().startFresh();
    const e = startEngine({ secret: newSecret(), device: newDeviceKey() }, r, 'create');
    await e.flush();
    const onDisk = () => `${mem.get('worldline-sync-doc')}|${mem.get('worldline-sync-doc-log') ?? ''}`; // (the document + its log)
    const before = onDisk();
    expect(mem.get('worldline-sync-doc')).toBeTruthy();
    failAppSaves = true;
    try {
      useStore.setState({ events: [ev('unsaved', 'Not saved yet')] });
      await e.flush();
      expect(onDisk()).toBe(before);
    } finally {
      failAppSaves = false;
    }
    await e.flush();
    expect(onDisk()).not.toBe(before);
    e.stop();
  });
});

describe('the catch-up point', () => {
  const old = Date.now() - 86_400_000;
  const run = async (down: boolean) => {
    const r = memoryTransport({ down });
    mem.delete('worldline-sync');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const e = startEngine({ secret: newSecret(), device: newDeviceKey(), seenAt: old, fullAt: old }, r, 'resume');
      await vi.advanceTimersByTimeAsync(15_000);
      e.stop();
    } finally {
      vi.useRealTimers();
    }
    const saved = mem.get('worldline-sync');
    return saved ? (JSON.parse(saved).seenAt as number) : undefined;
  };
  it('moves on once a connected relay has sent what it had stored', async () => {
    expect(await run(false)).toBeGreaterThan(Date.now() - 60_000);
  });
  it('stays put when no relay answered (opened offline): asking again later asks from the old point', async () => {
    expect((await run(true)) ?? old).toBe(old); // (the config may be saved for other reasons: with the old point)
  });
});

/** A sync group in its own relay: this app starts it with `events`, and a phone has caught up with it. */
async function group(events: ReturnType<typeof ev>[], extra: Record<string, unknown> = {}) {
  const r = memoryTransport(), s = newSecret(), k = deriveSync(s);
  useStore.getState().startFresh();
  useStore.setState({ events, ...extra });
  const e = startEngine({ secret: s, device: newDeviceKey() }, r, 'create');
  await sleep(900);
  const p = phone(r, k);
  await p.pull();
  return { r, s, k, e, p };
}

describe('a change here while another device’s change waits to be shown (~150 ms)', () => {
  it('keeps the phone’s delete and retitle; only the field edited here is added, on both devices', async () => {
    const g = await group([ev('e1', 'One'), ev('e2', 'Two'), ev('e3', 'Three')]);
    await g.p.edit((s) => ({ ...s, events: s.events.filter((x) => x.id !== 'e1').map((x) => (x.id === 'e2' ? { ...x, title: 'Two (phone)' } : x)) }));
    await sleep(20); // in the document here, not yet shown
    useStore.getState().updateEvent('e2', { location: 'Room 5' });
    await sleep(400);
    await g.e.flush();
    for (const list of [(await g.p.pull()).events, useStore.getState().events]) {
      expect(list.map((x) => x.id).sort()).toEqual(['e2', 'e3']);
      expect(list.find((x) => x.id === 'e2')).toMatchObject({ title: 'Two (phone)', location: 'Room 5' });
    }
    g.e.stop();
  });
});

describe('replacing this device’s data (start over, a restore, erase everything)', () => {
  it('is never sent to the group as deletions: sync stops, and this device then takes the group’s data again', async () => {
    const g = await group([ev('e1', 'One'), ev('e2', 'Two')]);
    await g.e.flush();
    expect((await readConfig())?.secret).toBe(g.s);
    useStore.getState().startFresh(); // Erase everything, with sync running
    await sleep(50);
    expect(useStore.getState().sync.on).toBe(false);
    const cfg = (await readConfig())!;
    expect(cfg.joining).toBe(true);
    expect(mem.has('worldline-sync-doc')).toBe(false);
    const e = startEngine(cfg, g.r, 'resume'); // the next launch
    await sleep(400);
    await e.flush();
    expect((await g.p.pull()).events.map((x) => x.id).sort()).toEqual(['e1', 'e2']);
    expect(useStore.getState().events.map((x) => x.id).sort()).toEqual(['e1', 'e2']);
    expect((await readConfig())?.joining).toBeFalsy();
    e.stop();
  });
  it('restoring a snapshot or a backup does the same', async () => {
    const g = await group([ev('e1', 'One'), ev('e2', 'Two')]);
    await g.e.flush();
    await replaceSaved('calendar-v1', JSON.stringify({ state: { events: [] }, version: 0 }));
    expect(useStore.getState().sync.on).toBe(false); // (the app reloads next)
    expect((await readConfig())?.joining).toBe(true);
    expect(mem.has('worldline-sync-doc')).toBe(false);
  });
});

describe('joining, interrupted', () => {
  it('offline (or closed) before the group’s data arrived: the next launch carries on joining, sending nothing of this device’s', async () => {
    const g = await group([ev('m1', 'Mac one'), ev('m2', 'Mac two')], { myName: 'Sam' });
    await g.e.flush();
    g.e.stop();
    useStore.setState({ events: [ev('junk', 'Phone junk')], myName: 'Phone default' });
    mem.delete('worldline-sync-doc');
    const cfg = { secret: g.s, device: newDeviceKey(), joining: true };
    const offline = startEngine(cfg, memoryTransport({ down: true }), 'join');
    await sleep(100);
    offline.stop();
    const e = startEngine(cfg, g.r, 'resume');
    await sleep(400);
    await e.flush();
    const there = await g.p.pull();
    expect(there.events.map((x) => x.id).sort()).toEqual(['m1', 'm2']);
    expect(there.myName).toBe('Sam');
    expect(useStore.getState().events.map((x) => x.id).sort()).toEqual(['m1', 'm2']);
    expect((await readConfig())?.secret).toBe(g.s);
    expect((await readConfig())?.joining).toBeFalsy();
    e.stop();
  });
  it('closed after the group’s data arrived but before it was saved: what the others changed meanwhile isn’t undone', async () => {
    const g = await group([ev('m1', 'Mac one'), ev('m2', 'Mac two')]);
    await g.e.flush();
    g.e.stop();
    useStore.setState({ events: [ev('junk', 'Phone junk')] });
    mem.delete('worldline-sync-doc');
    const cfg = { secret: g.s, device: newDeviceKey(), joining: true };
    failAppSaves = true; // nothing gets saved before the app is closed
    try {
      const j = startEngine(cfg, g.r, 'join');
      await sleep(400);
      expect(useStore.getState().events.map((x) => x.id).sort()).toEqual(['m1', 'm2']);
      j.stop();
    } finally {
      failAppSaves = false;
    }
    expect(cfg.joining).toBe(true);
    await g.p.edit((s) => ({ ...s, events: s.events.filter((x) => x.id !== 'm1').map((x) => (x.id === 'm2' ? { ...x, title: 'Mac two (renamed)' } : x)) }));
    const e = startEngine(cfg, g.r, 'resume');
    await sleep(400);
    await e.flush();
    for (const list of [(await g.p.pull()).events, useStore.getState().events]) expect(list.map((x) => `${x.id}:${x.title}`)).toEqual(['m2:Mac two (renamed)']);
    e.stop();
  });
});

describe('sending', () => {
  it('a big change (an import) goes out in pieces under the relays’ size limit; the phone gets all of it', async () => {
    const g = await group([ev('e1', 'One')]);
    const many = Array.from({ length: 3000 }, (_, i) => ev(`imp${i}`, crypto.randomUUID()));
    useStore.setState({ events: [...useStore.getState().events, ...many] });
    await g.e.flush();
    expect(g.r.events.every((x) => x.content.length < 100_000)).toBe(true);
    expect((await g.p.pull()).events).toHaveLength(3001);
    g.e.stop();
  });
  it('a message a relay refuses is tried again as it is; later changes go out on their own, not merged into it', async () => {
    const g = await group([ev('e1', 'One')]);
    await g.e.flush(); // (the group's start, sent)
    const send = g.r.send, tries = new Map<string, number>();
    let refused: string | undefined;
    g.r.send = async (x) => {
      refused ??= x.id;
      tries.set(x.id, (tries.get(x.id) ?? 0) + 1);
      return x.id === refused ? false : send(x);
    };
    useStore.getState().updateEvent('e1', { title: 'Edit one' });
    await g.e.flush();
    useStore.getState().updateEvent('e1', { location: 'Edit two' });
    await g.e.flush();
    const ids = [...tries.keys()];
    expect(ids).toHaveLength(2);
    expect(tries.get(refused!)).toBe(2);
    const second = (await openMessage(g.r.events.find((x) => x.id === ids[1])!, g.k)) as { data: Uint8Array };
    const text = new TextDecoder().decode(second.data);
    expect(text).toContain('Edit two');
    expect(text).not.toContain('Edit one');
    g.e.stop();
  });
  it('a change made offline goes out at the next launch, without waiting for a snapshot', async () => {
    const g = await group([ev('e1', 'One')]);
    await g.e.flush();
    g.e.stop();
    const off = startEngine((await readConfig())!, memoryTransport({ down: true }), 'resume');
    await sleep(50);
    useStore.getState().updateEvent('e1', { title: 'Edited offline' });
    await off.flush();
    off.stop();
    const again = startEngine((await readConfig())!, g.r, 'resume');
    await sleep(300); // (a snapshot would take 20 s)
    expect((await g.p.pull()).events[0].title).toBe('Edited offline');
    again.stop();
  });
});

describe('development', () => {
  it('sync doesn’t start at launch against the public relays unless asked for (localStorage wl-dev-network = 1)', async () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(await readConfig()).toBeTruthy();
    useStore.getState().setSync({ on: false, state: 'off' });
    await resumeSync();
    expect(useStore.getState().sync.on).toBe(false);
  });
});

describe('editing while this device is still joining', () => {
  it('puts nothing of this device’s into the group: a new event made before the group’s data arrived isn’t sent', async () => {
    const g = await group([ev('m1', 'Mac one')]);
    await g.e.flush();
    g.e.stop();
    useStore.setState({ events: [] });
    mem.delete('worldline-sync-doc');
    const offline = memoryTransport({ down: true });
    const e = startEngine({ secret: g.s, device: newDeviceKey(), joining: true }, offline, 'join');
    await sleep(50);
    useStore.setState((s) => ({ events: [...s.events, ev('p2', 'Phone again')] }));
    await sleep(1700);
    offline.down = false;
    await e.flush();
    expect(offline.events).toHaveLength(0); // nothing went out
    expect((readDoc(e.doc) as Synced).events ?? []).toHaveLength(0);
    e.stop();
    expect((await g.p.pull()).events.map((x) => x.id)).toEqual(['m1']);
  });
});

describe('a message the relays keep refusing', () => {
  it('is retried less and less often, then left to a snapshot (which carries the change)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const r = memoryTransport();
      useStore.getState().startFresh();
      useStore.setState({ events: [ev('e1', 'One')] });
      const sec = newSecret();
      const e = startEngine({ secret: sec, device: newDeviceKey() }, r, 'create');
      // (step the clock: sealing a message compresses it on real streams, which fake timers don't wait for)
      const pass = async (ms: number) => {
        for (let t = 0; t < ms; t += 5_000) {
          await vi.advanceTimersByTimeAsync(5_000);
          for (let i = 0; i < 5; i++) await new Promise((ok) => setImmediate(ok));
        }
      };
      await pass(5_000); // the group's first update and snapshot went out
      let attempts = 0;
      r.refuse = (x) => !x.tags.some((t) => t[1]?.includes(':s:')) && ++attempts > 0; // updates refused, snapshots taken
      useStore.getState().updateEvent('e1', { title: 'One, renamed' });
      await pass(60 * 60_000);
      expect(attempts).toBe(6); // 15 s, 30 s, 1 min, 2 min, 4 min… then given up — not 240 tries an hour
      const snap = r.events.filter((x) => x.tags.some((t) => t[1]?.includes(':s:')));
      const p = phone(r, deriveSync(sec));
      expect(snap.length).toBeGreaterThan(0);
      expect((await p.pull()).events[0].title).toBe('One, renamed');
      e.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('saving the document with years of data', () => {
  it('adds only what changed to a log, writes it whole again once the log is long, and reads both back', async () => {
    const g = await group([ev('e1', 'One'), ev('e2', 'Two')]);
    await g.e.flush();
    const whole = mem.get('worldline-sync-doc')!;
    expect(mem.get('worldline-sync-doc-log') ?? '[]').toBe('[]');
    for (let i = 0; i < 3; i++) {
      useStore.getState().updateEvent('e1', { title: `One, take ${i}` });
      await sleep(30);
      await g.e.flush();
    }
    expect(mem.get('worldline-sync-doc')).toBe(whole); // not rewritten
    const log = JSON.parse(mem.get('worldline-sync-doc-log')!) as string[];
    expect(log.length).toBe(3);
    expect(log.every((u) => u.length < 400)).toBe(true); // small updates, not the document
    g.e.stop();
    // the next launch reads the document plus its log
    const cfg = (await readConfig())!;
    const again = startEngine(cfg, g.r, 'resume');
    await again.flush();
    expect((readDoc(again.doc) as Synced).events.find((x) => x.id === 'e1')?.title).toBe('One, take 2');
    again.stop();
  });
});
