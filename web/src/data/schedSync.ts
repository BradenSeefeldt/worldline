// Your app's side of scheduling links over the relays. While Worldline runs it:
//   · publishes each open link's free/busy (its `publicView`, encrypted) whenever it changes, and every few hours
//     anyway (so relays keep it and guests can see it's current);
//   · listens for guests' bookings and poll answers, adds booked meetings to your calendar (toast), gathers answers;
//   · publishes its decision on each booking back, so the guest's page can say "confirmed" or "that time was taken";
//   · when a link is deleted or given a new address, publishes a final "closed" notice for the old one — kept (in the
//     app's database, beside its data) and sent again until at least one relay has taken it, so a link deleted while
//     offline still tells guests it's closed once the app is back online, even after a restart.
// Nothing here decides anything itself: the rules are pure functions in lib/schedwire.ts.
import { hexToBytes } from '@noble/hashes/utils.js';
import type { Event } from 'nostr-tools/pure';
import { useStore } from './store';
import { sideStore } from './persist';
import { expand } from '../lib/recurrence';
import { isFinished, linkSpan, publicView, type BookingLink } from '../lib/booking';
import { KIND, derive, publishedDecisions, mergeResponses, nextCreatedAt, openGuestMsg, planBookings, refOf, sealAvail, type Decision, type Decoded } from '../lib/schedwire';
import { RELAYS, loadRelayList, relayTransport, type Transport } from '../lib/relays';
import { fmtWhen } from '../lib/format';

const HEARTBEAT = 3 * 3_600_000; // republish at least this often while the app runs
const GONE_KEY = 'wl-sched-gone'; // the "closed" notices not yet taken by any relay (signed events, no secrets)
const fmt = fmtWhen;

/** Links that are still taking bookings / answers (a finished one's last state is already out there). */
const live = (l: BookingLink, now: number) => !!l.nostr && !isFinished(l, now);

export function startScheduleSync(t: Transport = relayTransport(), clock = () => Date.now()) {
  const st = useStore.getState;
  const published = new Map<string, string>(); // link id → what was last published (without its timestamp)
  const publishedAt = new Map<string, number>();
  const inbox = new Map<string, Map<string, Decoded>>(); // link id → guest key → newest message
  // answers made while running, even ones the store no longer keeps (junk it prunes), so they aren't made again
  const answered = new Map<string, Record<string, Decision>>();
  // "closed" notices for deleted / re-addressed links, until a relay takes each one
  let gone: { id: string; ev: Event }[] = [];
  const goneLoaded = sideStore
    .get(GONE_KEY)
    .then((v) => {
      const saved = (v ? (JSON.parse(v) as { id: string; ev: Event }[]) : []).filter((g) => g && g.ev && typeof g.ev.id === 'string');
      gone = [...saved.filter((g) => !gone.some((x) => x.ev.id === g.ev.id)), ...gone];
    })
    .catch(() => undefined);
  const saveGone = () => void sideStore.set(GONE_KEY, JSON.stringify(gone)).catch(() => undefined);
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

  async function publish(l: BookingLink, keys: NonNullable<BookingLink['nostr']>) {
    const now = clock();
    const view = viewOf(l, now);
    const opts = { noticeMin: l.noticeMin, singleUse: !!l.singleUse, decisions: publishedDecisions(l, st().events, now) };
    const sig = JSON.stringify([view.days, view.title, view.hostName, view.durationMin, view.location, view.note, view.closed, view.finalStart, opts]);
    if (published.get(l.id) === sig && now - (publishedAt.get(l.id) ?? 0) < HEARTBEAT) return;
    const createdAt = nextCreatedAt(now, keys.lastPub);
    published.set(l.id, sig); // claimed now, so an overlapping tick doesn't publish the same thing twice
    publishedAt.set(l.id, now);
    st().setLinkPub(l.id, createdAt);
    const relays = await t.publish(sealAvail(view, keys, { ...opts, updatedAt: now }, createdAt));
    if (!relays) {
      published.delete(l.id); // try again next time
      st().setLinkSync(l.id, { relays: 0, total: t.size ?? RELAYS.length, at: now, error: 'offline' });
    } else st().setLinkSync(l.id, { relays, total: t.size ?? RELAYS.length, at: now });
  }

  /** A deleted or re-addressed link's last word: "closed" (and "cancelled" for its upcoming meetings). Signed now and
   *  kept until a relay takes it. */
  function closeOld(old: BookingLink, keys: NonNullable<BookingLink['nostr']>) {
    const now = clock();
    const l = { ...old, closed: true };
    const opts = { noticeMin: l.noticeMin, singleUse: !!l.singleUse, decisions: publishedDecisions(l, st().events, now), gone: true, updatedAt: now };
    gone = [...gone.filter((g) => g.id !== old.id), { id: old.id, ev: sealAvail(viewOf(l, now), keys, opts, nextCreatedAt(now, keys.lastPub)) }];
    saveGone();
    void sendGone();
  }
  /** Send each "closed" notice no relay has taken yet; forget the ones that got through. */
  async function sendGone() {
    await goneLoaded;
    for (const g of gone) {
      if (stopped) return;
      if ((await t.publish(g.ev).catch(() => 0)) > 0 && gone.includes(g)) {
        gone = gone.filter((x) => x !== g);
        saveGone();
      }
    }
  }

  /** Publish what changed; (re)subscribe if the set of open links changed. */
  async function tick() {
    if (stopped) return;
    const now = clock();
    for (const l of st().links) if (!l.nostr && !isFinished(l, now)) st().ensureLinkKeys(l.id);
    const links = st().links.filter((l) => live(l, now));
    resubscribe(links);
    await Promise.all([...links.map((l) => publish(l, l.nostr!).catch(() => undefined)), sendGone()]);
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
    let stored = false; // the relays have sent what they had stored: from here on, messages are arriving live
    stopSub = t.subscribe({ kinds: [KIND], '#d': [...tags.keys()] }, (ev: Event) => {
      const id = tags.get(ev.tags.find((x) => x[0] === 'd')?.[1] ?? '');
      const l = id && st().links.find((x) => x.id === id);
      if (!l || !l.nostr) return;
      const opened = openGuestMsg(ev, refOf(l.nostr), hexToBytes(l.nostr.sk));
      if (!opened) return; // not from someone with the link, or damaged
      const d = stored ? { ...opened, seen: Math.floor(clock() / 1000) } : opened; // seen live: when it arrived counts
      const box = inbox.get(l.id) ?? new Map<string, Decoded>();
      const cur = box.get(d.pk);
      if (cur && (cur.at > d.at || (cur.at === d.at && cur.id <= d.id))) return;
      box.set(d.pk, d);
      inbox.set(l.id, box);
      clearTimeout(processTimer);
      processTimer = window.setTimeout(process, 600); // a burst (stored events on startup) is handled together
    }, () => (stored = true));
  }

  function process() {
    const now = clock();
    for (const [id, box] of inbox) {
      const l = st().links.find((x) => x.id === id);
      if (!l || !live(l, now)) continue;
      const msgs = [...box.values()];
      const { from, to } = linkSpan(l);
      if (l.mode === 'book') {
        const known = { ...l, decisions: { ...answered.get(l.id), ...l.decisions } };
        const { accepts, decisions } = planBookings(known, expand(st().events, from - 86_400_000, to + 86_400_000), msgs, now);
        if (!Object.keys(decisions).length) continue;
        answered.set(l.id, { ...answered.get(l.id), ...decisions });
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
          closeOld(old, old.nostr);
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
const RELAY_LIST = import.meta.env.DEV ? '/relays.json' : 'https://worldline-calendar.github.io/worldline/relays.json';

/** Start syncing on the current relay list; look at the list again every 6 hours and move to the new relays if it
 *  changed (everything is republished there; nothing to restart). */
let current: { transport: Transport; updated: string } | null = null;
/** For Settings → Scheduling: each relay in use and whether it's connected, and when the list was last updated. */
export const relayHealth = () => ({ relays: current?.transport.health?.() ?? [], updated: current?.updated ?? '' });

export async function runScheduling() {
  const list = await loadRelayList(RELAY_LIST);
  let relays = list?.relays ?? RELAYS;
  let t = relayTransport(relays);
  current = { transport: t, updated: list?.updated ?? '' };
  let engine = startScheduleSync(t);
  window.setInterval(async () => {
    const fresh = await loadRelayList(RELAY_LIST);
    const next = fresh?.relays;
    if (!next || next.join() === relays.join()) return;
    engine.stop();
    t.close?.();
    relays = next;
    t = relayTransport(relays);
    current = { transport: t, updated: fresh?.updated ?? '' };
    engine = startScheduleSync(t);
  }, 6 * 3_600_000);
}
