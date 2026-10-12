import { leaks } from './leaks';
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { busyFor, newLink, publicView, type BookingLink } from './booking';
import {
  KIND, MAX_PUBLISHED, REFUSAL_KEEP, availToken, derive, fromWire, guestUrl, latestPerGuest, linkFragment, liveDecisions, mergeResponses, newLinkKeys, newestAvail,
  nextCreatedAt, openAvail, openGuestMsg, parseFragment, planBookings, pruneDecisions, publishedDecisions, refOf, resolveHolds, sealAvail, sealGuestMsg, toWire,
  toWithdraw, withHolds, type Decision, type Decoded, type RemoteView,
} from './schedwire';
import { epochDay, instantOf } from './zone';
import type { CalEvent } from '../data/types';

// Every time is on the host's (Toronto) clock, whatever zone this machine is in.
const TZ = 'America/Toronto';
const t = (d: number, h: number, m = 0) => instantOf(2026, 9, d, h * 60 + m, TZ);
const NOW = t(7, 19, 10); // Wed Oct 7 2026, 7:10 PM (Toronto)
const sec = (ms: number) => Math.floor(ms / 1000);
const DAYS = [8, 9, 12].map((d) => epochDay(2026, 9, d));
const KEYS = newLinkKeys(); // the link's keys (booking requests quote tokens made with them)
const link = (extra: Partial<BookingLink> = {}): BookingLink => ({
  ...newLink({ id: 'L1', mode: 'book', hostName: 'Sam', calendars: [{ id: 'work', visible: true }], calendarId: 'work', timeZone: TZ, now: NOW }),
  days: DAYS, firstDay: DAYS[0], lastDay: DAYS[2], singleUse: false, nostr: KEYS, ...extra,
});
const ev = (title: string, start: number, mins: number, extra: Partial<CalEvent> = {}): CalEvent => ({ id: title, calendarId: 'work', title, start, end: start + mins * 60_000, allDay: false, ...extra });
const remote = (l: BookingLink, events: CalEvent[] = [], extra: Partial<RemoteView> = {}): RemoteView => ({
  ...fromWire(toWire(publicView(l, events, NOW), { noticeMin: l.noticeMin, singleUse: !!l.singleUse, updatedAt: NOW, decisions: l.decisions }))!, ...extra,
});
/** A guest's booking request, as decoded — made against the version of the times published at `av` (default: `at`). */
const req = (pk: string, start: number, at: number, id = `${pk}-id`, av = at): Decoded => ({ pk: pk.padEnd(64, '0'), id, at, msg: { t: 'book', start, av: { at: av, tok: availToken(KEYS.sk, av) } } });
const P = (pk: string) => pk.padEnd(64, '0');

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
    for (const s of ['dean', 'Office', 'Sam', '1203', String(Math.round(t(8, 9) / 60_000))]) expect(leaks(raw, s)).toBe(false);
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
    expect(leaks(JSON.stringify(e), 'Kai')).toBe(false);
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
  const S = sec(NOW); // requests made just now
  it('two guests, same time: the earlier request holds it, everywhere', () => {
    const { winners, losers } = resolveHolds(view, [req('bb', t(8, 11), S + 1), req('aa', t(8, 11), S + 0)], NOW);
    expect(winners.map((w) => w.pk[1])).toEqual(['a']);
    expect(losers.map((w) => w.pk[1])).toEqual(['b']);
  });
  it('an exact tie is broken by the event id, so every page agrees', () => {
    const r = resolveHolds(view, [req('aa', t(8, 11), S + 0, 'z'), req('bb', t(8, 11), S + 0, 'c')], NOW);
    expect(r.winners[0].id).toBe('c');
  });
  it('overlapping (not identical) times conflict too; separate ones don’t', () => {
    const r = resolveHolds(view, [req('aa', t(8, 11), S + 0), req('bb', t(8, 11, 30), S + 1), req('cc', t(8, 14), S + 2)], NOW);
    expect(r.winners.map((w) => w.pk[1])).toEqual(['a', 'c']);
  });
  it('a request for a time that isn’t offered holds nothing (junk can’t block real times)', () => {
    expect(resolveHolds(view, [req('aa', t(8, 3), S + 0)], NOW).winners).toEqual([]);
  });
  it('a single-use link: only the first request holds, and others see it closed', () => {
    const v = remote(link({ singleUse: true }));
    const { winners } = resolveHolds(v, [req('aa', t(8, 11), S + 0), req('bb', t(9, 14), S + 1)], NOW);
    expect(winners).toHaveLength(1);
    expect(withHolds(v, winners, new Set(), NOW).closed).toBe(true);
    expect(withHolds(v, winners, new Set([winners[0].pk]), NOW).closed).toBe(false); // the one who booked still sees their booking
  });
  it('requests your app already answered no longer hold anything', () => {
    const v = { ...view, decisions: { ['aa'.padEnd(64, '0')]: { id: 'aa-id', status: 'taken' as const, start: t(8, 11) } } };
    expect(resolveHolds(v, [req('aa', t(8, 11), S + 0)], NOW).winners).toEqual([]);
  });
  it('other people’s holds disappear from the times offered; your own stays', () => {
    const { winners } = resolveHolds(view, [req('aa', t(8, 11), S + 0)], NOW);
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
  it('one answer per guest key: someone typing an existing name adds their own answer, can’t replace it (L6)', () => {
    const first = mergeResponses(l, [ans('aa', 'Jordan', [t(8, 9)], 100)], offered);
    const second = mergeResponses({ ...l, responses: first.responses }, [ans('aa', 'Jordan', [t(8, 9)], 100), ans('bb', 'jordan', [t(8, 10)], 200)], offered);
    expect(second.responses.map((r) => [r.id[1], r.cells])).toEqual([['a', [t(8, 9)]], ['b', [t(8, 10)]]]);
    // an older answer never overwrites a newer one from the same key
    expect(mergeResponses({ ...l, responses: second.responses }, [ans('bb', 'jordan', [t(8, 11)], 150)], offered).changed).toEqual([]);
    // the guest's own update (same key) still replaces their answer
    const upd = mergeResponses({ ...l, responses: second.responses }, [ans('aa', 'Jordan', [t(8, 11)], 300)], offered);
    expect(upd.responses.find((r) => r.id === P('aa'))!.cells).toEqual([t(8, 11)]);
    expect(upd.responses).toHaveLength(2);
  });
  it('two devices answering under one name settle: passes over the same inbox stop changing (M10)', () => {
    const inbox = [ans('aa', 'Jordan', [t(8, 9)], 100), ans('bb', 'Jordan', [t(8, 10)], 200)];
    let lk = l;
    const changes: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const r = mergeResponses(lk, inbox, offered);
      changes.push(r.changed);
      lk = { ...lk, responses: r.responses };
    }
    expect(changes.slice(1)).toEqual([[], [], []]);
    expect(lk.responses.map((r) => r.cells)).toEqual([[t(8, 9)], [t(8, 10)]]);
  });
});

it('decisions for meetings long past are dropped from what is published', () => {
  const d = { a: { id: 'x', status: 'ok' as const, start: t(1, 10) }, b: { id: 'y', status: 'ok' as const, start: t(8, 10) } };
  expect(Object.keys(liveDecisions(d, 60, NOW))).toEqual(['b']);
});

describe('a guest’s clock can’t jump the queue or dodge the notice (M4)', () => {
  const l = link({ durationMin: 60 });
  const YEAR = 365 * 86_400;
  const honest = () => req('aa', t(8, 11), sec(NOW), 'aa-id', sec(NOW) - 600); // booked against the version from 10 min ago
  it('a request claiming to be older than the version it quotes is refused; the honest earlier one gets the slot', () => {
    const thief = req('bb', t(8, 11), sec(NOW) - YEAR, 'bb-id', sec(NOW) - 600); // quotes a real version, backdates its clock a year
    const r = planBookings(l, [], [thief, honest()], NOW + 60_000);
    expect(r.accepts.map((a) => a.pk)).toEqual([P('aa')]);
    expect(r.decisions[P('bb')].status).toBe('invalid');
  });
  it('a made-up version (wrong token) earns no early time: it counts from when the app saw it', () => {
    const fake: Decoded = { ...req('bb', t(8, 11), sec(NOW) - YEAR), msg: { t: 'book', start: t(8, 11), av: { at: sec(NOW) - YEAR, tok: '0'.repeat(32) } } };
    const r = planBookings(l, [], [fake, honest()], NOW + 60_000);
    expect(r.accepts.map((a) => a.pk)).toEqual([P('aa')]);
    expect(r.decisions[P('bb')].status).toBe('taken');
  });
  it('created_at 0 can’t bypass “not sooner than”, nor book a slot already past', () => {
    const zero: Decoded = { pk: P('cc'), id: 'cc-id', at: 0, msg: { t: 'book', start: t(8, 11) } };
    expect(planBookings(link({ noticeMin: 24 * 60, singleUse: true }), [], [zero], NOW).decisions[P('cc')].status).toBe('invalid');
    expect(planBookings(link({ singleUse: true }), [], [zero], t(8, 12)).decisions[P('cc')].status).toBe('invalid'); // the 11:00 slot is past
  });
  it('seen live: a request counts from when it arrived (give or take a minute), whatever its clock says', () => {
    const thief = { ...req('bb', t(8, 11), sec(NOW) - 3600, 'bb-id', sec(NOW) - 3600), seen: sec(NOW) + 120 }; // real token, an hour back; arrived 2 min after
    const ok = { ...honest(), seen: sec(NOW) };
    expect(planBookings(l, [], [thief, ok], NOW + 60_000).accepts.map((a) => a.pk)).toEqual([P('aa')]);
  });
  it('guest pages don’t let a request with an impossible clock win, so the honest guest isn’t told they lost', () => {
    const view = remote(l);
    const thief = req('bb', t(8, 11), sec(NOW) - YEAR, 'bb-id', sec(NOW) - 600);
    const { winners, losers } = resolveHolds(view, [thief, honest()], NOW);
    expect(winners.map((w) => w.pk)).toEqual([P('aa')]);
    expect(losers).toEqual([]);
    // a forged token for the very version the page has is caught too
    const v2 = { ...view, pubAt: sec(NOW) - 600, tok: availToken(KEYS.sk, sec(NOW) - 600) };
    const forged: Decoded = { ...req('bb', t(8, 11), sec(NOW) - 600), msg: { t: 'book', start: t(8, 11), av: { at: sec(NOW) - 600, tok: 'f'.repeat(32) } } };
    expect(resolveHolds(v2, [forged, honest()], NOW).winners.map((w) => w.pk)).toEqual([P('aa')]);
  });
  it('a guest who lost a race is withdrawn only when they book another time, never on its own', () => {
    const view = remote(l);
    const first = req('bb', t(8, 11), sec(NOW) - 60, 'bb-id', sec(NOW) - 600);
    const { losers } = resolveHolds(view, [first, honest()], NOW);
    const mine = [{ pk: P('aa'), id: 'aa-id' }];
    expect(toWithdraw(mine, view, losers)).toEqual(mine); // lost: withdrawn when they pick another time
    const answered = { ...view, decisions: { [P('aa')]: { id: 'aa-id', status: 'ok' as const, start: t(8, 11) } } };
    expect(toWithdraw(mine, answered, losers)).toEqual([]); // the host's app confirmed it after all: kept
  });
  it('the published availability carries its token, and a booking quotes it', () => {
    const l2 = link();
    const ev = sealAvail(publicView(l2, [], NOW), l2.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW }, 1234);
    const v = openAvail(ev, refOf(l2.nostr!))!;
    expect(v.pubAt).toBe(1234);
    expect(v.tok).toBe(availToken(l2.nostr!.sk, 1234));
    const b = sealGuestMsg({ t: 'book', start: t(8, 11), av: { at: 1234, tok: v.tok! } }, refOf(l2.nostr!), generateSecretKey(), 1300);
    expect(openGuestMsg(b, refOf(l2.nostr!))!.msg).toEqual({ t: 'book', start: t(8, 11), av: { at: 1234, tok: v.tok } });
  });
});

describe('junk requests can’t make the link too big to open (M8)', () => {
  const junk = (n: number, start: (i: number) => number, status: Decision['status'] = 'invalid', at = NOW) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [i.toString(16).padStart(64, '0'), { id: 'e'.repeat(64), status, start: start(i), at }]));
  it('600 requests for a far-future time: none is published, and the availability still opens', () => {
    const l = link({ decisions: junk(600, () => 9e15) });
    const dec = publishedDecisions(l, [], NOW);
    expect(Object.keys(dec)).toHaveLength(0);
    const ev = sealAvail(publicView(l, [], NOW), l.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW, decisions: dec }, sec(NOW));
    expect(openAvail(ev, refOf(l.nostr!))).not.toBeNull();
  });
  it('thousands of refusals of real times: capped (confirmed ones always in), and the message still opens', () => {
    const ok = { [P('aa')]: { id: 'ok-id', status: 'ok' as const, start: t(8, 11), at: NOW - 86_400_000 } };
    const l = link({ decisions: { ...junk(3000, () => t(8, 11), 'taken'), ...ok } });
    const dec = publishedDecisions(l, [], NOW);
    expect(Object.keys(dec)).toHaveLength(MAX_PUBLISHED);
    expect(dec[P('aa')].status).toBe('ok');
    const ev = sealAvail(publicView(l, [], NOW), l.nostr!, { noticeMin: 0, singleUse: false, updatedAt: NOW, decisions: dec }, sec(NOW));
    expect(ev.content.length).toBeLessThan(120_000);
    expect(openAvail(ev, refOf(l.nostr!))!.decisions[P('aa')].status).toBe('ok');
  });
  it('refusals expire by when they were made, not by the (guest-chosen) meeting time', () => {
    const l = link({ decisions: { [P('aa')]: { id: 'x', status: 'taken', start: t(12, 11), at: NOW - REFUSAL_KEEP - 1 }, [P('bb')]: { id: 'y', status: 'taken', start: t(12, 11), at: NOW - 1000 } } });
    expect(Object.keys(publishedDecisions(l, [], NOW))).toEqual([P('bb')]);
  });
  it('an unanswered request older than that holds nothing on guest pages (an expired refusal can’t come back as a hold)', () => {
    const view = { ...remote(link()), updatedAt: NOW };
    expect(resolveHolds(view, [req('aa', t(8, 11), sec(NOW - REFUSAL_KEEP) - 10)], NOW).winners).toEqual([]);
  });
  it('your app prunes what it keeps: junk off the offered times, meetings long over, and a cap', () => {
    const l = link();
    const kept = pruneDecisions(l, {
      ...junk(50, () => 9e15),
      [P('aa')]: { id: 'a', status: 'ok', start: t(8, 11), at: NOW },
      [P('bb')]: { id: 'b', status: 'ok', start: t(8, 11) - 40 * 86_400_000, at: NOW },
      [P('cc')]: { id: 'c', status: 'taken', start: t(8, 11), at: NOW },
    });
    expect(Object.keys(kept).sort()).toEqual([P('aa'), P('cc')]);
    expect(Object.keys(pruneDecisions(l, junk(1500, () => t(8, 11), 'taken')))).toHaveLength(1000);
  });
  it('requests for meetings long over are ignored (their answers were forgotten)', () => {
    const day = epochDay(2026, 8, 1);
    expect(planBookings(link({ days: [day], firstDay: day, lastDay: day }), [], [req('aa', instantOf(2026, 8, 1, 600, TZ), sec(NOW))], NOW).decisions).toEqual({});
  });
});
