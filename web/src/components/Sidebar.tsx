import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { addDays, addMonths, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { useStore } from '../data/store';
import { useEventsIn } from '../data/useEvents';
import { WEEK_STARTS_ON } from '../lib/dates';
import { useNow } from '../lib/hooks';
import { cls } from '../lib/format';
import { URGENCY_COLOR, countdown, urgency, workingDays, type Urgency } from '../lib/deadlines';
import { Chevron } from './Icons';
import { HabitEditor, HabitsBadge, HabitsCardBody } from './Habits';
import { CalendarEditor } from './CalendarEditor';
import { TasksBody, useTaskSummary } from './TasksSection';
import { justDragged, startBlockDrag } from './BlockDrag';
import { SchedulingBody } from './Scheduling';
import { Settings } from './Settings';

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
  const gridStart = startOfWeek(month, { weekStartsOn: WEEK_STARTS_ON });
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
      <div className="mini-grid">
        {days.slice(0, 7).map((d) => (
          <span key={'h' + d.getDay()} className="mini-dow">{format(d, 'EEEEE')}</span>
        ))}
        {days.map((d, i) => {
          const t = d.getTime();
          const inRange = onCalendar && t >= range.start && t < range.end; // the Habits page shows no range
          // The shown days are one rounded band per row: round its two ends.
          const startsBand = inRange && (i % 7 === 0 || t === range.start);
          const endsBand = inRange && (i % 7 === 6 || addDays(d, 1).getTime() >= range.end);
          return (
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
          );
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
  const setDefault = useStore((s) => s.setDefaultCalendar);
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
          {c.url ? (
            <span className={cls('cal-sub', c.syncError && 'err')} title={c.syncError ? `Couldn't update: ${c.syncError}` : 'Subscribed (read-only), kept up to date'}>{c.syncError ? '!' : '↻'}</span>
          ) : <button
            className={cls('cal-star', c.id === defaultId && 'on')}
            title={c.id === defaultId ? 'Default calendar for new events' : 'Make this the default calendar for new events'}
            aria-label={c.id === defaultId ? `${c.name} is the default calendar for new events` : `Make ${c.name} the default calendar for new events`}
            onClick={(e) => {
              e.preventDefault();
              setDefault(c.id);
            }}
          >
            {c.id === defaultId ? '★' : '☆'}
          </button>}
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
            {format(e.start, 'EEE MMM d')} · {format(e.start, 'h:mm a').replace(':00', '')}
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

export function Sidebar() {
  const [settings, setSettings] = useState(false);
  return (
    <aside className="sidebar">
      {/* the Mac app: a strip for the window buttons (red / yellow / green) that also drags the window */}
      <div className="win-strip" data-tauri-drag-region />
      <MiniMonth />
      <Tasks />
      <Deadlines />
      <HabitsSection />
      <Section id="scheduling" title="Scheduling" badge={<LinkCount />}>
        <SchedulingBody />
      </Section>
      <Calendars />
      <button className="side-settings" onClick={() => setSettings(true)}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" />
        </svg>
        Settings
      </button>
      {settings && <Settings onClose={() => setSettings(false)} />}
    </aside>
  );
}
