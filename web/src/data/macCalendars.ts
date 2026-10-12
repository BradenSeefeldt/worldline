// Calendars on this Mac (iCloud, Google, Exchange… whatever the Calendar app has), kept in step with Worldline both
// ways. lib/macCalendars.ts decides what changed where; this runs it: read the Mac's events (src-tauri/src/eventkit.rs),
// take in its changes, save Worldline's changes back — when the app opens, every 2 minutes, when you come back to it,
// and a moment after you change something in one of those calendars.
//
// Only the Mac that connected a calendar (its `host`) does this. The iPhone and other devices see and edit those
// calendars through sync; their edits reach the Calendar app the next time that Mac runs this.
import { startOfDay } from 'date-fns';
import { useStore } from './store';
import { sideStore } from './persist';
import { calendarIdFor, fingerprint, keyOf, reconcile, type MacEvent, type Push } from '../lib/macCalendars';
import { decodeEvent } from '../lib/recurrence';
import { isApp } from '../lib/platform';
import type { CalEvent, CalendarSource } from './types';

const HOST = 'worldline-mac-host'; // this Mac's id, to tell its calendars from another Mac's
const DAY = 86_400_000;
const MAX_DELETES = 5;

export interface MacCalendar { id: string; title: string; color: string; account: string; writable: boolean }
export type MacAccess = 'full' | 'writeOnly' | 'denied' | 'restricted' | 'notDetermined';

const invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);

let hostId: string | null = null;
/** This Mac's id (made once). */
export async function macHost(): Promise<string> {
  if (hostId) return hostId;
  hostId = (await sideStore.get(HOST).catch(() => null)) ?? null;
  if (!hostId) {
    hostId = crypto.randomUUID();
    await sideStore.set(HOST, hostId);
  }
  return hostId;
}

export const macAccess = () => invoke<MacAccess>('ek_status');
export const askMacAccess = () => invoke<MacAccess>('ek_request');
export const macCalendarList = () => invoke<MacCalendar[]>('ek_calendars');

/** Show a Mac calendar in Worldline (then bring its events in), or stop showing it. */
export async function showMacCalendar(c: MacCalendar, on: boolean) {
  const st = useStore.getState();
  const id = calendarIdFor(c.id);
  if (!on) {
    st.removeMacCalendar(id);
    return;
  }
  const cal: CalendarSource = { id, name: c.title, color: c.color, visible: true, account: c.account, mac: { id: c.id, host: await macHost(), writable: c.writable } };
  st.addMacCalendar(cal);
  await syncMacCalendars();
}

// ---- running it: one at a time; a request while running runs once more after
let running = false;
let again = false;
let failedCreates = new Set<string>(); // new events the Mac refused (said once; not retried until next launch)

export async function syncMacCalendars(): Promise<void> {
  if (!isApp()) return;
  if (running) return void (again = true);
  running = true;
  try {
    await once();
  } catch (e) {
    console.error('Calendars on this Mac:', e);
  } finally {
    running = false;
    if (again) {
      again = false;
      void syncMacCalendars();
    }
  }
}

async function once() {
  const host = await macHost();
  const mine = () => new Map(useStore.getState().calendars.filter((c) => c.mac?.host === host).map((c) => [c.id, c.mac!.id]));
  const macCals = mine();
  if (!macCals.size) return;
  if ((await macAccess()) !== 'full') return; // (Settings → Calendars says what to do)

  // the calendars themselves: name, colour, account, writable — as the Calendar app has them now
  const list = await macCalendarList();
  const st0 = useStore.getState();
  for (const c of st0.calendars.filter((x) => x.mac?.host === host)) {
    const now = list.find((x) => x.id === c.mac!.id);
    if (!now) continue; // (gone from the Mac: its events go below; the calendar stays, in case it comes back)
    if (now.title !== c.name || now.writable !== c.mac!.writable || now.account !== c.account)
      st0.addMacCalendar({ ...c, name: now.title, account: now.account, mac: { ...c.mac!, writable: now.writable } });
  }

  const from = startOfDay(Date.now()).getTime() - 60 * DAY;
  const window = { from, to: from + 460 * DAY };
  const mac = await invoke<MacEvent[]>('ek_events', { from: window.from, to: window.to, calendars: [...macCals.values()] });
  const known = useStore.getState().macKnown; // (saved with the app's data: a restored backup brings its own)

  // A calendar that comes back empty while Worldline has several of its events is more likely mid-refresh (iCloud
  // does this) than emptied: it sits this round out rather than flicker away and back.
  const inStep = mine();
  for (const [wid, macId] of inStep) {
    const here = useStore.getState().events.filter((e) => e.calendarId === wid && e.ext && e.start >= window.from && e.start < window.to).length;
    if (here > 5 && !mac.some((m) => m.calendar === macId)) inStep.delete(wid);
  }
  if (!inStep.size) return;

  // decide against Worldline's events as they are now (they may have changed while the Mac was answering)
  const before = useStore.getState().events;
  const plan = reconcile(before, mac, known, inStep, window, decodeEvent);
  if (plan.events.length !== before.length || plan.events.some((e, i) => e !== before[i])) useStore.getState().applySynced({ events: plan.events });

  // A brake: never delete more than a few events in the Calendar app in one go. Many at once means Worldline's data
  // jumped (an old backup restored, another device's data taken) rather than you deleting them one by one: they're
  // brought back here instead, and you're told.
  const deletes = plan.pushes.filter((p) => p.op === 'delete');
  if (deletes.length > MAX_DELETES) {
    plan.pushes = plan.pushes.filter((p) => p.op !== 'delete');
    for (const d of deletes) delete plan.known[d.key]; // (unknown again: the next look brings them back)
    useStore.getState().showToast(`Worldline didn’t delete ${deletes.length} events in the Calendar app all at once — they’re coming back here. Delete them in the Calendar app if you meant to.`, false);
    setTimeout(() => void syncMacCalendars(), 1000);
  }

  let pushed = false;
  for (const p of plan.pushes) {
    if (p.op === 'create' && failedCreates.has(p.localId)) continue;
    try {
      await push(p, plan.known);
      pushed = true;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 160);
      const title = p.op === 'delete' ? 'an event' : `“${p.save.title}”`;
      useStore.getState().showToast(`Couldn’t ${p.op === 'delete' ? 'delete' : 'save'} ${title} in the Calendar app: ${msg}`, false);
      if (p.op === 'save') plan.known[p.key] = p.fp; // next time the Calendar app's version comes back (no retry loop)
      if (p.op === 'create') failedCreates.add(p.localId);
    }
  }
  useStore.getState().setMacKnown(plan.known);
  if (pushed) setTimeout(() => void syncMacCalendars(), 2000); // read back what the Calendar app made of it
}

async function push(p: Push, known: Record<string, string>) {
  if (p.op === 'delete') {
    await invoke('ek_delete', { ext: p.ext, occ: p.occ, calendar: p.calendar });
    return;
  }
  if (p.op === 'save') {
    await invoke('ek_save', { event: p.save });
    known[p.key] = p.fp;
    return;
  }
  // new: create it, then tie Worldline's event to it (a repeating one: its occurrences come back on their own)
  const ext = await invoke<string>('ek_save', { event: p.save });
  const st = useStore.getState();
  const local = st.events.find((e) => e.id === p.localId);
  if (!local) return;
  if (p.repeating) {
    st.applySynced({ events: st.events.filter((e) => e.id !== p.localId && e.seriesId !== p.localId) });
    return;
  }
  const tied: CalEvent = { ...local, ext: { id: ext, occ: 0 } }; // (a one-off event: named by its identifier alone)
  st.applySynced({ events: st.events.map((e) => (e.id === p.localId ? tied : e)) });
  known[keyOf(tied.ext!)] = fingerprint(tied);
}

let started = false;
/** Start keeping Mac calendars in step (the Mac app, at launch). */
export function runMacCalendars() {
  if (started || !isApp()) return;
  started = true;
  void syncMacCalendars();
  setInterval(() => void syncMacCalendars(), 2 * 60_000);
  window.addEventListener('focus', () => void syncMacCalendars());
  // a change in one of those calendars here: saved to the Mac a moment later
  let t: ReturnType<typeof setTimeout> | undefined;
  useStore.subscribe((s, p) => {
    if (s.events === p.events && s.calendars === p.calendars) return;
    if (!s.calendars.some((c) => c.mac)) return;
    clearTimeout(t);
    t = setTimeout(() => void syncMacCalendars(), 1500);
  });
}
