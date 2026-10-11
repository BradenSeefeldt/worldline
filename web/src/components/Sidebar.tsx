import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { addDays, addMonths, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { useStore } from '../data/store';
import { useEventsIn } from '../data/useEvents';
import { weekNumber, weekStart } from '../lib/dates';
import { useNow } from '../lib/hooks';
import { cls, fmtTime } from '../lib/format';
import { URGENCY_COLOR, countdown, urgency, workingDays, type Urgency } from '../lib/deadlines';
import { Chevron } from './Icons';
import { HabitEditor, HabitsBadge, HabitsCardBody } from './Habits';
import { CalendarEditor } from './CalendarEditor';
import { TasksBody, useTaskSummary } from './TasksSection';
import { justDragged, startBlockDrag } from './BlockDrag';
import { SchedulingBody } from './Scheduling';
import { landingIndex, moveTo, orderedIds, shiftFor } from '../lib/reorder';
import { restartToUpdate } from '../lib/updates';

function MiniMonth() {
  const range = useStore((s) => s.visibleRange);
  const showDeadlines = useStore((s) => s.showDeadlines);
  const goTo = useStore((s) => s.goTo);
  const onCalendar = useStore((s) => s.page === 'calendar');
  const calendars = useStore((s) => s.calendars);
  // Follows the main view; the arrows browse ahead/behind until the main view moves again.
  const followed = startOfMonth(range.start).getTime();
  const [browse, setBrowse] = useState({ base: followed, delta: 0 });
  const delta = browse.base === followed ? browse.delta : 0;
  const month = addMonths(followed, delta).getTime();
  const setMonth = (m: number) => setBrowse({ base: followed, delta: delta + (m > month ? 1 : -1) });

  const today = new Date();
  const weekNums = useStore((s) => s.settings.weekNumbers);
  const gridStart = startOfWeek(month, { weekStartsOn: weekStart() });
  const days = Array.from({ length: 42 }, (_, k) => addDays(gridStart, k));
  const events = useEventsIn(gridStart.getTime(), addDays(gridStart, 42).getTime());

  // Days that have at least one visible event get a dot.
  const busy = useMemo(() => {
    const visible = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
    const a = gridStart.getTime();
    const b = addDays(gridStart, 42).getTime();
    const set = new Set<number>();
    for (const e of events) {
      if (!(e.kind === 'deadline' ? showDeadlines : visible.has(e.calendarId)) || e.end < a || e.start >= b) continue;
      for (let d = startOfDay(Math.max(e.start, a)); d.getTime() < Math.min(e.end, b); d = addDays(d, 1)) set.add(d.getTime());
    }
    return set;
  }, [events, calendars, showDeadlines, gridStart.getTime()]);

  return (
    <div className="mini">
      <div className="mini-head">
        <span className="mini-title">{format(month, 'MMMM yyyy')}</span>
        <button className="icon-btn sm" onClick={() => setMonth(addMonths(month, -1).getTime())} aria-label="Previous month">
          <Chevron dir="left" />
        </button>
        <button className="icon-btn sm" onClick={() => setMonth(addMonths(month, 1).getTime())} aria-label="Next month">
          <Chevron dir="right" />
        </button>
      </div>
      <div className={cls('mini-grid', weekNums && 'with-wk')}>
        {weekNums && <span className="mini-dow mini-wk" title="Week number">W</span>}
        {days.slice(0, 7).map((d) => (
          <span key={'h' + d.getDay()} className="mini-dow">{format(d, 'EEEEE')}</span>
        ))}
        {days.flatMap((d, i) => {
          const t = d.getTime();
          const inRange = onCalendar && t >= range.start && t < range.end; // the Habits page shows no range
          // The shown days are one rounded band per row: round its two ends.
          const startsBand = inRange && (i % 7 === 0 || t === range.start);
          const endsBand = inRange && (i % 7 === 6 || addDays(d, 1).getTime() >= range.end);
          const wk = weekNums && i % 7 === 0 ? [<span key={'w' + t} className="mini-wk">{weekNumber(d)}</span>] : [];
          return [...wk, (
            <button
              key={t}
              className={cls(
                'mini-day',
                !isSameMonth(d, month) && 'other',
                isSameDay(d, today) && 'today',
                inRange && 'in-range',
                startsBand && 'band-start',
                endsBand && 'band-end',
                busy.has(t) && 'busy',
              )}
              onClick={() => (useStore.getState().setPage('calendar'), goTo(t))}
            >
              <span className="mini-num">{d.getDate()}</span>
            </button>
          )];
        })}
      </div>
    </div>
  );
}

/** A sidebar section whose header folds it away (remembered). `summary` shows while folded. */
const CalGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
    <path d="M2.5 6.5h11" />
  </svg>
);

const ICONS: Record<string, ReactNode> = {
  tasks: <path d="M3.5 8.2 6.3 11 12.5 4.8" />,
  deadlines: <path d="M4 14V2.5M4 3h7.5l-1.8 2.75L11.5 8.5H4" />,
  scheduling: (
    <>
      <circle cx="8" cy="8.5" r="5.5" />
      <path d="M8 5.5v3l2 1.5" />
    </>
  ),
  habits: (
    <>
      <path d="M8 1.75A6.25 6.25 0 1 1 1.75 8" />
      <path d="M8 4.25A3.75 3.75 0 1 1 4.6 9.6" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  calendars: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
};

function Section({ id, title, summary, badge, actions, accent, className, children }: {
  id: string;
  title: string;
  accent?: string; // colour for the icon and count badge (deadlines: the most urgent one)
  summary?: ReactNode; // shown while folded
  badge?: ReactNode; // always shown next to the title
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const collapsed = useStore((s) => !!s.collapsed[id]);
  const toggle = useStore((s) => s.toggleSection);
  return (
    <div className={cls('side-section', `sec-${id}`, collapsed && 'collapsed', className)} style={accent ? ({ '--accent-c': accent } as CSSProperties) : undefined}>
      <div className="side-head">
        <button className="side-head-btn" onClick={() => toggle(id)} aria-expanded={!collapsed} title={collapsed ? `Show ${title}` : `Hide ${title}`}>
          <svg className="side-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {ICONS[id]}
          </svg>
          <span className="side-title">{title}</span>
          {badge}
          {summary && <span className="side-summary-wrap">{summary}</span>}
        </button>
        {actions}
        <button className="side-fold" onClick={() => toggle(id)} aria-label={collapsed ? `Show ${title}` : `Hide ${title}`} title={collapsed ? 'Expand' : 'Collapse'}>
          <svg className="side-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {/* the body slides closed (grid-rows 1fr → 0fr) rather than popping out */}
      <div className="side-body" aria-hidden={collapsed} inert={collapsed}>
        <div className="side-body-inner">{children}</div>
      </div>
    </div>
  );
}

function Calendars() {
  const calendars = useStore((s) => s.calendars);
  const toggle = useStore((s) => s.toggleCalendar);
  const defaultId = useStore((s) => s.defaultCalendarId);
  const [editing, setEditing] = useState<string | null>(null); // calendar id, 'new', or none
  return (
    <Section
      id="calendars"
      title="Calendars"
      summary={
        <span className="side-summary">
          {calendars.filter((c) => c.visible).map((c) => (
            <i key={c.id} className="side-dot" style={{ background: c.color }} title={c.name} />
          ))}
        </span>
      }
      actions={
        <button className="side-add" onClick={() => setEditing('new')} title="Add a calendar: new, subscribe to a link, or import a file" aria-label="Add a calendar">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      }
    >
      {calendars.map((c) => (
        // htmlFor: a label otherwise "clicks" its first button (the star) instead of the switch
        <label
          key={c.id}
          htmlFor={`cal-toggle-${c.id}`}
          className={cls('cal-row', !c.visible && 'off')}
          style={{ '--c': c.color } as CSSProperties}
          title={c.visible ? `Hide ${c.name}` : `Show ${c.name}`}
        >
          <i className="cal-dot" />
          <span className="cal-name">{c.name}</span>
          {/* the default calendar and a subscription that couldn't update are marked; changing either is in the ⋯ card */}
          {c.url && c.syncError ? (
            <span className="cal-mark err" title={`Couldn't update: ${c.syncError}`}>!</span>
          ) : c.id === defaultId ? (
            <span className="cal-mark" title="Default calendar for new events" aria-label="default calendar">★</span>
          ) : null}
          <button
            className="cal-edit"
            title={`Edit ${c.name}`}
            aria-label={`Edit ${c.name}`}
            onClick={(e) => {
              e.preventDefault();
              setEditing(c.id);
            }}
          >
            ⋯
          </button>
          <input id={`cal-toggle-${c.id}`} type="checkbox" className="cal-switch" checked={c.visible} onChange={() => toggle(c.id)} aria-label={`Show ${c.name}`} />
        </label>
      ))}
      {editing && <CalendarEditor id={editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

/** Open deadlines, soonest first, with a countdown — replaces "Up next". */
function Deadlines() {
  const selectedId = useStore((s) => s.selectedId);
  const showOnCalendar = useStore((s) => s.showDeadlines);
  const now = useNow(60_000);
  const today0 = startOfDay(now).getTime();
  const events = useEventsIn(today0 - 120 * 86_400_000, today0 + 400 * 86_400_000);
  const [showAll, setShowAll] = useState(false);
  const list = useMemo(() => events.filter((e) => e.kind === 'deadline' && !e.done).sort((a, b) => a.start - b.start), [events]);
  const tasks = useStore((s) => s.tasks);
  const progress = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const t of tasks) {
      if (!t.parentId) continue;
      const p = m.get(t.parentId) ?? { done: 0, total: 0 };
      p.total++;
      if (t.done) p.done++;
      m.set(t.parentId, p);
    }
    return m;
  }, [tasks]);
  const st = useStore.getState;
  const overdue = list.filter((e) => e.start < now);
  // The most urgent open deadline sets the card's colour (red if anything is overdue), even when folded.
  const RANK: Urgency[] = ['plenty', 'halfway', 'closing', 'overdue'];
  const worst = list.reduce<Urgency | null>((w, e) => {
    const u = urgency(e, now);
    return !w || RANK.indexOf(u) > RANK.indexOf(w) ? u : w;
  }, null);
  const upcoming = list.filter((e) => e.start >= now);
  const shown = showAll ? upcoming : upcoming.slice(0, 5);

  const row = (e: (typeof list)[number]) => {
    const u = urgency(e, now);
    return (
      <div
        key={e.id}
        className={cls('dl-item', u, e.id === selectedId && 'selected')}
        style={{ '--c': URGENCY_COLOR[u] } as CSSProperties}
        role="button"
        tabIndex={0}
        onPointerDown={(ev) => startBlockDrag(ev, { kind: 'deadline', id: e.id, title: e.title })}
        title="Click to open · drag onto the calendar to block out work time"
        onClick={() => {
          if (justDragged()) return;
          st().toggleSelect(e.id);
          st().goTo(e.start);
        }}
      >
        <button
          className="dl-check"
          title="Mark done"
          aria-label={`Mark ${e.title} done`}
          onClick={(ev) => {
            ev.stopPropagation();
            st().setDone(e.id, true);
          }}
        />
        <span className="dl-body">
          <span className="dl-title">{e.title}</span>
          <span className="dl-date">
            {format(e.start, 'EEE MMM d')} · {fmtTime(e.start)}
            {progress.get(e.id) && <span className="dl-steps"> · ✓ {progress.get(e.id)!.done}/{progress.get(e.id)!.total}</span>}
          </span>
        </span>
        <span className="dl-count" title={e.start > now ? `${workingDays(e, now)} working days left` : undefined}>
          {countdown(e, now)}
        </span>
      </div>
    );
  };

  return (
    <Section
      id="deadlines"
      title="Deadlines"
      accent={URGENCY_COLOR[worst ?? 'plenty']} // nothing due: green
      className="upnext"
      badge={
        list.length > 0 && (
          <span className="side-count accent" title={overdue.length ? `${overdue.length} overdue` : 'Open deadlines'}>
            {list.length}
          </span>
        )
      }
      actions={
        <label className="dl-show" htmlFor="dl-toggle" title="Show deadlines on the calendar">
          <CalGlyph />
          <input id="dl-toggle" type="checkbox" className="cal-switch small" checked={showOnCalendar} onChange={(e) => st().setShowDeadlines(e.target.checked)} />
        </label>
      }
    >
      {!list.length && <div className="empty">No deadlines. Try “grant proposal due nov 18” in quick add.</div>}
      {overdue.length > 0 && <div className="dl-group overdue">Overdue</div>}
      {overdue.map(row)}
      {shown.map(row)}
      {upcoming.length > shown.length && (
        <button className="link-btn" onClick={() => setShowAll(true)}>
          {upcoming.length - shown.length} more later
        </button>
      )}
    </Section>
  );
}

function Tasks() {
  const { count, overdue } = useTaskSummary();
  const showOnCalendar = useStore((s) => s.showTasks);
  return (
    <Section
      id="tasks"
      title="Tasks"
      badge={count > 0 && <span className={cls('side-count', overdue && 'overdue')} title={overdue ? 'Today, including overdue' : 'Today'}>{count}</span>}
      actions={
        <label className="dl-show" htmlFor="tk-toggle" title="Show dated tasks on the calendar">
          <CalGlyph />
          <input id="tk-toggle" type="checkbox" className="cal-switch" checked={showOnCalendar} onChange={(e) => useStore.getState().setShowTasks(e.target.checked)} />
        </label>
      }
    >
      <TasksBody />
    </Section>
  );
}

function LinkCount() {
  const n = useStore((s) => s.links.filter((l) => !l.closed).length);
  return n ? <span className="side-count" title="Open scheduling links">{n}</span> : null;
}

function HabitsSection() {
  const [creating, setCreating] = useState(false);
  return (
    <Section
      id="habits"
      title="Habits"
      badge={<HabitsBadge />}
      actions={
        <button className="side-add" onClick={() => setCreating(true)} title="New habit" aria-label="New habit">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      }
    >
      <HabitsCardBody onNew={() => setCreating(true)} />
      {creating && <HabitEditor id="new" onClose={() => setCreating(false)} />}
    </Section>
  );
}

// The cards between the mini month (pinned at the top) and Settings (at the bottom), in their default order.
const CARDS: Record<string, () => ReactNode> = {
  tasks: () => <Tasks />,
  deadlines: () => <Deadlines />,
  habits: () => <HabitsSection />,
  scheduling: () => (
    <Section id="scheduling" title="Scheduling" badge={<LinkCount />}>
      <SchedulingBody />
    </Section>
  ),
  calendars: () => <Calendars />,
};
const CARD_IDS = Object.keys(CARDS);

/**
 * Drag a card by its title row to reorder the sidebar. The card lifts and follows the pointer, the cards it passes
 * slide out of its way, and on release it settles into its new place (saved). A plain click still folds the card;
 * Alt+↑ / Alt+↓ on a focused title moves it too. Mouse and trackpad (a touch on the phone drawer scrolls instead).
 */
function useCardDrag(order: string[]) {
  const els = useRef(new Map<string, HTMLDivElement>());
  const box = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; dy: number; room: number } | null>(null);
  const settle = useRef<{ id: string; top: number } | null>(null);
  const topOf = (el: HTMLElement) => el.getBoundingClientRect().top + (box.current?.scrollTop ?? 0);

  // After a drop: the card is laid out in its new place; start it where it was let go and glide the rest of the way.
  useLayoutEffect(() => {
    const st = settle.current;
    const el = st && els.current.get(st.id);
    settle.current = null;
    if (!st || !el) return;
    const off = st.top - topOf(el);
    el.style.transition = 'none';
    el.style.transform = `translateY(${off}px)`;
    void el.offsetHeight;
    el.style.transition = '';
    el.style.transform = '';
  }, [order]);

  const commit = (next: string[]) => useStore.getState().setSideOrder(next);

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || e.pointerType === 'touch' || !t.closest('.side-head') || t.closest('.side-add, input, select, textarea')) return;
    const from = order.indexOf(id);
    const sx = e.clientX, sy = e.clientY, scroll0 = box.current?.scrollTop ?? 0;
    let live: { tops: number[]; heights: number[]; room: number } | null = null;
    let lastY = sy, raf = 0, to = from;
    const place = () => {
      if (!live) return;
      const dy = lastY - sy + ((box.current?.scrollTop ?? 0) - scroll0);
      to = landingIndex(live.tops, live.heights, from, live.tops[from] + live.heights[from] / 2 + dy);
      setDrag({ id, from, to, dy, room: live.room });
    };
    // near the sidebar's top or bottom edge, keep scrolling it
    const autoscroll = () => {
      const b = box.current;
      if (b && live) {
        const r = b.getBoundingClientRect();
        const v = lastY < r.top + 40 ? -8 : lastY > r.bottom - 40 ? 8 : 0;
        if (v) {
          b.scrollTop += v;
          place();
        }
      }
      raf = requestAnimationFrame(autoscroll);
    };
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (!live) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        const list = order.map((x) => els.current.get(x)!);
        const tops = list.map(topOf), heights = list.map((el) => el.offsetHeight);
        const gap = tops.length > 1 ? tops[1] - tops[0] - heights[0] : 10;
        live = { tops, heights, room: heights[from] + gap };
        document.body.classList.add('side-dragging');
        raf = requestAnimationFrame(autoscroll);
      }
      ev.preventDefault();
      place();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      document.body.classList.remove('side-dragging');
      if (!live) return; // a click: let it fold the card as usual
      // the click that ends a drag must not also fold the card (and if no click comes, don't eat the next one)
      const eat = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', eat, true), 60);
      const el = els.current.get(id);
      settle.current = el ? { id, top: topOf(el) } : null;
      setDrag(null);
      if (to !== from) commit(moveTo(order, id, to));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !(e.target as HTMLElement).closest('.side-head')) return;
    e.preventDefault();
    const i = order.indexOf(id);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return;
    commit(moveTo(order, id, j));
    requestAnimationFrame(() => els.current.get(id)?.querySelector<HTMLElement>('.side-head-btn')?.focus());
  };

  const slot = (id: string, i: number) => ({
    ref: (el: HTMLDivElement | null) => void (el ? els.current.set(id, el) : els.current.delete(id)),
    className: cls('side-slot', drag?.id === id && 'lifted', drag && drag.id !== id && 'making-room'),
    style: drag ? { transform: `translateY(${drag.id === id ? drag.dy : shiftFor(i, drag.from, drag.to, drag.room)}px)` } : undefined,
    onPointerDown: (e: React.PointerEvent) => onPointerDown(e, id),
    onKeyDown: (e: React.KeyboardEvent) => onKeyDown(e, id),
  });
  return { box, slot };
}

/** A new version has been downloaded: one quiet button to restart into it. */
function UpdateReady() {
  const u = useStore((s) => s.update);
  if (u.state !== 'ready') return null;
  return (
    <button className="side-update" onClick={() => void restartToUpdate()} title="Everything is saved first">
      ↻ Update to {u.version} · Restart
    </button>
  );
}

export function Sidebar() {
  const saved = useStore((s) => s.sideOrder);
  const order = useMemo(() => orderedIds(saved, CARD_IDS), [saved]);
  const { box, slot } = useCardDrag(order);
  return (
    <aside className="sidebar" ref={box}>
      {/* the Mac app: a strip for the window buttons (red / yellow / green) that also drags the window */}
      <div className="win-strip" data-tauri-drag-region />
      <MiniMonth />
      {order.map((id, i) => (
        <div key={id} {...slot(id, i)}>
          {CARDS[id]()}
        </div>
      ))}
      <UpdateReady />
      <button className="side-settings" onClick={() => useStore.getState().openSettings('general')} title="Settings (⌘,)">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" />
        </svg>
        Settings
      </button>
    </aside>
  );
}
