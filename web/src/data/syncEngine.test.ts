// Sync end to end: this app (the real store + engine) and a second device (a phone, simulated with the same document
// and message code), talking through an in-memory relay.
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
beforeAll(async () => {
  ({ useStore } = await import('./store'));
  ({ startEngine, catchUpFrom } = await import('./syncEngine'));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const relay = memoryTransport();
const secret = newSecret();
const keys = deriveSync(secret);

/** The phone: a document fed from the relay's messages, and a way to make an edit and send it. */
function phone() {
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
    for (const word of ['Dentist', 'Group meeting', 'Sam', 'Bloor']) expect(all).not.toContain(word);
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
    const before = mem.get('worldline-sync-doc');
    expect(before).toBeTruthy();
    failAppSaves = true;
    try {
      useStore.setState({ events: [ev('unsaved', 'Not saved yet')] });
      await e.flush();
      expect(mem.get('worldline-sync-doc')).toBe(before);
    } finally {
      failAppSaves = false;
    }
    await e.flush();
    expect(mem.get('worldline-sync-doc')).not.toBe(before);
    e.stop();
  });
});

describe('the catch-up point', () => {
  const run = async (down: boolean) => {
    const r = memoryTransport({ down });
    mem.delete('worldline-sync');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const e = startEngine({ secret: newSecret(), device: newDeviceKey(), seenAt: Date.now() - 86_400_000, fullAt: Date.now() - 86_400_000 }, r, 'resume');
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
    expect(await run(true)).toBeUndefined();
  });
});
