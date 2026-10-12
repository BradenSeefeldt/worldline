// Your side of scheduling links: list, create, edit, copy, and pick the final time for a poll.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useStore } from '../data/store';
import { expand } from '../lib/recurrence';
import { bestTimes, heat, isFinished, linkDays, linkSpan, meetingAt, publicView, type BookingLink } from '../lib/booking';
import { fromEpochDay } from '../lib/zone';
import { cls, fmtTimeRange } from '../lib/format';
import { Avatar, Avatars, PollGrid } from '../pages/GuestPage';
import { Close, Trash } from './Icons';
import { DayPicker } from './DayPicker';
import { ask } from './Confirm';
import { guestUrl } from '../lib/schedwire';
import { useNow } from '../lib/hooks';

/** The guest page: one static page on the project's GitHub Pages (in development, this dev server's copy). */
const GUEST_PAGE = import.meta.env.DEV ? `${window.location.origin}/book.html` : 'https://bradenseefeldt.github.io/worldline/';
/** A link's address: the guest page + its keys after "#" (which never leave the guest's browser). */
function linkUrl(id: string) {
  useStore.getState().ensureLinkKeys(id);
  const keys = useStore.getState().links.find((l) => l.id === id)?.nostr;
  return keys ? guestUrl(GUEST_PAGE, keys) : GUEST_PAGE;
}
const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const toMin = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
};

function copyLink(id: string) {
  void navigator.clipboard?.writeText(linkUrl(id));
  useStore.getState().showToast('Link copied · bookings appear here on their own', false);
}

/** Delete a link — and its upcoming meetings, after saying so. Returns whether it was deleted. */
async function deleteLink(l: BookingLink) {
  const st = useStore.getState();
  const n = st.events.filter((e) => e.bookedVia === l.id && e.end > Date.now()).length;
  const meetings = `${n} upcoming meeting${n === 1 ? '' : 's'}`;
  if (!isFinished(l) && !unused(l)) {
    const body = n
      ? `The link stops working, and its ${meetings} ${n === 1 ? 'is' : 'are'} removed from your calendar. Anyone who booked sees that it was cancelled when they open the link.`
      : 'The link stops working.';
    if (!(await ask({ title: `Delete “${l.title}”?`, body, confirm: n ? `Delete link and ${n === 1 ? 'meeting' : 'meetings'}` : 'Delete link', danger: true }))) return false;
  }
  st.deleteLink(l.id);
  st.showToast(`Deleted link “${l.title}”${n ? ` and its ${meetings}` : ''}`, false);
  return true;
}

const dayDate = (e: number) => {
  const { y, m, d } = fromEpochDay(e);
  return new Date(y, m, d);
};

/** A link that was never set up or used (no days, no bookings, no answers): deleting it loses nothing, so no "are you sure?". */
const unused = (l: BookingLink) => !linkDays(l).length && !l.bookings.length && !l.responses.length;

function summary(l: BookingLink) {
  const days = linkDays(l);
  const range = !days.length
    ? 'no days picked'
    : days.length === 1
      ? format(dayDate(days[0]), 'MMM d')
      : `${days.length} days · ${format(dayDate(days[0]), 'MMM d')}–${format(dayDate(days[days.length - 1]), 'MMM d')}`;
  if (l.closed && l.finalStart) return l.mode === 'poll' ? `Poll · scheduled · ${l.responses.length} answered` : 'Booking link · booked';
  if (isFinished(l)) return 'Ended';
  if (l.mode === 'poll') return `Poll · ${range} · ${l.responses.length} answered`;
  const upcoming = l.bookings.filter((b) => b.start > Date.now()).length;
  return `${l.durationMin < 60 ? `${l.durationMin} min` : `${l.durationMin / 60} h`} · ${range}${l.bookings.length ? ` · ${upcoming} booked` : ''}`;
}

/** The meetings a link produced, soonest first: a poll's chosen time, or bookings (upcoming ones, unless it's all over). */
function bookedTimes(l: BookingLink, now: number) {
  const len = l.durationMin * 60_000;
  if (l.mode === 'poll') return l.finalStart ? [{ start: l.finalStart, end: l.finalStart + len, name: '', eventId: undefined as string | undefined }] : [];
  const all = [...l.bookings].sort((a, b) => a.start - b.start).map((b) => ({ start: b.start, end: b.end, name: b.name, eventId: b.eventId }));
  const upcoming = all.filter((b) => b.end > now);
  return upcoming.length || !isFinished(l, now) ? upcoming : all.slice(-1); // finished: the last one, for the record
}

export function SchedulingBody() {
  const links = useStore((s) => s.links);
  const [editing, setEditing] = useState<string | null>(null);
  const [results, setResults] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const st = useStore.getState;
  const add = (mode: 'book' | 'poll') => setEditing(st().createLink(mode));
  const active = links.filter((l) => !isFinished(l));
  const finished = links.filter((l) => isFinished(l));
  const row = (l: BookingLink, booked = bookedTimes(l, Date.now())) => (
        <div key={l.id} className={cls('sl', l.closed && 'closed')} onClick={() => (l.mode === 'poll' ? setResults(l.id) : setEditing(l.id))}>
          <span className="sl-icon">{l.mode === 'book' ? '◷' : '◫'}</span>
          <span className="sl-body">
            <span className="sl-title">{l.title}</span>
            <span className="sl-sub">{summary(l)}</span>
          </span>
          <button className="sl-btn" title="Copy link" onClick={(e) => { e.stopPropagation(); copyLink(l.id); }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6.5 9.5 9.5 6.5M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" /></svg>
          </button>
          {/* Preview ↗ and Delete are in its card (click the row), so the name gets the room */}
          {booked.length > 0 && (
            <span className="sl-books">
              {booked.slice(0, 3).map((b) => (
                <button
                  key={b.start}
                  className={cls('sl-booked', b.end < Date.now() && 'past')}
                  title="Show on calendar"
                  onClick={(e) => {
                    e.stopPropagation();
                    const id = b.eventId ?? st().events.find((x) => x.bookedVia === l.id && x.start === b.start)?.id;
                    st().goTo(b.start);
                    if (id) st().flash(id);
                  }}
                >
                  ✓ {format(b.start, 'EEE MMM d')} · {fmtTimeRange(b.start, b.end)}{b.name ? ` · ${b.name}` : ''}
                </button>
              ))}
            </span>
          )}
        </div>
  );
  return (
    <>
      {!links.length && <div className="tk-empty">Let people pick a time with you — they only ever see when you're free.</div>}
      {active.map((l) => row(l))}
      {finished.length > 0 && (
        <div className="sl-finished">
          <button className="tk-more" onClick={() => setShowFinished(!showFinished)}>
            Finished ({finished.length}) {showFinished ? '▴' : '▾'}
          </button>
          {showFinished && (
            <>
              {finished.map((l) => row(l))}
              <button className="tk-more" title="Booked meetings stay on your calendar" onClick={() => st().clearFinishedLinks()}>
                Clear finished
              </button>
            </>
          )}
        </div>
      )}
      <div className="sl-new">
        <button onClick={() => add('book')}>+ Booking link</button>
        <button onClick={() => add('poll')}>+ Group poll</button>
      </div>
      {editing && <LinkEditor id={editing} onClose={() => setEditing(null)} />}
      {results && <PollResults id={results} onClose={() => setResults(null)} onEdit={() => { setEditing(results); setResults(null); }} />}
    </>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="ce-scrim" onMouseDown={onClose}>
      <div className={cls('ce', 'sl-modal', wide && 'wide')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ce-head">
          <span className="ce-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function LinkEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const link = useStore((s) => s.links.find((l) => l.id === id));
  const calendars = useStore((s) => s.calendars);
  const st = useStore.getState();
  if (!link) return null;
  const up = (patch: Partial<BookingLink>) => st.updateLink(id, patch);
  const book = link.mode === 'book';
  return (
    <Modal title={book ? 'Booking link' : 'Group poll'} onClose={onClose}>
      <input className="ce-name" value={link.title} placeholder="Event name" onChange={(e) => up({ title: e.target.value })} autoFocus />
      <DayPicker value={linkDays(link)} timeZone={link.timeZone} onChange={(days) => up({ days, ...(days.length ? { firstDay: days[0], lastDay: days[days.length - 1] } : {}) })} />
      <div className="panel-rows">
        <div className="prow">
          <span>Length</span>
          <select className="pselect" value={link.durationMin} onChange={(e) => up({ durationMin: +e.target.value })}>
            {DURATIONS.map((d) => <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} h`}</option>)}
          </select>
        </div>
        <div className="prow">
          <span>Between</span>
          <div className="pinputs">
            <input type="time" step={1800} value={hhmm(link.windowStart)} onChange={(e) => e.target.value && up({ windowStart: toMin(e.target.value) })} />
            <input type="time" step={1800} value={hhmm(link.windowEnd)} onChange={(e) => e.target.value && up({ windowEnd: toMin(e.target.value) })} />
          </div>
        </div>
        {book && (
          <>
            <label className="prow">
              <span>Close after one booking</span>
              <input type="checkbox" className="switch" checked={!!link.singleUse} onChange={(e) => up({ singleUse: e.target.checked })} />
            </label>
            <div className="prow">
              <span>Keep free around events</span>
              <select className="pselect" value={link.bufferMin} onChange={(e) => up({ bufferMin: +e.target.value })}>
                {[0, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m ? `${m} min` : 'none'}</option>)}
              </select>
            </div>
            <div className="prow">
              <span>Earliest booking</span>
              <select className="pselect" value={link.noticeMin} onChange={(e) => up({ noticeMin: +e.target.value })}>
                {[[0, 'any time'], [60, '1 h ahead'], [240, '4 h ahead'], [720, '12 h ahead'], [1440, '1 day ahead'], [2880, '2 days ahead']].map(([m, l]) => <option key={m} value={m}>{l}</option>)}
              </select>
            </div>
          </>
        )}
      </div>
      <div className="panel-rows">
        <input className="pfield" placeholder="Location or video link (shown to guests)" value={link.location ?? ''} onChange={(e) => up({ location: e.target.value })} />
        <textarea className="pfield notes" placeholder="Note to guests" value={link.note ?? ''} onChange={(e) => up({ note: e.target.value })} />
      </div>
      <div className="sl-cals">
        <div className="sl-label">Busy time comes from</div>
        {calendars.map((c) => (
          <label key={c.id} className="sl-cal" style={{ '--c': c.color } as CSSProperties}>
            <input type="checkbox" checked={link.blockingCalendars.includes(c.id)} onChange={(e) => up({ blockingCalendars: e.target.checked ? [...link.blockingCalendars, c.id] : link.blockingCalendars.filter((x) => x !== c.id) })} />
            <i />{c.name}
          </label>
        ))}
        <div className="sl-label">Booked meetings go in</div>
        <select className="pselect" value={link.calendarId} onChange={(e) => up({ calendarId: e.target.value })}>
          {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <SyncLine id={id} />
      <div className="ce-actions">
        <button
          className="ce-btn subtle-danger"
          onClick={async () => {
            if (await deleteLink(link)) onClose();
          }}
        >
          <Trash /> Delete
        </button>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="ce-btn" onClick={() => window.open(linkUrl(id), '_blank')}>Preview ↗</button>
          <button className="ce-btn primary" onClick={() => { copyLink(id); onClose(); }}>Copy link</button>
        </span>
      </div>
    </Modal>
  );
}

/** Whether guests can see the link (published to the relays), and a new address if it was shared too widely. */
function SyncLine({ id }: { id: string }) {
  const sync = useStore((s) => s.linkSync[id]);
  useNow(30_000);
  const reset = async () => {
    if (!(await ask({ title: 'Give this link a new address?', body: 'The current address stops working (anyone opening it sees that it’s closed). Meetings already booked stay on your calendar.', confirm: 'New address' }))) return;
    useStore.getState().resetLinkKeys(id);
    copyLink(id);
  };
  const ago = sync ? (Date.now() - sync.at < 60_000 ? 'just now' : `${formatDistanceToNowStrict(sync.at)} ago`) : '';
  return (
    <div className="sl-sync">
      <span className={cls('sl-live', sync?.relays ? 'on' : sync && 'off')}>
        <i />
        {!sync ? 'Publishing…' : sync.relays ? `Live · on ${sync.relays} of ${sync.total} relays · updated ${ago}` : 'Not published yet — no network? Retrying every minute'}
      </span>
      <button className="tk-more" onClick={() => void reset()} title="If the link was shared more widely than you meant">New address</button>
    </div>
  );
}

function PollResults({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: () => void }) {
  const link = useStore((s) => s.links.find((l) => l.id === id));
  const events = useStore((s) => s.events);
  const view = useMemo(() => {
    if (!link) return null;
    const { from, to } = linkSpan(link);
    return publicView(link, expand(events, from, to));
  }, [link, events]);
  const [picked, setPicked] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  if (!link || !view) return null;
  const h = heat(link.responses);
  const best = bestTimes(link, view, 1)[0]?.start ?? null;
  const pinned = picked ?? best; // what Schedule books: your click, else the best time
  const shown = hovered ?? pinned; // what the panel shows: under the pointer, else the pinned time
  const m = shown !== null ? meetingAt(view, h, shown, link.durationMin) : null;
  const names = link.responses.map((r) => r.name);
  const len = link.durationMin * 60_000;
  const schedule = (start: number) => { useStore.getState().scheduleFromPoll(id, start); onClose(); };
  const open = !link.closed;
  return (
    <Modal title="Group poll" onClose={onClose} wide>
      <div className="sl-res-head">
        <div>
          <div className="ce-name" style={{ fontSize: 20 }}>{link.title}</div>
          <div className="sl-sub pr-sub">
            {link.responses.length ? <><Avatars names={names} max={8} />{link.responses.length} answered</> : 'No answers yet — send the link around'}
          </div>
        </div>
        <span style={{ display: 'flex', gap: 8 }}>
          <button className="ce-btn" onClick={onEdit}>Edit</button>
          <button className="ce-btn" onClick={() => copyLink(id)}>Copy link</button>
        </span>
      </div>
      {link.closed && link.finalStart && (
        <div className="plink"><span>✓ Scheduled for <b>{format(link.finalStart, 'EEE MMM d')} · {fmtTimeRange(link.finalStart, link.finalStart + len)}</b></span></div>
      )}
      <div className="pr-layout">
        <PollGrid v={view} mine={new Set()} readOnly extra={link.responses} pick={open ? { selected: pinned, onSelect: setPicked, onHover: setHovered } : undefined} />
        {open && (
          <aside className="pr-panel">
            {m ? (
              <>
                <div className="pr-when">
                  <small>{hovered !== null && hovered !== pinned ? 'Pointing at' : picked !== null ? 'Picked' : 'Best time'}</small>
                  <b>{format(m.start, 'EEE, MMM d')}</b>
                  <span>{fmtTimeRange(m.start, m.start + len)}</span>
                </div>
                {!m.fits ? (
                  <div className="pr-busy">You’re busy for part of this</div>
                ) : (
                  <div className="pr-cols">
                    {[{ title: 'Available', list: names.filter((n) => m.names.includes(n)), ok: true }, { title: 'Unavailable', list: names.filter((n) => !m.names.includes(n)), ok: false }].map((col) => (
                      <div key={col.title} className={cls('pr-col', col.ok ? 'ok' : 'no')}>
                        <div className="pr-col-head">{col.title}<span>{col.list.length}</span></div>
                        {col.list.map((n) => (
                          <div key={`${col.title}-${n}`} className="pr-name"><Avatar name={n} size={20} />{n}</div>
                        ))}
                        {!col.list.length && <div className="pr-none">—</div>}
                      </div>
                    ))}
                  </div>
                )}
                {pinned !== null && (
                  <div className="pr-act">
                    {hovered !== null && hovered !== pinned && <span className="pr-pinned">Picked: {format(pinned, 'EEE MMM d')}, {fmtTimeRange(pinned, pinned + len)}</span>}
                    <button className="ce-btn primary" onClick={() => schedule(pinned)}>Schedule {hovered !== null && hovered !== pinned ? 'picked time' : 'this time'}</button>
                  </div>
                )}
              </>
            ) : (
              <div className="pr-empty">No answers yet</div>
            )}
          </aside>
        )}
      </div>
    </Modal>
  );
}
