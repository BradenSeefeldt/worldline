// Your app's side of scheduling links over the relays. While Worldline runs it:
//   · publishes each open link's free/busy (its `publicView`, encrypted) whenever it changes, and every few hours
//     anyway (so relays keep it and guests can see it's current);
//   · listens for guests' bookings and poll answers, adds booked meetings to your calendar (toast), gathers answers;
//   · publishes its decision on each booking back, so the guest's page can say "confirmed" or "that time was taken";
//   · when a link is deleted or given a new address, publishes a final "closed" notice for the old one.
// Nothing here decides anything itself: the rules are pure functions in lib/schedwire.ts.
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Event } from 'nostr-tools/pure';
import { useStore } from './store';
import { expand } from '../lib/recurrence';
import { isFinished, linkSpan, publicView, type BookingLink } from '../lib/booking';
import { KIND, derive, liveDecisions, mergeResponses, nextCreatedAt, openGuestMsg, planBookings, refOf, sealAvail, type Decoded } from '../lib/schedwire';
import { RELAYS, loadRelayList, relayTransport, type Transport } from '../lib/relays';

const HEARTBEAT = 3 * 3_600_000; // republish at least this often while the app runs
const fmt = (t: number) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Links that are still taking bookings / answers (a finished one's last state is already out there). */
const live = (l: BookingLink, now: number) => !!l.nostr && !isFinished(l, now);

export function startScheduleSync(t: Transport = relayTransport(), clock = () => Date.now()) {
  const st = useStore.getState;
  const published = new Map<string, string>(); // link id → what was last published (without its timestamp)
  const publishedAt = new Map<string, number>();
  const inbox = new Map<string, Map<string, Decoded>>(); // link id → guest key → newest message
  const notices: string[] = [];
  let toastEvent: string | undefined;
  let stopSub: (() => void) | null = null;
  let subKey = '';
  let tickTimer = 0;
  let processTimer = 0;
  let stopped = false;

  const viewOf = (l: BookingLink, now: number) => {
    const { from, to } = linkSpan(l);
    return publicView(l, expand(st().events, from, to), now, st().myName);
  };

  async function publish(l: BookingLink, keys: NonNullable<BookingLink['nostr']>, gone = false) {
    const now = clock();
    const view = viewOf(l, now);
    const opts = { noticeMin: l.noticeMin, singleUse: !!l.singleUse, decisions: liveDecisions(l.decisions, l.durationMin, now), gone };
    const sig = JSON.stringify([view.days, view.title, view.hostName, view.durationMin, view.location, view.note, view.closed, view.finalStart, opts]);
    if (!gone && published.get(l.id) === sig && now - (publishedAt.get(l.id) ?? 0) < HEARTBEAT) return;
    const createdAt = nextCreatedAt(now, keys.lastPub);
    published.set(l.id, sig); // claimed now, so an overlapping tick doesn't publish the same thing twice
    publishedAt.set(l.id, now);
    if (!gone) st().setLinkPub(l.id, createdAt);
    const relays = await t.publish(sealAvail(view, keys, { ...opts, updatedAt: now }, createdAt));
    if (gone) return;
    if (!relays) {
      published.delete(l.id); // try again next time
      st().setLinkSync(l.id, { relays: 0, total: t.size ?? RELAYS.length, at: now, error: 'offline' });
    } else st().setLinkSync(l.id, { relays, total: t.size ?? RELAYS.length, at: now });
  }

  /** Publish what changed; (re)subscribe if the set of open links changed. */
  async function tick() {
    if (stopped) return;
    const now = clock();
    for (const l of st().links) if (!l.nostr && !isFinished(l, now)) st().ensureLinkKeys(l.id);
    const links = st().links.filter((l) => live(l, now));
    resubscribe(links);
    await Promise.all(links.map((l) => publish(l, l.nostr!).catch(() => undefined)));
  }
  const soon = (ms = 1500) => {
    clearTimeout(tickTimer);
    tickTimer = window.setTimeout(() => void tick(), ms);
  };

  function resubscribe(links: BookingLink[], force = false) {
    const tags = new Map(links.map((l) => [derive(hexToBytes(l.nostr!.secret)).msgTag, l.id]));
    const key = [...tags.keys()].sort().join(',');
    if (key === subKey && !force) return;
    stopSub?.();
    stopSub = null;
    subKey = key;
    if (!tags.size) return;
    stopSub = t.subscribe({ kinds: [KIND], '#d': [...tags.keys()] }, (ev: Event) => {
      const id = tags.get(ev.tags.find((x) => x[0] === 'd')?.[1] ?? '');
      const l = id && st().links.find((x) => x.id === id);
      if (!l || !l.nostr) return;
      const d = openGuestMsg(ev, refOf(l.nostr), hexToBytes(l.nostr.sk));
      if (!d) return; // not from someone with the link, or damaged
      const box = inbox.get(l.id) ?? new Map<string, Decoded>();
      const cur = box.get(d.pk);
      if (cur && (cur.at > d.at || (cur.at === d.at && cur.id <= d.id))) return;
      box.set(d.pk, d);
      inbox.set(l.id, box);
      clearTimeout(processTimer);
      processTimer = window.setTimeout(process, 600); // a burst (stored events on startup) is handled together
    });
  }

  function process() {
    const now = clock();
    for (const [id, box] of inbox) {
      const l = st().links.find((x) => x.id === id);
      if (!l || !live(l, now)) continue;
      const msgs = [...box.values()];
      const { from, to } = linkSpan(l);
      if (l.mode === 'book') {
        const { accepts, decisions } = planBookings(l, expand(st().events, from - 86_400_000, to + 86_400_000), msgs, now);
        if (!Object.keys(decisions).length) continue;
        const ids = st().applyRemoteBookings(l.id, accepts, decisions);
        accepts.forEach((a, i) => {
          notices.push(`${a.name || 'Someone'} booked “${l.title}” · ${fmt(a.start)}${a.start < now ? ' (while you were away)' : ''}`);
          toastEvent = ids[i];
        });
        for (const [pk, d] of Object.entries(decisions))
          if (d.status === 'busy') notices.push(`Couldn’t book ${fmt(d.start)} on “${l.title}”: you’re busy then now. ${msgs.find((m) => m.pk === pk && m.msg.t === 'book' && m.msg.name) ? 'They' : 'The guest'} will see it on the link’s page.`);
      } else {
        const offered = new Set(viewOf(l, now).days.flatMap((d) => d.slots));
        const { responses, changed } = mergeResponses(l, msgs, offered);
        if (!changed.length) continue;
        st().setPollResponses(l.id, responses);
        notices.push(changed.length === 1 ? `${changed[0]} answered your poll “${l.title}”` : `${changed.length} new answers on your poll “${l.title}”`);
      }
    }
    if (notices.length) {
      st().showToast(notices.length === 1 ? notices[0] : `${notices[0]} · and ${notices.length - 1} more`, false, toastEvent);
      notices.length = 0;
      toastEvent = undefined;
    }
  }

  // A link deleted or given a new address: tell anyone who opens the old address that it's closed.
  const unsubStore = useStore.subscribe((s, prev) => {
    if (s.links !== prev.links) {
      const now = clock();
      for (const old of prev.links) {
        if (!old.nostr || isFinished(old, now)) continue;
        const cur = s.links.find((l) => l.id === old.id);
        if (!cur || cur.nostr?.secret !== old.nostr.secret) {
          void publish({ ...old, closed: true }, old.nostr, true).catch(() => undefined);
          published.delete(old.id);
        }
      }
    }
    if (s.links !== prev.links || s.events !== prev.events || s.myName !== prev.myName) soon();
  });

  // Woken up / back online: sockets may have died while asleep — reconnect and catch up.
  const wake = () => {
    if (stopped) return;
    resubscribe(st().links.filter((l) => live(l, clock())), true);
    soon(500);
  };
  const minute = window.setInterval(() => void tick(), 60_000); // time passing: slots in the past drop off; heartbeat
  window.addEventListener('online', wake);
  const onVis = () => document.visibilityState === 'visible' && wake();
  document.addEventListener?.('visibilitychange', onVis);
  void tick();

  return {
    tick,
    process,
    stop() {
      stopped = true;
      stopSub?.();
      unsubStore();
      clearInterval(minute);
      clearTimeout(tickTimer);
      clearTimeout(processTimer);
      window.removeEventListener('online', wake);
      document.removeEventListener?.('visibilitychange', onVis);
    },
  };
}

/** The relay list on the project's GitHub Pages (kept current by a weekly check — lib/relaylist.ts). */
const RELAY_LIST = import.meta.env.DEV ? '/relays.json' : 'https://bradenseefeldt.github.io/worldline/relays.json';

/** Start syncing on the current relay list; look at the list again every 6 hours and move to the new relays if it
 *  changed (everything is republished there; nothing to restart). */
export async function runScheduling() {
  let relays = (await loadRelayList(RELAY_LIST))?.relays ?? RELAYS;
  let t = relayTransport(relays);
  let engine = startScheduleSync(t);
  window.setInterval(async () => {
    const next = (await loadRelayList(RELAY_LIST))?.relays;
    if (!next || next.join() === relays.join()) return;
    engine.stop();
    t.close?.();
    relays = next;
    t = relayTransport(relays);
    engine = startScheduleSync(t);
  }, 6 * 3_600_000);
}
