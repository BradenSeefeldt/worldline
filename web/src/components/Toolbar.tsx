import { useEffect, useRef, useState } from 'react';
import { format, isSameMonth, isSameYear } from 'date-fns';
import { useStore } from '../data/store';
import type { Range, ViewMode } from '../data/types';
import { cls } from '../lib/format';
import { Chevron, Plus, SidebarIcon, ProjectGlyph } from './Icons';
import { ZonePill } from './ZonePill';
import { HabitGlyph } from './Habits';
import { ProjectsBar } from './ProjectsBar';
import { useMediaQuery } from '../lib/hooks';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const VIEWS: { id: ViewMode; label: string; short: string; key: string }[] = [
  { id: 'day', label: 'Day', short: 'D', key: 'D' },
  { id: '3day', label: '3 Day', short: '3', key: '3' },
  { id: 'week', label: 'Week', short: 'W', key: 'W' },
  { id: 'month', label: 'Month', short: 'M', key: 'M' },
];

function title(r: Range, short = false): [string, string] {
  const a = new Date(r.start);
  const b = new Date(r.end - 1);
  if (isSameMonth(a, b)) return [format(a, short ? 'MMM' : 'MMMM'), format(a, 'yyyy')]; // a phone: "Oct"
  if (isSameYear(a, b)) return [`${format(a, 'MMM')} – ${format(b, 'MMM')}`, format(a, 'yyyy')];
  return [`${format(a, 'MMM yyyy')} – ${format(b, 'MMM')}`, format(b, 'yyyy')];
}

/** The view (Day / 3 Day / Week / Month) as one compact menu; the keys D, 3, W, M still switch directly. */
function ViewMenu() {
  const view = useStore((s) => s.view);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', off, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', off, true);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const cur = VIEWS.find((v) => v.id === view)!;
  return (
    <div className="view-menu" ref={ref}>
      <button className={cls('view-btn', open && 'on')} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="View (D, 3, W, M)">
        {cur.label}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" /></svg>
      </button>
      {open && (
        <div className="view-pop" role="menu">
          {VIEWS.map((v) => (
            <button key={v.id} role="menuitemradio" aria-checked={view === v.id} className={cls(view === v.id && 'on')} onClick={() => { useStore.getState().setView(v.id); setOpen(false); }}>
              <span>{v.label}</span>
              <kbd>{v.key}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const range = useStore((s) => s.visibleRange);
  const { step, goToday, setSidebarOpen, setQuickAdd } = useStore.getState();
  // the time-zone pill only when you're away from home (at home, the grid's corner already says the zone)
  const away = useStore((s) => s.zone !== s.homeZone);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const narrow = useMediaQuery('(max-width: 430px)'); // an iPhone: everything must fit in one row
  const [main, sub] = title(range, narrow);
  const habits = page === 'habits';
  const projects = page === 'projects';
  const calendar = page === 'calendar';

  return (
    // (in the Mac app, dragging the bar's empty space moves the window)
    <header className="toolbar" data-tauri-drag-region>
      <button className="icon-btn" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle sidebar">
        <SidebarIcon />
      </button>
      {/* Two places: the calendar, and the Habits page */}
      <div className="page-switch" role="tablist" aria-label="Page">
        <button role="tab" aria-selected={calendar} className={cls(calendar && 'on')} onClick={() => setPage('calendar')} title="Calendar">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></svg>
          <span className="page-label">Calendar</span>
        </button>
        <button role="tab" aria-selected={habits} className={cls(habits && 'on')} onClick={() => setPage('habits')} title="Habits (H)">
          <HabitGlyph size={15} />
          <span className="page-label">Habits</span>
        </button>
        <button role="tab" aria-selected={projects} className={cls(projects && 'on')} onClick={() => setPage('projects')} title="Projects (P)">
          <ProjectGlyph size={15} />
          <span className="page-label">Projects</span>
        </button>
      </div>
      {/* where you are and how to move: ‹ Week ▾ › October 2026 */}
      {calendar && (
        <div className="nav-group">
          <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous" title="Previous (←)">
            <Chevron dir="left" />
          </button>
          <ViewMenu />
          <button className="icon-btn" onClick={() => step(1)} aria-label="Next" title="Next (→)">
            <Chevron dir="right" />
          </button>
        </div>
      )}
      {calendar && (
        <h1 className="title">
          <span>{main}</span> <span className="title-year">{sub}</span>
        </h1>
      )}
      {/* On Projects the middle of the bar is its search (⌘K still adds from anywhere). Elsewhere: Add. */}
      {projects ? <ProjectsBar /> : (
      <button className="qa-btn" onClick={() => setQuickAdd(true)} aria-label="Add an event, task or deadline" title={`Add — shortcut ${MAC ? '⌘K' : 'Ctrl+K'} (or N when you're not typing in a box)`}>
        <span className="qa-plus"><Plus /></span>
        <span className="qa-label">Add event, task or deadline</span>
        <span className="qa-short">Add</span>
        <kbd className="qa-key">{MAC ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      )}
      <div className="toolbar-right" hidden={!calendar}>
        {away && <ZonePill />}
        <button className="today-btn" onClick={goToday} title="Today (T)">Today</button>
      </div>
    </header>
  );
}
