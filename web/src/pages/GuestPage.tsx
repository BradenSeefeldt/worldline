// What someone you send a link to sees. It is built ONLY from `publicView` — open times and
// what you chose to share — exactly what a guest's browser would receive once this is online.
import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { useStore } from '../data/store';
import { expand } from '../lib/recurrence';
import { heat, icsFor, linkSpan, meetingAt, publicView, type PublicView } from '../lib/booking';
import { fromEpochDay, localZone, zoneAbbr, zoneCity } from '../lib/zone';
import { useNow } from '../lib/hooks';
import { cls, fmtTimeRange } from '../lib/format';

const MIN = 60_000;

function usePublicView(id: string): PublicView | null {
  const link = useStore((s) => s.links.find((l) => l.id === id));
  const events = useStore((s) => s.events);
  const myName = useStore((s) => s.myName);
  const now = useNow(60_000);
  return useMemo(() => {
    if (!link) return null;
    const { from, to } = linkSpan(link);
    return publicView(link, expand(events, from, to), now, myName);
  }, [link, events, now, myName]);
}

const dayLabel = (day: number, slots: number[]) => {
  const ref = slots[0] ?? (() => { const d = fromEpochDay(day); return new Date(d.y, d.m, d.d).getTime(); })();
  return { dow: format(ref, 'EEE'), date: format(ref, 'MMM d') };
};

function Header({ v }: { v: PublicView }) {
  const tz = localZone();
  return (
    <header className="gp-head">
      <div className="gp-host">{v.hostName ? (v.mode === 'book' ? `Book time with ${v.hostName}` : `${v.hostName} is finding a time`) : v.mode === 'book' ? 'Book a time' : 'Find a time together'}</div>
      <h1 className="gp-title">{v.title}</h1>
      <div className="gp-meta">
        {v.location && <span>⌖ {v.location}</span>}
        <span title={zoneCity(tz)}>Times in {zoneAbbr(tz)}</span>
      </div>
      {v.note && <p className="gp-note">{v.note}</p>}
    </header>
  );
}

// ---------------------------------------------------------------- one person books a slot
function BookView({ v }: { v: PublicView }) {
  const [day, setDay] = useState<number | null>(v.days[0]?.day ?? null);
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ start: number; end: number } | null>(null);
  const current = v.days.find((d) => d.day === day) ?? v.days[0];

  if (done) {
    const ics = `data:text/calendar;charset=utf-8,${encodeURIComponent(icsFor(`${v.title}${v.hostName ? ` with ${v.hostName}` : ''}`, done.start, done.end, v.location))}`;
    return (
      <div className="gp-card gp-done">
        <div className="gp-check">✓</div>
        <h1 className="gp-title">You're booked</h1>
        <p className="gp-when">{format(done.start, 'EEEE, MMMM d')} · {fmtTimeRange(done.start, done.end)}</p>
        <p className="gp-sub">{v.title}{v.hostName ? ` with ${v.hostName}` : ''}{v.location ? ` · ${v.location}` : ''}</p>
        <div className="gp-actions">
          <a className="gp-btn" href={ics} download={`${v.title}.ics`}>Add to my calendar</a>
          {!v.closed && <button className="gp-btn ghost" onClick={() => { setDone(null); setSlot(null); }}>Book another time</button>}
        </div>
      </div>
    );
  }
  if (v.closed && v.finalStart) {
    const end = v.finalStart + v.durationMin * MIN;
    const ics = `data:text/calendar;charset=utf-8,${encodeURIComponent(icsFor(`${v.title}${v.hostName ? ` with ${v.hostName}` : ''}`, v.finalStart, end, v.location))}`;
    return (
      <div className="gp-card gp-done">
        <div className="gp-check">✓</div>
        <h1 className="gp-title">{end < Date.now() ? 'This meeting was' : 'You’re booked for'}</h1>
        <p className="gp-when">{format(v.finalStart, 'EEEE, MMMM d')} · {fmtTimeRange(v.finalStart, end)}</p>
        <p className="gp-sub">{v.title}{v.hostName ? ` with ${v.hostName}` : ''}{v.location ? ` · ${v.location}` : ''} · times in {zoneAbbr(localZone())}</p>
        {end >= Date.now() && <div className="gp-actions"><a className="gp-btn" href={ics} download={`${v.title}.ics`}>Add to my calendar</a></div>}
      </div>
    );
  }
  if (v.closed) return <div className="gp-card"><Header v={v} /><p className="gp-empty">This link is no longer taking bookings.</p></div>;
  const confirm = () => {
    if (!slot) return;
    const r = useStore.getState().addBooking(v.id, { start: slot });
    if (!r.ok) {
      setError(r.reason ?? 'Something went wrong.');
      setSlot(null);
      return;
    }
    setDone({ start: slot, end: slot + v.durationMin * MIN });
  };
  return (
    <div className="gp-card">
      <Header v={v} />
      {!v.days.length ? (
        <p className="gp-empty">No open times right now — please check back later.</p>
      ) : (
        <>
          <div className="gp-days" role="tablist">
            {v.days.map((d) => {
              const l = dayLabel(d.day, d.slots);
              return (
                <button key={d.day} role="tab" aria-selected={d.day === current?.day} className={cls('gp-day', d.day === current?.day && 'on')} onClick={() => { setDay(d.day); setSlot(null); }}>
                  <span className="gp-dow">{l.dow}</span>
                  <span className="gp-date">{l.date}</span>
                  <span className="gp-count">{d.slots.length} open</span>
                </button>
              );
            })}
          </div>
          <div className="gp-slots">
            {current?.slots.map((s) => (
              <button key={s} className={cls('gp-slot', s === slot && 'on')} onClick={() => { setSlot(s); setError(''); }}>
                {format(s, 'h:mm a')}
              </button>
            ))}
          </div>
          {slot && (
            <div className="gp-confirm">
              <div className="gp-picked">{format(slot, 'EEEE, MMM d')} · <b>{fmtTimeRange(slot, slot + v.durationMin * MIN)}</b></div>
              <button className="gp-btn" onClick={confirm} autoFocus>Confirm</button>
            </div>
          )}
          {error && <p className="gp-error">{error}</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- group poll (paint when you're free)
/** A coloured initials bubble — the same person always gets the same colour. */
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const initials = name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  return (
    <span className="av" title={name} style={{ '--h': hash, width: size, height: size, fontSize: size * 0.42 } as React.CSSProperties}>
      {initials}
    </span>
  );
}

export function Avatars({ names, max = 5 }: { names: string[]; max?: number }) {
  return (
    <span className="avs">
      {names.slice(0, max).map((n) => <Avatar key={n} name={n} />)}
      {names.length > max && <span className="av more">+{names.length - max}</span>}
    </span>
  );
}

/** Heat level 1–4 from the fraction of people free (0 = nobody). */
const level = (count: number, total: number) => (count && total ? Math.min(4, Math.ceil((count / total) * 4)) : 0);

export function PollGrid({ v, mine, onChange, readOnly, extra, pick }: {
  v: PublicView;
  mine: Set<number>;
  onChange?: (cells: Set<number>) => void;
  readOnly?: boolean;
  extra?: { name: string; cells: number[] }[]; // other people's answers, for the heat map
  pick?: { selected: number | null; onSelect: (start: number) => void; onHover: (start: number | null) => void }; // results view: point at / click a time
}) {
  const people = extra ?? v.responses;
  const h = useMemo(() => heat(people), [people]);
  const total = people.length;
  // A drag paints the rectangle from where it started to where the pointer is (days × times).
  const paint = useRef<{ add: boolean; col: number; row: number; base: Set<number> } | null>(null);
  const mineRef = useRef(mine); // always the latest selection, even mid-drag between renders
  mineRef.current = mine;
  const wrapRef = useRef<HTMLDivElement>(null);
  // What the pointer is over: the cell (or a whole unavailable stretch) and where to put the tooltip.
  const [hover, setHover] = useState<{ cell: number; col: number; row: number; len: number; x: number; y: number } | null>(null);
  const open = useMemo(() => new Set(v.days.flatMap((d) => d.slots)), [v.days]);
  const rows = Math.max(0, ...v.days.map((d) => d.cells?.length ?? 0));
  useEffect(() => {
    const up = () => (paint.current = null);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  const apply = (col: number, row: number) => {
    const p = paint.current;
    if (!onChange || !p) return;
    const next = new Set(p.base);
    for (let ci = Math.min(p.col, col); ci <= Math.max(p.col, col); ci++)
      for (let ri = Math.min(p.row, row); ri <= Math.max(p.row, row); ri++) {
        const c = v.days[ci]?.cells?.[ri];
        if (c === undefined || !open.has(c)) continue;
        if (p.add) next.add(c);
        else next.delete(c);
      }
    mineRef.current = next;
    onChange(next);
  };
  // Whichever cell is under the pointer (works the same for mouse and touch).
  const onMove = (e: React.PointerEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    if (!el?.dataset.cell || !wrapRef.current) return;
    const col = +el.dataset.col!, row = +el.dataset.row!;
    if (hover?.cell !== +el.dataset.cell) {
      const r = el.getBoundingClientRect(), w = wrapRef.current.getBoundingClientRect();
      setHover({ cell: +el.dataset.cell, col, row, len: +(el.dataset.len ?? 1), x: r.left + r.width / 2 - w.left, y: r.top - w.top });
    }
    if (paint.current) apply(col, row);
  };
  const ref0 = v.days.find((d) => d.cells?.length)?.cells ?? [];
  // Pick mode: the pointer stands for a whole meeting starting there (e.g. two rows for an hour).
  const preview = pick && hover && open.has(hover.cell) ? meetingAt(v, h, hover.cell, v.durationMin) : null;
  const previewStart = preview?.start ?? null;
  useEffect(() => pick?.onHover(previewStart), [previewStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = pick?.selected != null ? meetingAt(v, h, pick.selected, v.durationMin) : null;
  const spanClass = (m: typeof preview, c: number, cls0: string) => {
    if (!m) return '';
    const k = m.cells.indexOf(c);
    if (k < 0) return '';
    return cls(cls0, !m.fits && 'bad', k === 0 && 's-top', k === m.cells.length - 1 && 's-bot');
  };
  const unavailable = readOnly ? 'Busy' : 'Unavailable';

  // The tooltip over the cell you're pointing at: when it is, and who's free.
  const tip = (() => {
    if (!hover) return null;
    const c = hover.cell;
    if (pick) return null; // the results panel beside the grid shows who can make it
    const when = `${format(c, 'EEE MMM d')} · ${fmtTimeRange(c, c + hover.len * v.cellMin * MIN)}`;
    if (!open.has(c)) return <><b>{when}</b><span className="pg-tip">{readOnly ? 'You’re busy' : v.hostName ? `${v.hostName} isn’t available` : 'Not available'}</span></>;
    const free = h.get(c) ?? [];
    const away = people.map((p) => p.name).filter((n) => !free.includes(n));
    const you = !readOnly && mine.has(c);
    return (
      <>
        <b>{when}</b>
        {!readOnly && <span className={cls('pg-you', you && 'on')}>{you ? '✓ You’re free' : 'Not marked'}</span>}
        {total > 0 && (free.length ? (
          <span className="pg-tip-row"><Avatars names={free} /><span>{free.length === total ? (readOnly ? 'Everyone can make it' : 'Everyone else is free') : `${free.join(', ')} free`}</span></span>
        ) : <span className="pg-tip">Nobody else free</span>)}
        {free.length > 0 && away.length > 0 && <span className="pg-tip">{away.join(', ')} can’t</span>}
      </>
    );
  })();

  // Grid lines: row 1 is the day headers, row r+2 is time row r; column 1 is the times.
  const cellsFor = (d: PublicView['days'][number], ci: number) => {
    const out: React.ReactNode[] = [];
    const cells = d.cells ?? [];
    for (let r = 0; r < cells.length; r++) {
      const c = cells[r];
      const hour = new Date(c).getMinutes() === 0;
      const edge = cls(r === 0 && 'first', hover?.row === r && hover.col !== ci && 'row-hov');
      if (!open.has(c)) {
        // A stretch of unavailable time is one block, so it reads as "not a choice", not as cells.
        let len = 1;
        while (r + len < cells.length && !open.has(cells[r + len])) len++;
        out.push(
          <div
            key={c}
            data-cell={c}
            data-col={ci}
            data-row={r}
            data-len={len}
            className={cls('pg-cell busy', edge, r + len === cells.length && 'last', hover?.cell === c && 'hov')}
            style={{ gridColumn: ci + 2, gridRow: `${r + 2} / span ${len}` }}
          >
            {len >= 2 && <span>{unavailable}</span>}
          </div>,
        );
        r += len - 1;
        continue;
      }
      const others = h.get(c)?.length ?? 0;
      const lv = level(others, total);
      const isMine = !readOnly && mine.has(c);
      const prevMine = isMine && r > 0 && mine.has(cells[r - 1]);
      out.push(
        <div
          key={c}
          data-cell={c}
          data-col={ci}
          data-row={r}
          className={cls(
            'pg-cell',
            hour ? 'hour' : 'half',
            edge,
            r === cells.length - 1 && 'last',
            isMine ? 'mine' : lv > 0 && (readOnly ? `pg-h${lv}` : `pg-o${lv}`),
            prevMine && 'joined',
            readOnly && others === total && total > 1 && 'all',
            !pick && hover?.cell === c && 'hov',
            pick && 'pickable',
            spanClass(chosen, c, 'picked'),
            spanClass(preview, c, 'span'),
          )}
          style={{ gridColumn: ci + 2, gridRow: r + 2 }}
          onPointerDown={(e) => {
            if (pick) {
              if (meetingAt(v, h, c, v.durationMin).fits) pick.onSelect(c);
              return;
            }
            if (readOnly) return;
            e.preventDefault();
            try {
              (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); // touch: let moves reach other cells
            } catch {
              /* no capture to release */
            }
            paint.current = { add: !mineRef.current.has(c), col: ci, row: r, base: new Set(mineRef.current) };
            apply(ci, r);
          }}
        >
          {readOnly && others > 0 ? others : ''}
        </div>,
      );
    }
    return out;
  };

  return (
    <div className="pg-wrap" ref={wrapRef}>
      <div className="pg-legend">
        <span className="pg-key"><i className="pg-sw busy" />{unavailable}</span>
        <span className="pg-key"><i className="pg-sw" />Open</span>
        {!readOnly && <span className="pg-key"><i className="pg-sw mine" />You’re free</span>}
        {total > 0 && (
          <span className="pg-key">
            <span className="pg-steps">{[1, 2, 3, 4].map((l) => <i key={l} className={cls('pg-sw', readOnly ? `pg-h${l}` : `pg-o${l}`)} />)}</span>
            {readOnly ? `1 → ${total} free` : `Others free (${total})`}
          </span>
        )}
        {readOnly && total > 1 && <span className="pg-key">★ Everyone</span>}
      </div>
      <div className="pg-scroll" onScroll={() => setHover(null)}>
        <div
          className="pg"
          style={{ gridTemplateColumns: `58px repeat(${v.days.length}, minmax(48px, 1fr))`, gridTemplateRows: `auto repeat(${rows}, 24px)` }}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <div className="pg-corner" style={{ gridColumn: 1, gridRow: 1 }} />
          {v.days.map((d, ci) => {
            const ref = d.cells?.[0] ?? d.slots[0] ?? (() => { const x = fromEpochDay(d.day); return new Date(x.y, x.m, x.d).getTime(); })();
            return (
              <div key={d.day} className={cls('pg-dayhead', hover?.col === ci && 'on')} style={{ gridColumn: ci + 2, gridRow: 1 }}>
                <small>{format(ref, 'EEE')}</small>
                <b>{format(ref, 'd')}</b>
                <span>{format(ref, 'MMM')}</span>
              </div>
            );
          })}
          {/* Each label sits beside the row it names: "9 AM" is the 9:00–9:30 box, "9:30" the next. */}
          {ref0.map((t0, r) => {
            const hour = new Date(t0).getMinutes() === 0;
            return (
              <div key={r} className={cls('pg-time', hour ? 'hour' : 'half', hover?.row === r && 'on')} style={{ gridColumn: 1, gridRow: r + 2 }}>
                {hour ? format(t0, 'h a') : format(t0, 'h:mm')}
              </div>
            );
          })}
          {v.days.map((d, ci) => cellsFor(d, ci))}
        </div>
      </div>
      {tip && <div className="pg-pop" style={{ left: hover!.x, top: hover!.y }}>{tip}</div>}
    </div>
  );
}

function PollView({ v }: { v: PublicView }) {
  // Remember who you are on this link (so you can come back and edit your answer).
  const key = `poll-${v.id}-me`;
  const saved = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') as { id: string; name: string } | null; } catch { return null; }
  }, [key]);
  const me = useMemo(() => saved ?? { id: Math.random().toString(36).slice(2, 10), name: '' }, [saved]);
  const link = useStore((s) => s.links.find((l) => l.id === v.id));
  const existing = link?.responses.find((r) => r.id === me.id);
  const [name, setName] = useState(existing?.name ?? me.name);
  const [cells, setCells] = useState<Set<number>>(new Set(existing?.cells ?? []));
  const [state, setState] = useState<'idle' | 'saved'>('idle');
  const others = v.responses.filter((r) => r.name !== (existing?.name ?? ''));

  if (v.closed && v.finalStart)
    return (
      <div className="gp-card gp-done">
        <div className="gp-check">✓</div>
        <h1 className="gp-title">{v.title}</h1>
        <p className="gp-when">Scheduled for {format(v.finalStart, 'EEEE, MMMM d')} · {fmtTimeRange(v.finalStart, v.finalStart + v.durationMin * MIN)}</p>
        <div className="gp-actions">
          <a className="gp-btn" href={`data:text/calendar;charset=utf-8,${encodeURIComponent(icsFor(v.title, v.finalStart, v.finalStart + v.durationMin * MIN, v.location))}`} download={`${v.title}.ics`}>Add to my calendar</a>
        </div>
      </div>
    );
  const save = () => {
    if (!name.trim()) return;
    localStorage.setItem(key, JSON.stringify({ id: me.id, name: name.trim() }));
    useStore.getState().savePollResponse(v.id, { id: me.id, name, cells: [...cells] });
    setState('saved');
  };
  const hours = (cells.size * v.cellMin) / 60;
  return (
    <div className="gp-card wide">
      <Header v={v} />
      {others.length > 0 && (
        <div className="gp-answered"><Avatars names={others.map((o) => o.name)} max={8} /><span>{others.length} {others.length === 1 ? 'person has' : 'people have'} answered</span></div>
      )}
      <PollGrid v={v} mine={cells} onChange={(c) => { setCells(c); setState('idle'); }} extra={others} />
      <div className="gp-poll-bar">
        <input className="gp-input" placeholder="Your name" value={name} onChange={(e) => { setName(e.target.value); setState('idle'); }} />
        <span className="gp-picked-n">{cells.size ? `${hours % 1 ? hours.toFixed(1) : hours} h selected` : 'Nothing selected yet'}</span>
        <button className={cls('gp-btn', state === 'saved' && 'ok')} onClick={save} disabled={!name.trim()}>{state === 'saved' ? 'Saved ✓' : existing ? 'Update my times' : 'Save my times'}</button>
      </div>
    </div>
  );
}

export function GuestPage({ id }: { id: string }) {
  const v = usePublicView(id);
  useEffect(() => {
    document.title = v ? `${v.title}${v.hostName ? ` · ${v.hostName}` : ''}` : 'Link not found';
  }, [v]);
  return (
    <div className="gp">
      {!v ? (
        <div className="gp-card"><h1 className="gp-title">This link doesn't exist</h1><p className="gp-empty">It may have been deleted. Ask for a new one.</p></div>
      ) : v.mode === 'book' ? (
        <BookView v={v} />
      ) : (
        <PollView v={v} />
      )}
    </div>
  );
}
