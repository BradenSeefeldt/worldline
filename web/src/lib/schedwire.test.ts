import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { busyFor, newLink, publicView, type BookingLink } from './booking';
import {
  KIND, derive, fromWire, guestUrl, latestPerGuest, linkFragment, liveDecisions, mergeResponses, newLinkKeys, newestAvail, nextCreatedAt, openAvail,
  openGuestMsg, parseFragment, planBookings, refOf, resolveHolds, sealAvail, sealGuestMsg, toWire, withHolds, type Decoded, type RemoteView,
} from './schedwire';
import { epochDay } from './zone';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 9, 7, 19, 10).getTime(); // Wed Oct 7 2026, 7:10 PM (Toronto)
const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const sec = (ms: number) => Math.floor(ms / 1000);
const DAYS = [8, 9, 12].map((d) => epochDay(2026, 9, d));
const link = (extra: Partial<BookingLink> = {}): BookingLink => ({
  ...newLink({ id: 'L1', mode: 'book', hostName: 'Sam', calendars: [{ id: 'work', visible: true }], calendarId: 'work', timeZone: 'America/Toronto', now: NOW }),
  days: DAYS, firstDay: DAYS[0], lastDay: DAYS[2], singleUse: false, nostr: newLinkKeys(), ...extra,
});
const ev = (title: string, start: number, mins: number, extra: Partial<CalEvent> = {}): CalEvent => ({ id: title, calendarId: 'work', title, start, end: start + mins * 60_000, allDay: false, ...extra });
const remote = (l: BookingLink, events: CalEvent[] = [], extra: Partial<RemoteView> = {}): RemoteView => ({
  ...fromWire(toWire(publicView(l, events, NOW), { noticeMin: l.noticeMin, singleUse: !!l.singleUse, updatedAt: NOW, decisions: l.decisions }))!, ...extra,
});
/** A guest's booking request, as decoded. */
const req = (pk: string, start: number, at: number, id = `${pk}-id`): Decoded => ({ pk: pk.padEnd(64, '0'), id, at, msg: { t: 'book', start } });

describe('the link address', () => {
  it('carries the host key and secret after "#", and reads back exactly', () => {
    const keys = newLinkKeys();
    const url = guestUrl('https://example.github.io/worldline/', keys);
    const frag = url.split('#')[1];
    expect(frag).toHaveLength(87);
    expect(url.split('#')[0]).toBe('https://example.github.io/worldline/'); // nothing secret before the "#"
    const ref = parseFragment(`#${frag}`)!;
    expect(ref.hostPk).toBe(getPublicKey(hexToBytes(keys.sk)));
    expect(bytesToHex(ref.secret)).toBe(keys.secret);
  });
  it('a damaged or cut-short address is refused, not misread', () => {
    const frag = linkFragment(newLinkKeys());
    expect(parseFragment(frag.slice(0, 60))).toBeNull();
    expect(parseFragment(`${frag}x`)).toBeNull();
    expect(parseFragment('#/book/abc123')).toBeNull(); // an old same-computer link
    expect(parseFragment(`B${frag.slice(1)}`)).toBeNull(); // unknown version byte
  });
  it('each link gets its own keys, tags and encryption key', () => {
    const a = newLinkKeys(), b = newLinkKeys();
    expect(a.sk).not.toBe(b.sk);
    const da = derive(hexToBytes(a.secret)), db = derive(hexToBytes(b.secret));
    expect(da.availTag).not.toBe(db.availTag);
    expect(da.msgTag).not.toBe(da.availTag);
    expect(derive(hexToBytes(a.secret)).msgTag).toBe(da.msgTag); // deterministic
  });
});

describe('the published availability', () => {
  const secretEvents = [ev('Secret meeting with the dean', t(8, 10), 60)];
  it('round-trips to exactly the public view (times in absolute instants, so any zone reads them right)', () => {
    const l = link();
    const view = publicView(l, secretEvents, NOW);
    const sealed = sealAvail(view, l.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW }, sec(NOW));
    const got = openAvail(sealed, refOf(l.nostr!))!;
    expect(got.days).toEqual(view.days);
    expect(got.title).toBe(view.title);
    expect(got.hostName).toBe('Sam');
    expect(got.updatedAt).toBe(sec(NOW) * 1000);
  });
  it('relays see only ciphertext: no titles, no times, no names', () => {
    const l = link({ title: 'Office hours', location: 'Room 1203' });
    const sealed = sealAvail(publicView(l, secretEvents, NOW), l.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW }, sec(NOW));
    const raw = JSON.stringify(sealed);
    for (const s of ['dean', 'Office', 'Sam', '1203', String(Math.round(t(8, 9) / 60_000))]) expect(raw).not.toContain(s);
  });
  it('the plaintext itself never contains your events (the publicView rule still holds)', () => {
    const json = JSON.stringify(toWire(publicView(link(), secretEvents, NOW), { noticeMin: 0, singleUse: false, updatedAt: NOW }));
    expect(json).not.toContain('dean');
    expect(json).not.toContain('work');
  });
  it('without the secret it cannot be read; with someone else’s key it cannot be forged', () => {
    const l = link();
    const view = publicView(l, [], NOW);
    const sealed = sealAvail(view, l.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW }, sec(NOW));
    expect(openAvail(sealed, { ...refOf(l.nostr!), secret: hexToBytes(newLinkKeys().secret) })).toBeNull();
    // a guest knows the secret but not the host key: their "availability" is ignored
    const forger = { sk: newLinkKeys().sk, secret: l.nostr!.secret };
    expect(openAvail(sealAvail(view, forger, { noticeMin: 0, singleUse: false, updatedAt: NOW }, sec(NOW)), refOf(l.nostr!))).toBeNull();
    // tampering breaks the signature
    expect(openAvail({ ...sealed, content: sealed.content.slice(0, -4) + 'AAAA' }, refOf(l.nostr!))).toBeNull();
  });
  it('a two-month poll fits easily in one message', () => {
    const days = Array.from({ length: 60 }, (_, i) => DAYS[0] + i);
    const l = link({ mode: 'poll', days, windowStart: 0, windowEnd: 24 * 60 });
    const json = JSON.stringify(toWire(publicView(l, [], NOW), { noticeMin: 0, singleUse: false, updatedAt: NOW }));
    expect(json.length).toBeLessThan(20_000); // NIP-44 allows 65,535
    expect(fromWire(JSON.parse(json))!.days[59].cells).toHaveLength(48);
  });
  it('a daylight-saving day keeps its exact instants', () => {
    const nov1 = epochDay(2026, 10, 1); // clocks go back at 2 AM
    const l = link({ mode: 'poll', days: [nov1], windowStart: 0, windowEnd: 4 * 60 });
    const view = publicView(l, [], NOW);
    expect(fromWire(toWire(view, { noticeMin: 0, singleUse: false, updatedAt: NOW }))!.days[0].cells).toEqual(view.days[0].cells);
  });
  it('each publish is newer than the last, even after this Mac’s clock was set back', () => {
    expect(nextCreatedAt(NOW)).toBe(sec(NOW));
    expect(nextCreatedAt(NOW, sec(NOW) + 3600)).toBe(sec(NOW) + 3601); // clock was an hour fast last time
  });
  it('of several versions on different relays, the newest valid one wins', () => {
    const l = link();
    const old = sealAvail(publicView({ ...l, title: 'Old' }, [], NOW), l.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW }, 100);
    const cur = sealAvail(publicView({ ...l, title: 'New' }, [], NOW), l.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW }, 200);
    const junk = { ...cur, created_at: 300, id: 'f'.repeat(64) }; // unsigned "newer" one
    expect(newestAvail([cur, junk, old], refOf(l.nostr!))!.view.title).toBe('New');
  });
  it('a newer app’s extra fields don’t break the page; nonsense is rejected', () => {
    const w = { ...toWire(publicView(link(), [], NOW), { noticeMin: 0, singleUse: false, updatedAt: NOW }), v: 2, future: { x: 1 } };
    expect(fromWire(w)).not.toBeNull();
    expect(fromWire({ v: 1, mode: 'book' })).toBeNull();
    expect(fromWire({ ...w, days: [[1, ['x']]] })).toBeNull();
  });
});

describe('guests’ messages', () => {
  const l = link();
  const ref = refOf(l.nostr!);
  const hostSk = hexToBytes(l.nostr!.sk);
  it('a booking’s name is sealed to the host: other guests see the held time, not who', () => {
    const e = sealGuestMsg({ t: 'book', start: t(8, 11), name: 'Kai' }, ref, generateSecretKey(), sec(NOW));
    expect(openGuestMsg(e, ref)!.msg).toEqual({ t: 'book', start: t(8, 11) });
    expect(openGuestMsg(e, ref, hostSk)!.msg).toEqual({ t: 'book', start: t(8, 11), name: 'Kai' });
    expect(JSON.stringify(e)).not.toContain('Kai');
  });
  it('a poll answer round-trips (names are visible to the group, as on when2meet)', () => {
    const e = sealGuestMsg({ t: 'poll', name: ' Jordan ', cells: [t(8, 9), t(8, 9, 30)] }, ref, generateSecretKey(), sec(NOW));
    expect(openGuestMsg(e, ref)!.msg).toEqual({ t: 'poll', name: 'Jordan', cells: [t(8, 9), t(8, 9, 30)] });
  });
  it('someone without the link can’t book, even knowing the host’s public key', () => {
    const outsider = { ...ref, secret: hexToBytes(newLinkKeys().secret) };
    const e = sealGuestMsg({ t: 'book', start: t(8, 11) }, outsider, generateSecretKey(), sec(NOW));
    expect(openGuestMsg(e, ref, hostSk)).toBeNull();
    // right tag, but content encrypted to the host key alone (no link secret)
    const sk = generateSecretKey();
    const sneaky = finalizeEvent({ kind: KIND, created_at: sec(NOW), tags: [['d', derive(ref.secret).msgTag]], content: nip44.encrypt('{"v":1,"t":"book","s":1}', nip44.getConversationKey(sk, ref.hostPk)) }, sk);
    expect(openGuestMsg(sneaky, ref, hostSk)).toBeNull();
  });
  it('oversized or malformed messages are dropped', () => {
    const e = sealGuestMsg({ t: 'book', start: t(8, 11) }, ref, generateSecretKey(), sec(NOW));
    expect(openGuestMsg({ ...e, content: 'x'.repeat(200_000) }, ref)).toBeNull();
    const k = derive(ref.secret).key;
    const sk = generateSecretKey();
    const bad = finalizeEvent({ kind: KIND, created_at: sec(NOW), tags: [['d', derive(ref.secret).msgTag]], content: nip44.encrypt('{"v":1,"t":"poll","name":"x","c":["a"]}', k) }, sk);
    expect(openGuestMsg(bad, ref)).toBeNull();
  });
  it('only each guest’s newest message counts (a replaced answer, a cancelled booking)', () => {
    const a = req('aa', t(8, 11), 100), b = { ...req('aa', t(8, 13), 200, 'aa-2') };
    expect(latestPerGuest([b, a])).toEqual([b]);
  });
});

describe('who gets a slot', () => {
  const l = link({ durationMin: 60 });
  const view = remote(l);
  it('two guests, same time: the earlier request holds it, everywhere', () => {
    const { winners, losers } = resolveHolds(view, [req('bb', t(8, 11), 101), req('aa', t(8, 11), 100)], NOW);
    expect(winners.map((w) => w.pk[1])).toEqual(['a']);
    expect(losers.map((w) => w.pk[1])).toEqual(['b']);
  });
  it('an exact tie is broken by the event id, so every page agrees', () => {
    const r = resolveHolds(view, [req('aa', t(8, 11), 100, 'z'), req('bb', t(8, 11), 100, 'c')], NOW);
    expect(r.winners[0].id).toBe('c');
  });
  it('overlapping (not identical) times conflict too; separate ones don’t', () => {
    const r = resolveHolds(view, [req('aa', t(8, 11), 100), req('bb', t(8, 11, 30), 101), req('cc', t(8, 14), 102)], NOW);
    expect(r.winners.map((w) => w.pk[1])).toEqual(['a', 'c']);
  });
  it('a request for a time that isn’t offered holds nothing (junk can’t block real times)', () => {
    expect(resolveHolds(view, [req('aa', t(8, 3), 100)], NOW).winners).toEqual([]);
  });
  it('a single-use link: only the first request holds, and others see it closed', () => {
    const v = remote(link({ singleUse: true }));
    const { winners } = resolveHolds(v, [req('aa', t(8, 11), 100), req('bb', t(9, 14), 101)], NOW);
    expect(winners).toHaveLength(1);
    expect(withHolds(v, winners, new Set(), NOW).closed).toBe(true);
    expect(withHolds(v, winners, new Set([winners[0].pk]), NOW).closed).toBe(false); // the one who booked still sees their booking
  });
  it('requests your app already answered no longer hold anything', () => {
    const v = { ...view, decisions: { ['aa'.padEnd(64, '0')]: { id: 'aa-id', status: 'taken' as const, start: t(8, 11) } } };
    expect(resolveHolds(v, [req('aa', t(8, 11), 100)], NOW).winners).toEqual([]);
  });
  it('other people’s holds disappear from the times offered; your own stays', () => {
    const { winners } = resolveHolds(view, [req('aa', t(8, 11), 100)], NOW);
    const others = withHolds(view, winners, new Set(), NOW).days[0].slots;
    expect(others).not.toContain(t(8, 11));
    expect(others).not.toContain(t(8, 10, 30)); // a 1-h meeting at 10:30 would run into it
    expect(others).toContain(t(8, 12));
    expect(withHolds(view, winners, new Set([winners[0].pk]), NOW).days[0].slots).toContain(t(8, 11));
  });
  it('times already past (on the guest’s clock) aren’t offered, nor sooner than the notice', () => {
    const v = remote(link({ noticeMin: 60 }));
    const later = t(8, 10);
    const slots = withHolds(v, [], new Set(), later).days.flatMap((d) => d.slots);
    expect(Math.min(...slots)).toBeGreaterThanOrEqual(later + 3_600_000);
  });
});

describe('your app answers the requests', () => {
  const l = link({ durationMin: 60 });
  it('accepts a free time; refuses one that became busy since the guest looked', () => {
    const r = planBookings(l, [ev('Dentist', t(8, 14), 60)], [req('aa', t(8, 11), sec(NOW)), req('bb', t(8, 14), sec(NOW))], NOW);
    expect(r.accepts.map((a) => a.start)).toEqual([t(8, 11)]);
    expect(r.decisions['bb'.padEnd(64, '0')].status).toBe('busy');
  });
  it('the same race rule as the guests: earliest wins, the other is told “taken”', () => {
    const r = planBookings(l, [], [req('bb', t(8, 11), sec(NOW) + 1), req('aa', t(8, 11, 30), sec(NOW))], NOW);
    expect(r.accepts.map((a) => a.pk[1])).toEqual(['a']);
    expect(r.decisions['bb'.padEnd(64, '0')].status).toBe('taken');
  });
  it('a time this link never offered is refused (a forged or garbled request)', () => {
    const r = planBookings(l, [], [req('aa', t(8, 3), sec(NOW)), req('bb', t(10, 11), sec(NOW))], NOW); // 3 AM; a Saturday not picked
    expect(r.accepts).toEqual([]);
    expect(Object.values(r.decisions).map((d) => d.status)).toEqual(['invalid', 'invalid']);
  });
  it('a single-use link takes the first and closes', () => {
    const r = planBookings(link({ singleUse: true }), [], [req('aa', t(8, 11), 100 + sec(NOW)), req('bb', t(9, 14), 101 + sec(NOW))], NOW + 200_000);
    expect(r.accepts).toHaveLength(1);
    expect(r.decisions['bb'.padEnd(64, '0')].status).toBe('closed');
  });
  it('the app closed for days: a request is judged from when it was made (notice), against your calendar now', () => {
    const lk = link({ noticeMin: 24 * 60 });
    const asked = sec(t(5, 9)); // Monday, three days before the meeting
    const later = t(8, 10); // the app opens again Thursday at 10 — the 11:00 meeting is only an hour away
    const r = planBookings(lk, [], [req('aa', t(8, 11), asked)], later);
    expect(r.accepts).toHaveLength(1);
  });
  it('a guest whose clock runs fast is treated as asking now (can’t get around the notice)', () => {
    const lk = link({ noticeMin: 24 * 60 });
    const r = planBookings(lk, [], [req('aa', t(8, 11), sec(t(8, 0)))], t(7, 20)); // claims tomorrow midnight
    expect(r.decisions['aa'.padEnd(64, '0')].status).toBe('invalid'); // asked "now" (Wed 8 PM): 11 AM Thu is < 24 h away
  });
  it('requests already answered aren’t answered again (no double booking on restart)', () => {
    const lk = link({ decisions: { ['aa'.padEnd(64, '0')]: { id: 'aa-id', status: 'ok', start: t(8, 11) } } });
    expect(Object.keys(planBookings(lk, [], [req('aa', t(8, 11), sec(NOW))], NOW).decisions)).toEqual([]);
  });
  it('a meeting already booked through the link blocks its time even in a calendar that isn’t “busy time”', () => {
    const lk = link({ blockingCalendars: [] });
    const booked = ev('Meeting · Kai', t(8, 11), 60, { calendarId: 'personal', bookedVia: lk.id });
    expect(planBookings(lk, [booked], [req('bb', t(8, 11), sec(NOW))], NOW).decisions['bb'.padEnd(64, '0')].status).toBe('taken');
    expect(busyFor(lk, [booked])).toHaveLength(1);
    expect(publicView(lk, [booked], NOW).days[0].slots).not.toContain(t(8, 11));
  });
  it('if you delete a booked meeting, its time opens up again', () => {
    expect(planBookings(link(), [], [req('bb', t(8, 11), sec(NOW))], NOW).accepts).toHaveLength(1);
  });
});

describe('poll answers', () => {
  const l = link({ mode: 'poll' });
  const offered = new Set(publicView(l, [], NOW).days.flatMap((d) => d.slots));
  const ans = (pk: string, name: string, cells: number[], at: number): Decoded => ({ pk: pk.padEnd(64, '0'), id: `${pk}${at}`, at, msg: { t: 'poll', name, cells } });
  it('each person’s newest answer; only cells the poll offers', () => {
    const { responses, changed } = mergeResponses(l, [ans('aa', 'Jordan', [t(8, 9), t(8, 3)], 100), ans('aa', 'Jordan', [t(8, 10)], 200), ans('bb', 'Kai', [t(8, 9)], 150)], offered);
    expect(responses.map((r) => [r.name, r.cells])).toEqual([['Kai', [t(8, 9)]], ['Jordan', [t(8, 10)]]]);
    expect(changed).toEqual(['Kai', 'Jordan']);
  });
  it('the same name from another device replaces the earlier answer; an older answer never overwrites a newer', () => {
    const first = mergeResponses(l, [ans('aa', 'Jordan', [t(8, 9)], 100)], offered);
    const second = mergeResponses({ ...l, responses: first.responses }, [ans('bb', 'jordan', [t(8, 10)], 200)], offered);
    expect(second.responses.map((r) => r.cells)).toEqual([[t(8, 10)]]);
    expect(mergeResponses({ ...l, responses: second.responses }, [ans('bb', 'jordan', [t(8, 11)], 150)], offered).changed).toEqual([]);
  });
});

it('decisions for meetings long past are dropped from what is published', () => {
  const d = { a: { id: 'x', status: 'ok' as const, start: t(1, 10) }, b: { id: 'y', status: 'ok' as const, start: t(8, 10) } };
  expect(Object.keys(liveDecisions(d, 60, NOW))).toEqual(['b']);
});
