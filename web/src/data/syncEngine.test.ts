// Sync end to end: this app (the real store + engine) and a second device (a phone, simulated with the same document
// and message code), talking through an in-memory relay.
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Event } from 'nostr-tools/pure';
import { memoryTransport } from '../lib/relays';
import { KIND, SnapshotAssembler, deriveSync, newDeviceKey, newSecret, openMessage, sealUpdate } from '../lib/sync/wire';
import { pick, readDoc, writeLocal, type Synced } from '../lib/sync/model';

const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const noop = () => {};
Object.assign(globalThis, {
  localStorage,
  window: { innerWidth: 1200, localStorage, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) },
  document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
});
let useStore: typeof import('./store').useStore;
let startEngine: typeof import('./syncEngine').startEngine;
beforeAll(async () => {
  ({ useStore } = await import('./store'));
  ({ startEngine } = await import('./syncEngine'));
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
