// Sync, part 3: the engine that runs in the app. Your edits go into a shared document (lib/sync/model.ts) and out to
// the relays as small encrypted updates (lib/sync/wire.ts); what other devices send is merged in and shown. Every
// device keeps a full copy and works offline; nothing is stored anywhere but your devices and, encrypted, the relays.
//
//   · Turn on (first device): this device's data becomes the shared document; a snapshot goes out at once.
//   · Join (another device, with the pairing code): this device's own data is replaced by what the others have.
//   · Each change: sent ~1.5 s after you stop (merged into one update), or at once when the app goes to the
//     background (the iPhone stops running a hidden app within seconds); kept 30 days by the relays.
//   · Snapshots: each device republishes its whole document after starting and every 6 hours if anything changed,
//     so a device that was off for months still catches up.
//   · Catching up: a device that synced recently asks only for what's new since then (less a day, for clocks that
//     disagree) rather than 30 days of everything; a full catch-up (every update kept, plus snapshots) runs when
//     joining, after 25 days away, once a week, and whenever an update arrives that depends on one never seen.
//   · Formats: a device that finds data or messages from a newer Worldline stops syncing and asks to be updated
//     (an older copy would otherwise write old-format records over new ones).
//
// Saved on this device: the document, only once the app's own data is saved at least as far (so after a crash the
// app's data is never older than the document — at restart the difference between them is taken as this device's
// own edits, and a stale copy would read as deleting what other devices did).
import * as Y from 'yjs';
import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { useStore } from './store';
import { allSaved, flush as flushStore, sideStore } from './persist';
import { SYNC_SCHEMA, docIsEmpty, docSchema, pick, readDoc, writeLocal, type Synced } from '../lib/sync/model';
import { KIND, SnapshotAssembler, deriveSync, newDeviceKey, newSecret, openMessage, sealSnapshot, sealUpdate } from '../lib/sync/wire';
import { RELAYS, loadRelayList, relayTransport, type Transport } from '../lib/relays';
import { isApp } from '../lib/platform';

const CONFIG = 'worldline-sync'; // { secret, device, snapAt, seenAt, fullAt } — beside the app's data, never in a backup
const DOC = 'worldline-sync-doc'; // the shared document, as Yjs bytes (base64)
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SNAPSHOT_EVERY = 6 * HOUR;
const MARGIN = DAY; // asking for "what's new since …" starts this much earlier (other devices' clocks may be off)
const SETTLE = 10_000; // after the relays say they've sent what they had stored: time to open and apply it

export interface SyncConfig {
  secret: string; // the group's secret (hex) — what the pairing code carries
  device: string; // this device's signing key (hex)
  snapAt?: number; // when this device last published a snapshot
  seenAt?: number; // everything published before this (less MARGIN) has been received
  fullAt?: number; // when this device last did a full catch-up
}

const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function readConfig(): Promise<SyncConfig | null> {
  try {
    const v = await sideStore.get(CONFIG);
    const c = v ? (JSON.parse(v) as SyncConfig) : null;
    return c && /^[0-9a-f]{64}$/.test(c.secret) && /^[0-9a-f]{64}$/.test(c.device) ? c : null;
  } catch {
    return null;
  }
}
const writeConfig = (c: SyncConfig) => sideStore.set(CONFIG, JSON.stringify(c));

/** The relays sync uses: the same list as scheduling links (kept current weekly — lib/relaylist.ts). */
async function syncTransport(): Promise<Transport> {
  const url = isApp() ? 'https://bradenseefeldt.github.io/worldline/relays.json' : import.meta.env.DEV ? '/relays.json' : './relays.json';
  return relayTransport((await loadRelayList(url))?.relays ?? RELAYS);
}

/** Ask for everything, or only what's new? (Pure, for the tests.) */
export function catchUpFrom(cfg: SyncConfig, mode: 'resume' | 'create' | 'join', now: number): number | undefined {
  const { seenAt, fullAt } = cfg;
  if (mode !== 'resume' || !seenAt || seenAt > now + HOUR || now - seenAt > 25 * DAY || !fullAt || now - fullAt > 7 * DAY) return undefined;
  return Math.floor((seenAt - MARGIN) / 1000);
}

export interface Engine {
  stop: () => void;
  /** Push pending changes and save the document now (tests; when the app goes to the background; before quitting). */
  flush: () => Promise<void>;
  /** Ask the relays again for what's new (after the network or the app was away), on a new connection if given.
   *  False: not running (stopped, or paused for an update) — the connection given wasn't taken. */
  reconnect: (t?: Transport) => boolean;
  doc: Y.Doc;
}

/**
 * Run sync. `mode`: 'resume' (already set up: carry on), 'create' (this device's data starts the group),
 * 'join' (this device takes what the group has, replacing its own).
 */
export function startEngine(cfg: SyncConfig, transport: Transport, mode: 'resume' | 'create' | 'join', clock = () => Date.now()): Engine {
  const st = useStore.getState;
  const keys = deriveSync(cfg.secret);
  const doc = new Y.Doc();
  const assembler = new SnapshotAssembler();
  let t = transport;
  let stopped = false;
  let paused = false; // a newer Worldline's data: nothing is read, written or saved until this device is updated
  let outgoing: Uint8Array[] = [];
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let applyTimer: ReturnType<typeof setTimeout> | undefined;
  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let changedSinceSnapshot = mode === 'create';
  let applying = false;
  let prev: Synced = pick(st() as unknown as Record<string, unknown>);
  const seen = new Set<string>(); // messages already handled (asking again returns them again)
  const set = st().setSync;
  set({ on: true, state: 'connecting' });

  function pause() {
    if (paused) return;
    paused = true;
    clearTimeout(sendTimer);
    clearTimeout(saveTimer);
    clearTimeout(applyTimer);
    clearTimeout(snapTimer);
    clearTimeout(settleTimer);
    outgoing = [];
    set({ state: 'update-needed' });
  }

  // ---- what this device changes → the document
  const unsubStore = useStore.subscribe((s) => {
    if (stopped || paused) return;
    const next = pick(s as unknown as Record<string, unknown>);
    if (applying) {
      prev = next; // the change came from the document itself
      return;
    }
    if ((Object.keys(next) as (keyof Synced)[]).every((k) => k === 'settings' ? JSON.stringify(next.settings) === JSON.stringify(prev.settings) : next[k] === prev[k])) return;
    writeLocal(doc, prev, next, 'local');
    prev = next;
  });

  // ---- the document → this device (what others sent) and → the relays (what this device changed)
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (paused) return;
    changedSinceSnapshot = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveDoc(), 1500);
    if (origin === 'local') {
      outgoing.push(u);
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => void send(), 1500);
    } else if (origin === 'remote') {
      if (docSchema(doc) > SYNC_SCHEMA) return pause();
      clearTimeout(applyTimer);
      applyTimer = setTimeout(applyRemote, 150); // a burst (catching up) is shown once
    }
  });

  function applyRemote() {
    clearTimeout(applyTimer);
    applyTimer = undefined;
    if (stopped || paused || docIsEmpty(doc)) return; // (joining: nothing of the group's has arrived yet)
    const got = readDoc(doc, prev);
    if (Array.isArray(got.calendars) && got.calendars.length === 0) delete got.calendars; // never leave a device with no calendar
    const now = st() as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(got)) {
      if (k === 'settings') {
        const cur = (now.settings ?? {}) as Record<string, unknown>;
        const diff = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([f, x]) => JSON.stringify(cur[f]) !== JSON.stringify(x)));
        if (Object.keys(diff).length) patch.settings = diff;
      } else if (v !== now[k]) patch[k] = v;
    }
    if (Object.keys(patch).length) {
      applying = true;
      try {
        st().applySynced(patch);
      } finally {
        applying = false;
      }
    }
    set({ lastIn: clock(), state: 'synced' });
  }

  /** Save the document — only once the app's data is saved at least as far (see the top of the file). */
  async function saveDoc() {
    clearTimeout(saveTimer);
    if (stopped || paused) return;
    if (applyTimer !== undefined) applyRemote(); // what arrived goes into the app's data first
    const bytes = Y.encodeStateAsUpdate(doc);
    await flushStore();
    if (stopped || paused) return;
    if (allSaved()) await sideStore.set(DOC, b64(bytes)).catch(() => undefined);
    else saveTimer = setTimeout(() => void saveDoc(), 5000); // the app's data isn't saving: keep the older document
  }

  async function send() {
    if (stopped || paused || !outgoing.length) return;
    clearTimeout(sendTimer);
    const batch = Y.mergeUpdates(outgoing);
    outgoing = [];
    set({ state: 'sending' });
    const ok = await t.send(await sealUpdate(batch, keys, cfg.device, clock())).catch(() => false);
    if (stopped) return;
    if (ok) set({ state: 'synced', lastOut: clock() });
    else {
      outgoing.unshift(batch); // keep it; try again shortly
      set({ state: 'offline' });
      sendTimer = setTimeout(() => void send(), 15_000);
    }
  }

  async function snapshot() {
    if (stopped || paused) return;
    if (changedSinceSnapshot || clock() - (cfg.snapAt ?? 0) > 7 * DAY) {
      const pieces = await sealSnapshot(Y.encodeStateAsUpdate(doc), keys, cfg.device, clock());
      const results = await Promise.all(pieces.map((p) => t.publish(p).catch(() => 0)));
      if (results.every((n) => n > 0)) {
        changedSinceSnapshot = false;
        cfg.snapAt = clock();
        void writeConfig(cfg);
      }
    }
    if (stopped || paused) return;
    snapTimer = setTimeout(() => {
      reconnect(); // (also a fresh "what's new" now and then, so a long-running session's catch-up point moves on)
      void snapshot();
    }, SNAPSHOT_EVERY);
  }

  // ---- incoming messages (stored ones first, then live)
  const onEvent = async (ev: Event) => {
    if (seen.has(ev.id) || stopped || paused) return;
    seen.add(ev.id);
    const m = await openMessage(ev, keys, clock());
    if (!m || stopped || paused) return;
    if (m.kind === 'newer') return pause();
    const me = m.device === (await deviceId(cfg));
    if (!me) set({ devices: { ...st().sync.devices, [m.device]: Math.max(st().sync.devices[m.device] ?? 0, m.at * 1000) } });
    if (m.kind === 'update') Y.applyUpdate(doc, m.data, 'remote');
    else {
      const whole = await assembler.add(m);
      if (whole && !stopped && !paused) Y.applyUpdate(doc, whole, 'remote');
    }
  };

  // ---- asking the relays: everything (full) or what's new since the last time
  let stopSubs: (() => void)[] = [];
  let fullPending = false; // a full catch-up hasn't finished yet (asking again must ask for everything again)
  function subscribe(full: boolean, since?: number) {
    full ||= fullPending || since === undefined;
    fullPending = full;
    stopSubs.forEach((f) => f());
    clearTimeout(settleTimer);
    if (stopped || paused) return;
    const startedAt = clock();
    const base: Filter = { kinds: [KIND], '#t': [keys.tag] };
    // The catch-up point moves on only once a connected relay has sent everything it had stored (opened offline, or
    // on a link too slow to deliver the backlog, it stays put — and asking again later asks from the old point)
    const settle = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (stopped || paused) return;
        const s = doc.store as unknown as { pendingStructs: unknown; pendingDs: unknown };
        if (!full && (s.pendingStructs || s.pendingDs)) return subscribe(true); // something arrived that depends on an update never seen
        if (s.pendingStructs || s.pendingDs) return; // (a full catch-up couldn't fill the gap: keep the old catch-up point)
        cfg.seenAt = Math.max(cfg.seenAt ?? 0, startedAt);
        if (full) cfg.fullAt = startedAt;
        fullPending = false;
        void writeConfig(cfg);
      }, SETTLE);
    };
    stopSubs = [t.subscribe(full ? base : { ...base, since }, (ev) => void onEvent(ev), settle)];
    // snapshots asked for on their own too: relays cap how many messages one request returns (newest first), and a
    // device catching up needs a snapshot even when a month of updates fills that cap
    if (full) stopSubs.push(t.subscribe({ kinds: [KIND], '#t': [keys.snapTag] }, (ev) => void onEvent(ev)));
  }
  function reconnect(next?: Transport): boolean {
    if (stopped || paused) return false;
    if (next && next !== t) {
      stopSubs.forEach((f) => f());
      stopSubs = [];
      t.close?.();
      t = next;
    }
    subscribe(false, cfg.seenAt ? Math.floor((cfg.seenAt - MARGIN) / 1000) : undefined);
    if (outgoing.length) void send();
    return true;
  }

  // ---- start
  const ready = (async () => {
    const saved = await sideStore.get(DOC).catch(() => null);
    if (saved && mode === 'resume') Y.applyUpdate(doc, unb64(saved), 'load');
    if (docSchema(doc) > SYNC_SCHEMA) return pause();
    if (mode === 'create' || (mode === 'resume' && docIsEmpty(doc))) writeLocal(doc, null, prev, 'local'); // this device's data starts the group
    else if (mode === 'resume') {
      // anything changed here while sync wasn't running (an edit just before quitting) goes out too
      writeLocal(doc, readDoc(doc) as Synced, prev, 'local');
    }
    // join: nothing of this device's own goes in; it takes the group's data as it arrives
    if (stopped) return;
    const since = catchUpFrom(cfg, mode, clock());
    subscribe(since === undefined, since);
    snapTimer = setTimeout(() => void snapshot(), mode === 'create' ? 500 : 20_000);
  })();

  return {
    doc,
    flush: async () => {
      await ready;
      clearTimeout(sendTimer);
      await Promise.all([send(), saveDoc()]);
    },
    reconnect,
    stop() {
      stopped = true;
      stopSubs.forEach((f) => f());
      unsubStore();
      clearTimeout(sendTimer);
      clearTimeout(saveTimer);
      clearTimeout(applyTimer);
      clearTimeout(snapTimer);
      clearTimeout(settleTimer);
      doc.destroy();
      set({ on: false, state: 'off' });
    },
  };
}

let deviceIds = new Map<string, string>();
async function deviceId(cfg: SyncConfig) {
  if (!deviceIds.has(cfg.device)) {
    const { getPublicKey } = await import('nostr-tools/pure');
    const { hexToBytes } = await import('@noble/hashes/utils.js');
    deviceIds = new Map([[cfg.device, getPublicKey(hexToBytes(cfg.device))]]);
  }
  return deviceIds.get(cfg.device)!;
}

// ---- the app's controls (Settings → Sync)
let running: { engine: Engine; transport: Transport } | null = null;

async function run(cfg: SyncConfig, mode: 'resume' | 'create' | 'join') {
  running?.engine.stop();
  running?.transport.close?.();
  const transport = await syncTransport();
  running = { engine: startEngine(cfg, transport, mode), transport };
}

/** At launch: carry on if this device is set up to sync. */
export async function resumeSync() {
  const cfg = await readConfig();
  if (cfg) await run(cfg, 'resume');
}

/** Send and save anything pending (before quitting). */
export const flushSync = () => running?.engine.flush() ?? Promise.resolve();

// The app going to the background: send now (a phone stops running a hidden app within seconds). Coming back after a
// while, or the network returning: a fresh connection and a fresh "what's new" (a phone's connections die in the
// background; a laptop's die while it sleeps).
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  let hiddenAt = 0;
  const fresh = async () => {
    const r = running;
    if (!r) return;
    const t = await syncTransport();
    if (running === r && r.engine.reconnect(t)) r.transport = t;
    else t.close?.();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      void flushSync();
    } else if (hiddenAt && Date.now() - hiddenAt > 60_000) void fresh();
  });
  window.addEventListener('pagehide', () => void flushSync());
  window.addEventListener('online', () => void fresh());
}

/** Turn sync on with this device's data as the starting point; returns the secret (for the pairing code). */
export async function createSync(): Promise<string> {
  const cfg: SyncConfig = { secret: newSecret(), device: newDeviceKey() };
  await sideStore.del(DOC);
  await writeConfig(cfg);
  await run(cfg, 'create');
  return cfg.secret;
}

/** Join another device's sync (the secret from its pairing code): this device's own data is replaced by the group's. */
export async function joinSync(secret: string) {
  const cfg: SyncConfig = { secret, device: newDeviceKey() };
  await sideStore.del(DOC);
  await writeConfig(cfg);
  await run(cfg, 'join');
}

/** Stop syncing on this device (its data stays; the other devices carry on). */
export async function leaveSync() {
  running?.engine.stop();
  running?.transport.close?.();
  running = null;
  await sideStore.del(CONFIG);
  await sideStore.del(DOC);
}

/** The pairing code of this device's group (to show again). */
export const currentSecret = async () => (await readConfig())?.secret ?? null;
