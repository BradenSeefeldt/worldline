// Your app and several guests, end to end, over three in-memory relays (one of them down): publishing free/busy,
// a booking race, the app being closed while someone books, poll answers, deleting a link.
import { beforeAll, describe, expect, it } from 'vitest';
import { generateSecretKey, type Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { KIND, derive, newestAvail, openGuestMsg, parseFragment, guestUrl, resolveHolds, sealGuestMsg, withHolds, type BookedAgainst, type Decoded, type LinkRef } from '../lib/schedwire';
import { memoryTransport, type Transport } from '../lib/relays';
import { epochDay, instantOf } from '../lib/zone';

const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const noop = () => {};
Object.assign(globalThis, {
  localStorage,
  window: { innerWidth: 1200, localStorage, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop },
  document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
});
let useStore: typeof import('./store').useStore;
let startScheduleSync: typeof import('./schedSync').startScheduleSync;
beforeAll(async () => {
  ({ useStore } = await import('./store'));
  ({ startScheduleSync } = await import('./schedSync'));
});

// Every time is on the host's (Toronto) clock, whatever zone this machine is in.
const TZ = 'America/Toronto';
const t = (d: number, h: number, m = 0) => instantOf(2026, 9, d, h * 60 + m, TZ);
let now = t(7, 19, 10); // Wed Oct 7 2026, 7:10 PM
const clock = () => now;
const sec = (ms: number) => Math.floor(ms / 1000);

/** Several relays as one network: publish to all (count who accepted), read from all, ignore duplicates. */
function network(...relays: Transport[]): Transport {
  return {
    publish: async (ev) => (await Promise.all(relays.map((r) => r.publish(ev)))).reduce((a, b) => a + b, 0),
    send: async (ev) => (await Promise.all(relays.map((r) => r.publish(ev)))).some((n) => n > 0),
    query: async (f: Filter) => [...new Map((await Promise.all(relays.map((r) => r.query(f)))).flat().map((e) => [e.id, e])).values()],
    subscribe: (f, on) => {
      const seen = new Set<string>();
      const offs = relays.map((r) => r.subscribe(f, (e) => !seen.has(e.id) && (seen.add(e.id), on(e))));
      return () => offs.forEach((o) => o());
    },
  };
}
const relays = [memoryTransport(), memoryTransport(), memoryTransport({ down: true })];
const net = network(...relays);

/** The version of the times each link's guest page last saw (a booking quotes it, as the real page does). */
const seenVersion = new Map<string, BookedAgainst>();
/** What a guest's page does: read the link from the address, fetch the free/busy and everyone's messages. */
async function guestLooks(url: string) {
  const ref = parseFragment(url.split('#')[1])!;
  const { availTag, msgTag } = derive(ref.secret);
  const avail = newestAvail(await net.query({ kinds: [KIND], authors: [ref.hostPk], '#d': [availTag] }), ref)!;
  if (avail?.view.tok) seenVersion.set(ref.hostPk, { at: avail.at, tok: avail.view.tok });
  const msgs = (await net.query({ kinds: [KIND], '#d': [msgTag] })).map((e) => openGuestMsg(e, ref)).filter((d): d is Decoded => !!d);
  return { ref, view: avail?.view, msgs };
}
const book = (ref: LinkRef, start: number, at: number, name?: string) => {
  const sk = generateSecretKey();
  const av = seenVersion.get(ref.hostPk);
  const ev = sealGuestMsg({ t: 'book', start, name, av }, ref, sk, Math.max(at, (av?.at ?? 0) + 1)); // as the page does: never before that version
  return { sk, ev, send: () => net.publish(ev) };
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('scheduling between computers, end to end', () => {
  let url = '';
  let linkId = '';
  let engine: ReturnType<typeof startScheduleSync>;

  it('a new link is published (encrypted) to the relays that are up', async () => {
    const st = useStore.getState();
    st.startFresh();
    st.setMyName('Sam');
    linkId = st.createLink('book');
    const days = [8, 9].map((d) => epochDay(2026, 9, d));
    st.updateLink(linkId, { title: 'Chat', days, firstDay: days[0], lastDay: days[1], singleUse: false, timeZone: TZ });
    engine = startScheduleSync(net, clock);
    await engine.tick();
    const link = useStore.getState().links.find((l) => l.id === linkId)!;
    url = guestUrl('https://example.github.io/worldline/', link.nostr!);
    expect(relays[0].events).toHaveLength(1);
    expect(relays[2].events).toHaveLength(0); // the dead relay simply missed it
    const { view } = await guestLooks(url);
    expect(view.title).toBe('Chat');
    expect(view.hostName).toBe('Sam');
    expect(view.days[0].slots).toContain(t(8, 11));
    expect(useStore.getState().linkSync[linkId].relays).toBe(2);
  });

  it('two guests click the same time at once: both pages and the app agree who got it', async () => {
    const { ref } = await guestLooks(url);
    const at = seenVersion.get(ref.hostPk)!.at + 1; // as a real page does: after the version it booked against
    const kai = book(ref, t(8, 11), at, 'Kai');
    const jo = book(ref, t(8, 11), at + 1, 'Jordan');
    await jo.send();
    await kai.send();
    // before the app has answered, each guest page sees Kai holding it
    const { view, msgs } = await guestLooks(url);
    const holds = resolveHolds(view, msgs, now);
    expect(holds.winners.map((h) => h.pk)).toEqual([kai.ev.pubkey]);
    expect(holds.losers.map((h) => h.pk)).toEqual([jo.ev.pubkey]);
    expect(withHolds(view, holds.winners, new Set(), now).days[0].slots).not.toContain(t(8, 11)); // a third guest can't pick it
    // the app collects them (a minute later: the requests' clocks are ahead of this frozen one, which would count them as made "now")
    now += 60_000;
    engine.process();
    const s = useStore.getState();
    const booked = s.events.filter((e) => e.bookedVia === linkId);
    expect(booked.map((e) => [e.title, e.start])).toEqual([['Chat · Kai', t(8, 11)]]);
    expect(s.toast?.text).toContain('Kai booked “Chat”');
    const link = s.links.find((l) => l.id === linkId)!;
    expect(link.decisions?.[kai.ev.pubkey].status).toBe('ok');
    expect(link.decisions?.[jo.ev.pubkey].status).toBe('taken');
    // ...and publishes its answer: Kai's page says confirmed, Jordan's says taken, the slot is gone for everyone
    await engine.tick();
    const after = await guestLooks(url);
    expect(after.view.decisions[kai.ev.pubkey].status).toBe('ok');
    expect(after.view.decisions[jo.ev.pubkey].status).toBe('taken');
    expect(after.view.days[0].slots).not.toContain(t(8, 11));
    expect(after.view.days[0].slots).not.toContain(t(8, 10, 30)); // the 1-h meeting starting 10:30 would overlap
  });

  it('restarting the app never books the same request twice', async () => {
    engine.stop();
    engine = startScheduleSync(net, clock);
    await engine.tick();
    engine.process();
    expect(useStore.getState().events.filter((e) => e.bookedVia === linkId)).toHaveLength(1);
  });

  it('the app closed for days: a booking made meanwhile is collected when it opens; a time that became busy is refused', async () => {
    engine.stop();
    const { ref } = await guestLooks(url);
    const ana = book(ref, t(9, 14), sec(now) + 60, 'Ana');
    const lee = book(ref, t(9, 10), sec(now) + 61);
    await ana.send();
    await lee.send();
    // meanwhile a subscribed calendar puts something at 10 on Friday (the app hasn't republished; Lee couldn't know)
    const cal = useStore.getState().calendars[0].id;
    useStore.setState((s) => ({ events: [...s.events, { id: 'x', calendarId: cal, title: 'Seminar', start: t(9, 10), end: t(9, 11), allDay: false }] }));
    now += 2 * 86_400_000; // two days later (Friday evening — both meetings have passed)
    engine = startScheduleSync(net, clock);
    await settle();
    engine.process();
    const s = useStore.getState();
    expect(s.events.some((e) => e.title === 'Chat · Ana' && e.start === t(9, 14))).toBe(true);
    expect(s.toast?.text).toMatch(/while you were away/);
    const link = s.links.find((l) => l.id === linkId)!;
    expect(link.decisions?.[lee.ev.pubkey].status).toBe('busy');
    now -= 2 * 86_400_000;
  });

  it('an undo of an earlier edit doesn’t remove a guest’s booking', async () => {
    const st = useStore.getState();
    st.createEvent({ calendarId: st.calendars[0].id, title: 'Mine', start: t(12, 9), end: t(12, 10), allDay: false });
    const { ref } = await guestLooks(url);
    await book(ref, t(8, 15), sec(now) + 120, 'Max').send();
    engine.process();
    useStore.getState().undo();
    const evs = useStore.getState().events;
    expect(evs.some((e) => e.title === 'Mine')).toBe(false);
    expect(evs.some((e) => e.title === 'Chat · Max')).toBe(true);
  });

  it('someone who scraped the host key but not the link can’t book', async () => {
    const { ref } = await guestLooks(url);
    const outsider = { ...ref, secret: crypto.getRandomValues(new Uint8Array(32)) };
    const ev = sealGuestMsg({ t: 'book', start: t(8, 16) }, outsider, generateSecretKey(), sec(now));
    await net.publish({ ...ev, tags: [['d', derive(ref.secret).msgTag]] } as Event); // even with the right tag (breaks the signature)
    await net.publish(ev);
    engine.process();
    expect(useStore.getState().events.some((e) => e.bookedVia === linkId && e.start === t(8, 16))).toBe(false);
  });

  it('a group poll: answers arrive, one per person, into the results', async () => {
    const st = useStore.getState();
    const pollId = st.createLink('poll');
    const days = [12, 13].map((d) => epochDay(2026, 9, d));
    st.updateLink(pollId, { title: 'Group meeting', days, firstDay: days[0], lastDay: days[1], timeZone: TZ });
    await engine.tick();
    const purl = guestUrl('https://x/', useStore.getState().links.find((l) => l.id === pollId)!.nostr!);
    const { ref, view } = await guestLooks(purl);
    expect(view.mode).toBe('poll');
    const jordan = generateSecretKey();
    await net.publish(sealGuestMsg({ t: 'poll', name: 'Jordan', cells: [t(12, 9), t(12, 9, 30)] }, ref, jordan, sec(now)));
    await net.publish(sealGuestMsg({ t: 'poll', name: 'Kai', cells: [t(12, 9)] }, ref, generateSecretKey(), sec(now)));
    await net.publish(sealGuestMsg({ t: 'poll', name: 'Jordan', cells: [t(13, 14)] }, ref, jordan, sec(now) + 5)); // changed their mind
    await settle();
    engine.process();
    const link = useStore.getState().links.find((l) => l.id === pollId)!;
    expect(link.responses.map((r) => [r.name, r.cells])).toEqual([['Kai', [t(12, 9)]], ['Jordan', [t(13, 14)]]]);
    // other guests see both answers on their page
    const g = await guestLooks(purl);
    expect(g.msgs.filter((m) => m.msg.t === 'poll')).toHaveLength(2); // the relay kept only Jordan's newest
  });

  it('deleting a link tells anyone who opens it that it’s closed', async () => {
    useStore.getState().deleteLink(linkId);
    await settle();
    await settle();
    const { view } = await guestLooks(url);
    expect(view.gone).toBe(true);
    expect(view.days).toEqual([]);
    engine.stop();
  });
});

describe('cancelling', () => {
  it('deleting a booked meeting tells the guest it was cancelled; deleting the link removes its upcoming meetings', async () => {
    const st = useStore.getState();
    const id = st.createLink('book');
    const days = [14, 15].map((d) => epochDay(2026, 9, d));
    st.updateLink(id, { title: 'Cancel test', days, firstDay: days[0], lastDay: days[1], singleUse: false, timeZone: TZ });
    const engine = startScheduleSync(net, clock);
    await engine.tick();
    const url = guestUrl('https://x/', useStore.getState().links.find((l) => l.id === id)!.nostr!);
    const { ref } = await guestLooks(url);
    const a = book(ref, t(14, 10), sec(now), 'Ana');
    const b = book(ref, t(15, 10), sec(now), 'Ben');
    await a.send();
    await b.send();
    await settle();
    engine.process();
    const evs = () => useStore.getState().events.filter((e) => e.bookedVia === id);
    expect(evs()).toHaveLength(2);
    // you delete Ana's meeting from the calendar: her page now says cancelled, Ben's still confirmed
    useStore.getState().deleteEvent(evs().find((e) => e.title.includes('Ana'))!.id);
    await engine.tick();
    let v = (await guestLooks(url)).view;
    expect(v.decisions[a.ev.pubkey].status).toBe('cancelled');
    expect(v.decisions[b.ev.pubkey].status).toBe('ok');
    // you delete the link: Ben's upcoming meeting goes too, and the closed notice says it's cancelled
    useStore.getState().deleteLink(id);
    expect(evs()).toHaveLength(0);
    await settle();
    await settle();
    v = (await guestLooks(url)).view;
    expect(v.gone).toBe(true);
    expect(v.decisions[b.ev.pubkey].status).toBe('cancelled');
    engine.stop();
  });

  it('past meetings stay when their link is deleted (a record of what happened)', () => {
    const st = useStore.getState();
    const id = st.createLink('book');
    const cal = st.calendars[0].id;
    useStore.setState((s) => ({ events: [...s.events, { id: 'past-one', calendarId: cal, title: 'Old', start: Date.now() - 86_400_000, end: Date.now() - 82_800_000, allDay: false, bookedVia: id }] }));
    useStore.getState().deleteLink(id);
    expect(useStore.getState().events.some((e) => e.id === 'past-one')).toBe(true);
  });
});

describe('a link deleted or re-addressed while offline (M9)', () => {
  const setDown = (down: boolean) => relays.slice(0, 2).forEach((r) => ((r as { down: boolean }).down = down));
  async function newLink(title: string) {
    const st = useStore.getState();
    const id = st.createLink('book');
    const days = [14, 15].map((d) => epochDay(2026, 9, d));
    st.updateLink(id, { title, days, firstDay: days[0], lastDay: days[1], singleUse: false, timeZone: TZ });
    return id;
  }
  const urlOf = (id: string) => guestUrl('https://x/', useStore.getState().links.find((l) => l.id === id)!.nostr!);

  it('deleted with every relay down: guests are told it’s closed once a relay is back', async () => {
    const id = await newLink('Offline delete');
    const engine = startScheduleSync(net, clock);
    await engine.tick();
    const url = urlOf(id);
    setDown(true);
    useStore.getState().deleteLink(id);
    await settle();
    await settle();
    setDown(false);
    expect((await guestLooks(url)).view.gone).toBe(false); // nothing got out yet
    await engine.tick();
    expect((await guestLooks(url)).view.gone).toBe(true);
    engine.stop();
  });

  it('…even if the app was quit and restarted in between (the notice is kept on disk)', async () => {
    const id = await newLink('Offline re-address');
    let engine = startScheduleSync(net, clock);
    await engine.tick();
    const url = urlOf(id);
    setDown(true);
    useStore.getState().resetLinkKeys(id); // "New address"
    await settle();
    await settle();
    engine.stop();
    setDown(false);
    engine = startScheduleSync(net, clock);
    await engine.tick();
    expect((await guestLooks(url)).view.gone).toBe(true);
    expect((await guestLooks(urlOf(id))).view.gone).toBe(false); // the new address works
    engine.stop();
  });
});
