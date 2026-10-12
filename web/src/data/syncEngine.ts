// Sync, part 3: the engine that runs in the app. Your edits go into a shared document (lib/sync/model.ts) and out to
// the relays as small encrypted updates (lib/sync/wire.ts); what other devices send is merged in and shown. Every
// device keeps a full copy and works offline; nothing is stored anywhere but your devices and, encrypted, the relays.
//
//   · Turn on (first device): this device's data becomes the shared document; a snapshot goes out at once.
//   · Join (another device, with the pairing code): this device's own data is replaced by what the others have.
//     Remembered (`joining`) until the group's data has been shown and saved here: a join cut short (offline, or the
//     app closed) carries on at the next launch. Only a device that never joined may start an empty document.
//   · Data replaced (a restore, starting over, erase everything): sync stops and this device joins again — the
//     replacement is never sent out as everyone's edits.
//   · Each change: sent ~1.5 s after you stop (merged into one update; a big one in pieces), or at once when the app
//     goes to the background (the iPhone stops running a hidden app within seconds); kept 30 days by the relays. A
//     message no relay takes is tried again as it is (later changes go separately); what never went out (offline,
//     then closed) goes out at the next launch.
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
import { allSaved, flush as flushStore, onDataReplaced, sideStore } from './persist';
import { SYNC_SCHEMA, docIsEmpty, docSchema, pick, readDoc, writeLocal, type Synced } from '../lib/sync/model';
import { KIND, SnapshotAssembler, deriveSync, newDeviceKey, newSecret, openMessage, sealSnapshot, sealUpdates } from '../lib/sync/wire';
import { RELAYS, loadRelayList, relayTransport, type Transport } from '../lib/relays';
import { isApp } from '../lib/platform';

const CONFIG = 'worldline-sync'; // SyncConfig — beside the app's data, never in a backup
const DOC = 'worldline-sync-doc'; // the shared document, as Yjs bytes (base64)
const DOC_LOG = 'worldline-sync-doc-log'; // changes since DOC was last written whole (JSON list of base64 updates)
const LOG_MAX = 1_000_000; // once the log is this long (characters), the document is written whole again
/** Forget the saved document (and its log). */
const dropDoc = () => Promise.all([sideStore.del(DOC), sideStore.del(DOC_LOG)]);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SNAPSHOT_EVERY = 6 * HOUR;
const MARGIN = DAY; // asking for "what's new since …" starts this much earlier (other devices' clocks may be off)
const SETTLE = 10_000;
const MAX_TRIES = 6; // a message connected relays refused this many times is left to the next snapshot // after the relays say they've sent what they had stored: time to open and apply it

export interface SyncConfig {
  secret: string; // the group's secret (hex) — what the pairing code carries
  device: string; // this device's signing key (hex)
  snapAt?: number; // when this device last published a snapshot
  seenAt?: number; // everything published before this (less MARGIN) has been received
  fullAt?: number; // when this device last did a full catch-up
  joining?: boolean; // joining: the group's data hasn't yet been shown and saved here (nothing of this device's goes out)
  joined?: boolean; // this device joined (rather than started) the group: it never starts an empty document
  sent?: string; // (base64 Yjs state vector) everything in the document up to this has reached a relay
  unsent?: boolean; // when the document was last saved, some changes made here hadn't reached a relay yet
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
  let outgoing: Uint8Array[] = []; // changes made here, not yet sealed into messages
  let unsent: Event[] = []; // messages no relay has taken yet: tried again as they are, never merged with newer changes
  const tries = new Map<string, number>(); // (message id) times relays that were connected refused it
  let failedRounds = 0; // sends in a row that didn't all go out: the next try waits longer (15 s, 30 s, … 15 min)
  let inFlight = false;
  let sending: Promise<void> = Promise.resolve();
  let acked: Uint8Array | undefined = cfg.sent ? unb64(cfg.sent) : undefined; // (state vector) everything up to this is on the relays
  let joining = mode === 'join' || !!cfg.joining;
  let joinApplied = false; // (joining) the group's data has been shown here
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
  const pendingLocal = () => outgoing.length > 0 || unsent.length > 0 || inFlight;
  const offReplaced = onDataReplaced(() => stop()); // this device's data is being replaced: write nothing more

  function pause() {
    if (paused) return;
    paused = true;
    clearTimeout(sendTimer);
    clearTimeout(saveTimer);
    clearTimeout(applyTimer);
    clearTimeout(snapTimer);
    clearTimeout(settleTimer);
    outgoing = [];
    unsent = [];
    set({ state: 'update-needed' });
  }

  // ---- what this device changes → the document
  const unsubStore = useStore.subscribe((s) => {
    if (stopped || paused) return;
    const next = pick(s as unknown as Record<string, unknown>);
    if (applying || (joining && !joinApplied)) {
      // the change came from the document itself — or this device is joining: its own data is about to be replaced
      // by the group's, and nothing of it goes into the document meanwhile
      prev = next;
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
      if (!pendingLocal()) acked = Y.encodeStateVector(doc); // (it came from a relay; nothing here waits to go out)
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
    if (joining && !joinApplied) {
      joinApplied = true;
      void saveDoc(); // at once: until it's saved, a restart has to join again
    }
  }

  /** Save the document — only once the app's data is saved at least as far (see the top of the file). With years of
   *  data the document is megabytes, so a save normally only adds what changed since the last one to a log; the
   *  whole document is written again (and the log emptied) once the log grows past LOG_MAX. One save at a time. */
  let saving: Promise<void> = Promise.resolve();
  let savedSV: Uint8Array | undefined; // (state vector) what's on disk: DOC plus the log
  let log: string[] = [];
  let logSize = 0;
  const saveDoc = () => (saving = saving.then(saveDocOnce, saveDocOnce));
  async function saveDocOnce() {
    clearTimeout(saveTimer);
    if (stopped || paused) return;
    if (applyTimer !== undefined) applyRemote(); // what arrived goes into the app's data first
    const whole = !savedSV || logSize > LOG_MAX;
    const bytes = whole ? Y.encodeStateAsUpdate(doc) : Y.encodeStateAsUpdate(doc, savedSV);
    const sv = Y.encodeStateVector(doc);
    const joined = joining && joinApplied;
    const sent = { sent: acked && b64(acked), unsent: pendingLocal() };
    await flushStore();
    if (stopped || paused) return;
    if (!allSaved()) {
      saveTimer = setTimeout(() => void saveDoc(), 5000); // the app's data isn't saving: keep the older document
      return;
    }
    // what hasn't gone out yet is noted before the document (with those changes in it) is saved: never forgotten
    if (cfg.sent !== sent.sent || !!cfg.unsent !== sent.unsent) {
      Object.assign(cfg, sent);
      await writeConfig(cfg).catch(() => undefined);
      if (stopped || paused) return;
    }
    let ok: boolean;
    if (whole) {
      // (the log is emptied after the whole document is written: a crash in between only applies it twice — harmless)
      ok = await sideStore.set(DOC, b64(bytes)).then(() => true, () => false);
      if (ok && logSize) ok = await sideStore.del(DOC_LOG).then(() => true, () => false);
      if (ok) (log = []), (logSize = 0);
    } else if (bytes.length > 2 && !sameVector(sv, savedSV!)) {
      const next = [...log, b64(bytes)];
      ok = await sideStore.set(DOC_LOG, JSON.stringify(next)).then(() => true, () => false);
      if (ok) (log = next), (logSize += next[next.length - 1].length);
    } else ok = true; // nothing new
    if (ok) savedSV = sv;
    if (ok && joined && !stopped && cfg.joining !== false) {
      cfg.joining = false;
      cfg.joined = true;
      joining = false;
      await writeConfig(cfg).catch(() => undefined);
    }
  }

  /** Send what changed here (one send at a time, in order). */
  const send = () => (sending = sending.then(sendOnce));
  async function sendOnce() {
    if (stopped || paused) return;
    clearTimeout(sendTimer);
    inFlight = true;
    try {
      if (outgoing.length) {
        const batch = Y.mergeUpdates(outgoing);
        outgoing = [];
        unsent.push(...(await sealUpdates(batch, keys, cfg.device, clock())));
      }
      if (!unsent.length || stopped) return;
      const todo = unsent;
      unsent = [];
      set({ state: 'sending' });
      const ok = await Promise.all(todo.map((ev) => t.send(ev).catch(() => false)));
      if (stopped || paused) return;
      // A relay that was connected and still didn't take a message refused it. One refused again and again (too big,
      // or not allowed there) is given up on: what it carried goes out in the next snapshot instead, soon.
      const connected = t.health ? t.health().some((h) => h.ok) : false;
      let gaveUp = false;
      const failed = todo.filter((ev, i) => {
        if (ok[i]) return void tries.delete(ev.id);
        const n = connected ? (tries.get(ev.id) ?? 0) + 1 : (tries.get(ev.id) ?? 0);
        if (n < MAX_TRIES) return tries.set(ev.id, n), true;
        tries.delete(ev.id);
        gaveUp = true;
        return false;
      });
      unsent = [...failed, ...unsent]; // keep those; try again later
      if (gaveUp) {
        changedSinceSnapshot = true;
        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => void snapshot(), 30_000);
      }
      if (unsent.length) {
        set({ state: 'offline' });
        sendTimer = setTimeout(() => void send(), Math.min(15_000 * 2 ** failedRounds++, 15 * 60_000));
        return;
      }
      failedRounds = 0;
      set({ state: 'synced', lastOut: clock() });
    } finally {
      inFlight = false;
    }
    if (!pendingLocal()) {
      acked = Y.encodeStateVector(doc); // everything here has reached a relay
      cfg.sent = b64(acked);
      cfg.unsent = false;
      void writeConfig(cfg);
    }
  }

  async function snapshot() {
    if (stopped || paused) return;
    if (changedSinceSnapshot || clock() - (cfg.snapAt ?? 0) > 7 * DAY) {
      const sv = Y.encodeStateVector(doc);
      const pieces = await sealSnapshot(Y.encodeStateAsUpdate(doc), keys, cfg.device, clock());
      const results = await Promise.all(pieces.map((p) => t.publish(p).catch(() => 0)));
      if (stopped || paused) return;
      if (results.every((n) => n > 0)) {
        changedSinceSnapshot = false;
        cfg.snapAt = clock();
        acked = sv; // everything in the document then is on the relays now (in the snapshot)
        if (!pendingLocal()) {
          cfg.sent = b64(sv);
          cfg.unsent = false;
        }
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
    if (seen.size >= 20_000) seen.delete(seen.values().next().value!); // (the oldest: a message seen again is harmless)
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
    if (outgoing.length || unsent.length) void send();
    return true;
  }

  // ---- start
  const ready = (async () => {
    const saved = await sideStore.get(DOC).catch(() => null);
    const savedLog = saved ? await sideStore.get(DOC_LOG).catch(() => null) : null;
    if (stopped) return;
    // a join cut short (offline, or closed before the group's data was saved here), or a device that joined and lost
    // its document: carry on joining — only a device that started the group may start an empty document
    if (mode === 'resume' && (cfg.joining || (cfg.joined && !saved))) mode = 'join';
    joining = mode === 'join';
    if (joining && !cfg.joining) {
      cfg.joining = true;
      void writeConfig(cfg);
    }
    if (saved && mode === 'resume') {
      Y.applyUpdate(doc, unb64(saved), 'load');
      try {
        log = JSON.parse(savedLog ?? '[]') as string[];
        for (const u of log) Y.applyUpdate(doc, unb64(u), 'load');
        logSize = savedLog?.length ?? 0; // (the log carries on from here)
      } catch {
        // a damaged log: what of it could be read stays applied (anything missing comes back from the relays), and the
        // next save writes the document whole
        log = [];
        logSize = Infinity;
      }
      savedSV = Y.encodeStateVector(doc);
    }
    if (docSchema(doc) > SYNC_SCHEMA) return pause();
    if (mode === 'create' || (mode === 'resume' && docIsEmpty(doc))) writeLocal(doc, null, prev, 'local'); // this device's data starts the group
    else if (mode === 'resume') {
      // anything changed here while sync wasn't running (an edit just before quitting) goes out too
      writeLocal(doc, readDoc(doc) as Synced, prev, 'local');
      // and what changed here but never reached a relay (made offline, then the app closed)
      if (cfg.unsent) outgoing.push(Y.encodeStateAsUpdate(doc, acked));
    }
    // join: nothing of this device's own goes in; it takes the group's data as it arrives
    if (stopped) return;
    const since = catchUpFrom(cfg, mode, clock());
    subscribe(since === undefined, since);
    if (outgoing.length) void send();
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
    stop,
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    offReplaced();
    stopSubs.forEach((f) => f());
    unsubStore();
    clearTimeout(sendTimer);
    clearTimeout(saveTimer);
    clearTimeout(applyTimer);
    clearTimeout(snapTimer);
    clearTimeout(settleTimer);
    doc.destroy();
    set({ on: false, state: 'off' });
  }
}

const sameVector = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

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

/** Development talks to the public relays only when asked to (localStorage `wl-dev-network` = `1`): a dev server
 *  holding demo data must never send it into a real sync group. */
const devNetworkOff = () => {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem('wl-dev-network') !== '1';
  } catch {
    return true;
  }
};

/** At launch: carry on if this device is set up to sync. */
export async function resumeSync() {
  await replacing;
  if (devNetworkOff()) return;
  const cfg = await readConfig();
  if (cfg) await run(cfg, 'resume');
}

// This device's data replaced wholesale (data/persist.ts) would read as this device deleting or rolling back
// everything, so it's never compared with the shared document: sync stops, the document is dropped, and this device
// joins again — it takes the group's data (the other devices keep theirs). Erase everything rejoins at once; a
// restore or starting over (the app reloads next) rejoins at the next launch.
let replacing: Promise<void> = Promise.resolve();
onDataReplaced((reloading) =>
  (replacing = (async () => {
    const r = running;
    running = null;
    r?.engine.stop(); // (first, before anything is awaited: the replacement must not reach the document)
    r?.transport.close?.();
    const cfg = await readConfig();
    if (!cfg) return;
    const next: SyncConfig = { ...cfg, joining: true, sent: undefined, unsent: undefined };
    await dropDoc();
    await writeConfig(next);
    if (r && !reloading) await run(next, 'join');
  })()),
);

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
  await dropDoc();
  await writeConfig(cfg);
  await run(cfg, 'create');
  return cfg.secret;
}

/** Join another device's sync (the secret from its pairing code): this device's own data is replaced by the group's. */
export async function joinSync(secret: string) {
  const cfg: SyncConfig = { secret, device: newDeviceKey(), joining: true };
  await dropDoc();
  await writeConfig(cfg);
  await run(cfg, 'join');
}

/** Stop syncing on this device (its data stays; the other devices carry on). */
export async function leaveSync() {
  running?.engine.stop();
  running?.transport.close?.();
  running = null;
  await sideStore.del(CONFIG);
  await dropDoc();
}

/** The pairing code of this device's group (to show again). */
export const currentSecret = async () => (await readConfig())?.secret ?? null;
