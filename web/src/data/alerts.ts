// Reminders, delivered. Which alerts are due comes from lib/alerts.ts; this hands them to whatever can show them:
//   · the Mac app: the next day's alerts go to the native side (src-tauri/src/lib.rs → set_alerts), which shows each as
//     a Mac notification at its time — even while the window is hidden. Sent again whenever events or settings change,
//     and every 30 minutes (to reach further ahead).
//   · the iPhone / web version: only while it's open (a web page can't wake itself up later): a timer per alert, shown
//     in the app and, if allowed, as a notification.
import { useStore } from './store';
import { upcomingAlerts, type Alert } from '../lib/alerts';
import { isApp } from '../lib/platform';

const AHEAD = 26 * 3_600_000;
const LATE = 5 * 60_000; // a reminder up to 5 minutes late is still shown (the app was just opened, the Mac woke up)

const due = (now = Date.now()) => {
  const s = useStore.getState();
  return upcomingAlerts(s.events, s.calendars, s.settings, now - LATE, now + AHEAD);
};

// ---- the Mac app
async function sendToMac() {
  const { invoke } = await import('@tauri-apps/api/core');
  // (whole milliseconds: the native side reads an integer)
  await invoke('set_alerts', { alerts: due().map(({ key, at, title, body }) => ({ key, at: Math.round(at), title, body })) });
}

// ---- the web version
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const shown = new Set<string>();
async function show(a: Alert) {
  if (shown.has(a.key)) return;
  shown.add(a.key);
  useStore.getState().showToast(`🔔 ${a.title} · ${a.body}`, false);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    if (reg) await reg.showNotification(a.title, { body: a.body, tag: a.key }).catch(() => undefined);
    else new Notification(a.title, { body: a.body, tag: a.key });
  }
}
function scheduleHere() {
  const now = Date.now();
  const list = due(now);
  const keys = new Set(list.map((a) => a.key));
  for (const [k, t] of timers) if (!keys.has(k)) (clearTimeout(t), timers.delete(k));
  for (const a of list) {
    if (timers.has(a.key) || shown.has(a.key)) continue;
    timers.set(a.key, setTimeout(() => (timers.delete(a.key), void show(a)), Math.max(0, a.at - now)));
  }
}

let started = false;
/** Start delivering reminders (once, at launch). */
export function runAlerts() {
  if (started) return;
  started = true;
  const push = () => (isApp() ? void sendToMac().catch((e) => console.error('Alerts:', e)) : scheduleHere());
  let t: ReturnType<typeof setTimeout> | undefined;
  const soon = () => (clearTimeout(t), (t = setTimeout(push, 1500)));
  push();
  if (isApp())
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<[string, string]>('alert', (e) => useStore.getState().showToast(`🔔 ${e.payload[0]} · ${e.payload[1]}`, false)),
    );
  useStore.subscribe((s, p) => (s.events !== p.events || s.calendars !== p.calendars || s.settings !== p.settings) && soon());
  setInterval(push, 30 * 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && push()); // (timers sleep with a hidden page)
}

/** Settings → Alerts: can this device show notifications, and ask if not yet decided. */
export async function notificationAccess(ask = false): Promise<'granted' | 'denied' | 'default' | 'unsupported'> {
  if (isApp()) {
    const n = await import('@tauri-apps/plugin-notification');
    if (await n.isPermissionGranted()) return 'granted';
    if (!ask) return 'default';
    return (await n.requestPermission()) === 'granted' ? 'granted' : 'denied';
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  if (ask && Notification.permission === 'default') await Notification.requestPermission();
  return Notification.permission;
}

/** Settings → Alerts → Send a test alert. */
export async function testAlert() {
  const title = 'Worldline';
  const body = 'Reminders are working — this is how they’ll look.';
  if (isApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('test_alert', { title, body });
  } else await show({ key: `test-${Date.now()}`, at: Date.now(), title, body, eventId: '' });
}
