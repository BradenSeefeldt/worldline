// Sync, part 3: the engine that runs in the app. Your edits go into a shared document (lib/sync/model.ts) and out to
// the relays as small encrypted updates (lib/sync/wire.ts); what other devices send is merged in and shown. Every
// device keeps a full copy and works offline; nothing is stored anywhere but your devices and, encrypted, the relays.
//
//   · Turn on (first device): this device's data becomes the shared document; a snapshot goes out at once.
//   · Join (another device, with the pairing code): this device's own data is replaced by what the others have.
//   · Each change: sent ~1.5 s after you stop (merged into one update); kept 30 days by the relays.
//   · Snapshots: each device republishes its whole document after starting and every 6 hours if anything changed,
//     so a device that was off for months still catches up.
import * as Y from 'yjs';
import type { Event } from 'nostr-tools/pure';
import { useStore } from './store';
import { sideStore } from './persist';
import { docIsEmpty, pick, readDoc, writeLocal, type Synced } from '../lib/sync/model';
import { KIND, SnapshotAssembler, deriveSync, newDeviceKey, newSecret, openMessage, sealSnapshot, sealUpdate } from '../lib/sync/wire';
import { RELAYS, loadRelayList, relayTransport, type Transport } from '../lib/relays';
import { isApp } from '../lib/platform';

const CONFIG = 'worldline-sync'; // { secret, device, snapAt } — beside the app's data, never in a backup
const DOC = 'worldline-sync-doc'; // the shared document, as Yjs bytes (base64)
const SNAPSHOT_EVERY = 6 * 3_600_000;

export interface SyncConfig {
  secret: string; // the group's secret (hex) — what the pairing code carries
  device: string; // this device's signing key (hex)
  snapAt?: number; // when this device last published a snapshot
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

export interface Engine {
  stop: () => void;
  /** Push any pending changes now (tests; before a restart). */
  flush: () => Promise<void>;
  doc: Y.Doc;
}

/**
 * Run sync. `mode`: 'resume' (already set up: carry on), 'create' (this device's data starts the group),
 * 'join' (this device takes what the group has, replacing its own).
 */
export function startEngine(cfg: SyncConfig, t: Transport, mode: 'resume' | 'create' | 'join', clock = () => Date.now()): Engine {
  const st = useStore.getState;
  const keys = deriveSync(cfg.secret);
  const doc = new Y.Doc();
  const assembler = new SnapshotAssembler();
  let stopped = false;
  let outgoing: Uint8Array[] = [];
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let applyTimer: ReturnType<typeof setTimeout> | undefined;
  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  let changedSinceSnapshot = mode === 'create';
  let applying = false;
  let prev: Synced = pick(st() as unknown as Record<string, unknown>);
  const set = st().setSync;
  set({ on: true, state: 'connecting' });

  // ---- what this device changes → the document
  const unsubStore = useStore.subscribe((s) => {
    if (stopped) return;
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
    changedSinceSnapshot = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void sideStore.set(DOC, b64(Y.encodeStateAsUpdate(doc))), 1500);
    if (origin === 'local') {
      outgoing.push(u);
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => void send(), 1500);
    } else if (origin === 'remote') {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(applyRemote, 150); // a burst (catching up) is shown once
    }
  });

  function applyRemote() {
    if (stopped || docIsEmpty(doc)) return; // (joining: nothing of the group's has arrived yet)
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

  async function send() {
    if (stopped || !outgoing.length) return;
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
    if (stopped) return;
    if (changedSinceSnapshot || clock() - (cfg.snapAt ?? 0) > 7 * 86_400_000) {
      const pieces = await sealSnapshot(Y.encodeStateAsUpdate(doc), keys, cfg.device, clock());
      const results = await Promise.all(pieces.map((p) => t.publish(p).catch(() => 0)));
      if (results.every((n) => n > 0)) {
        changedSinceSnapshot = false;
        cfg.snapAt = clock();
        void writeConfig(cfg);
      }
    }
    snapTimer = setTimeout(() => void snapshot(), SNAPSHOT_EVERY);
  }

  // ---- incoming messages (stored ones first, then live)
  const onEvent = async (ev: Event) => {
    const m = await openMessage(ev, keys, clock());
    if (!m || stopped) return;
    if (m.device !== ev.pubkey) return;
    const me = m.device === (await deviceId(cfg));
    if (!me) set({ devices: { ...st().sync.devices, [m.device]: Math.max(st().sync.devices[m.device] ?? 0, m.at * 1000) } });
    if (m.kind === 'update') Y.applyUpdate(doc, m.data, 'remote');
    else {
      const whole = await assembler.add(m);
      if (whole) Y.applyUpdate(doc, whole, 'remote');
    }
  };

  // ---- start
  let stopSub: (() => void) | undefined;
  const ready = (async () => {
    const saved = await sideStore.get(DOC).catch(() => null);
    if (saved && mode === 'resume') Y.applyUpdate(doc, unb64(saved), 'load');
    if (mode === 'create' || (mode === 'resume' && docIsEmpty(doc))) writeLocal(doc, null, prev, 'local'); // this device's data starts the group
    else if (mode === 'resume') {
      // anything changed here while sync wasn't running (an edit just before quitting) goes out too
      writeLocal(doc, readDoc(doc) as Synced, prev, 'local');
    }
    // join: nothing of this device's own goes in; it takes the group's data as it arrives
    if (stopped) return;
    stopSub = t.subscribe({ kinds: [KIND], '#t': [keys.tag] }, (ev) => void onEvent(ev));
    snapTimer = setTimeout(() => void snapshot(), mode === 'create' ? 500 : 20_000);
  })();

  return {
    doc,
    flush: async () => {
      await ready;
      clearTimeout(sendTimer);
      await send();
    },
    stop() {
      stopped = true;
      stopSub?.();
      unsubStore();
      clearTimeout(sendTimer);
      clearTimeout(saveTimer);
      clearTimeout(applyTimer);
      clearTimeout(snapTimer);
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
