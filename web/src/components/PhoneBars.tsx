// The iPhone layout (screens under 700 px wide): the top holds where you are (☰, the month, the view, Today, and a
// week strip that opens into the whole month); the bottom holds where to go (Calendar · Habits · Projects · Settings)
// and a big + floating bottom-right, where a thumb reaches. The sidebar is the same as on the Mac, as a drawer: ☰, or
// drag it out from the left edge of the screen.
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { addDays, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from 'date-fns';
import { useStore } from '../data/store';
import { useEventsIn } from '../data/useEvents';
import { weekStart } from '../lib/dates';
import { cls } from '../lib/format';
import { ViewMenu } from './Toolbar';
import { ZonePill } from './ZonePill';
import { HabitGlyph } from './Habits';
import { ProjectGlyph } from './Icons';
import { ProjectsBar } from './ProjectsBar';

const Menu = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);

function SidebarButton() {
  return (
    <button className="ptb-btn" onClick={() => useStore.getState().setSidebarOpen(true)} aria-label="Show the sidebar">
      <Menu />
    </button>
  );
}

/** The days of the week on screen (or, opened, the whole month), with a dot under days that have something on. */
function DayStrip({ month }: { month: boolean }) {
  const range = useStore((s) => s.visibleRange);
  const calendars = useStore((s) => s.calendars);
  const { goTo, setPhoneMonth } = useStore.getState();
  const ws = weekStart();
  const first = month ? startOfWeek(startOfMonth(range.start), { weekStartsOn: ws }) : startOfWeek(range.start, { weekStartsOn: ws });
  const days = Array.from({ length: month ? 42 : 7 }, (_, k) => addDays(first, k));
  const events = useEventsIn(days[0].getTime(), addDays(days[days.length - 1], 1).getTime());
  const busy = useMemo(() => {
    const visible = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
    const set = new Set<number>();
    for (const e of events) if (e.kind !== 'deadline' && e.kind !== 'task' && visible.has(e.calendarId)) set.add(startOfDay(e.start).getTime());
    return set;
  }, [events, calendars]);
  const today = new Date();
  // swipe sideways: the week (or month) before / after
  const swipe = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className={cls('pds', month && 'month')}
      onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY })}
      onPointerUp={(e) => {
        const s = swipe.current;
        swipe.current = null;
        if (!s) return;
        const dx = e.clientX - s.x, dy = e.clientY - s.y;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) goTo(addDays(range.start, (dx < 0 ? 1 : -1) * (month ? 35 : 7)).getTime());
      }}
    >
      <div className="pds-row pds-head">
        {days.slice(0, 7).map((d) => <span key={d.getTime()}>{format(d, 'EEEEE')}</span>)}
      </div>
      <div className="pds-row">
        {days.map((d) => {
          const t = d.getTime();
          const inView = t >= startOfDay(range.start).getTime() && t < range.end;
          return (
            <button
              key={t}
              className={cls('pds-day', isSameDay(d, today) && 'today', inView && !month && 'in', month && !isSameMonth(d, range.start) && 'out')}
              onClick={() => {
                goTo(t);
                setPhoneMonth(false);
              }}
              aria-label={format(d, 'EEEE MMMM d')}
            >
              {format(d, 'd')}
              {busy.has(t) && <i />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PhoneTopBar() {
  const page = useStore((s) => s.page);
  const view = useStore((s) => s.view);
  const range = useStore((s) => s.visibleRange);
  const away = useStore((s) => s.zone !== s.homeZone);
  const month = useStore((s) => s.phoneMonth);
  const { goToday, setPhoneMonth } = useStore.getState();
  if (page === 'projects')
    return (
      <header className="ptb">
        <div className="ptb-row">
          <SidebarButton />
          <ProjectsBar compact />
        </div>
      </header>
    );
  if (page === 'habits')
    return (
      <header className="ptb">
        <div className="ptb-row">
          <SidebarButton />
          <h1 className="ptb-title">Habits</h1>
        </div>
      </header>
    );
  const mid = new Date((range.start + range.end) / 2);
  return (
    <header className="ptb">
      <div className="ptb-row">
        <SidebarButton />
        <button className={cls('ptb-title', 'ptb-month', month && 'open')} onClick={() => setPhoneMonth(!month)} aria-expanded={month} aria-label={month ? 'Hide the month' : 'Show the whole month'}>
          {format(mid, 'MMMM')} <span>{format(mid, 'yyyy')}</span>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6l4 4 4-4" /></svg>
        </button>
        <span className="ptb-gap" />
        {away && <ZonePill />}
        <ViewMenu />
        <button className="ptb-today" onClick={() => { goToday(); setPhoneMonth(false); }} aria-label="Today" title="Today">
          {format(new Date(), 'd')}
        </button>
      </div>
      {(view !== 'month' || month) && <DayStrip month={month} />}
    </header>
  );
}

function Tab({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className={cls('ptab', on && 'on')} role="tab" aria-selected={on} onClick={onClick}>
      {children}
      <span>{label}</span>
    </button>
  );
}

export function PhoneTabs() {
  const page = useStore((s) => s.page);
  const settings = useStore((s) => !!s.settingsOpen);
  const { setPage, openSettings } = useStore.getState();
  const go = (p: 'calendar' | 'habits' | 'projects') => () => {
    openSettings(null);
    setPage(p);
  };
  return (
    <nav className="ptabs" role="tablist" aria-label="Page">
      <Tab on={!settings && page === 'calendar'} label="Calendar" onClick={go('calendar')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><rect x="3" y="4.5" width="18" height="16.5" rx="3" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /></svg>
      </Tab>
      <Tab on={!settings && page === 'habits'} label="Habits" onClick={go('habits')}>
        <HabitGlyph size={26} />
      </Tab>
      <Tab on={!settings && page === 'projects'} label="Projects" onClick={go('projects')}>
        <ProjectGlyph size={26} />
      </Tab>
      <Tab on={settings} label="Settings" onClick={() => openSettings(settings ? null : 'general')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v2.7M12 18.8v2.7M2.5 12h2.7M18.8 12h2.7M5.3 5.3l1.9 1.9M16.8 16.8l1.9 1.9M5.3 18.7l1.9-1.9M16.8 7.2l1.9-1.9" /></svg>
      </Tab>
    </nav>
  );
}

/** The big + (quick add), floating over the bottom-right corner. Out of the way while a card or sheet is open. */
export function Fab() {
  const hidden = useStore((s) => s.quickAddOpen || s.selectedId !== null || !!s.settingsOpen || s.sidebarOpen);
  if (hidden) return null;
  return (
    <button className="fab" onClick={() => useStore.getState().setQuickAdd(true)} aria-label="Add an event, task or deadline">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
    </button>
  );
}

/** Drag the sidebar out from the left edge of the screen (it follows the finger), or drag it back shut. */
export function useEdgeSwipe(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let g: { x0: number; y0: number; open: boolean; engaged: boolean; w: number } | null = null;
    const bar = () => document.querySelector<HTMLElement>('.sidebar');
    const scrim = () => document.querySelector<HTMLElement>('.scrim');
    const place = (p: number) => {
      const s = bar();
      if (s) {
        s.style.transition = 'none'; // follow the finger exactly
        s.style.transform = `translateX(${(p - 1) * 105}%)`;
      }
      const m = scrim();
      if (m) m.style.opacity = String(p);
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const open = useStore.getState().sidebarOpen;
      if (!open && t.clientX > 22) return; // from the very edge only (elsewhere: scrolling, swiping days)
      if (open && !(e.target as Element).closest?.('.sidebar, .scrim')) return;
      g = { x0: t.clientX, y0: t.clientY, open, engaged: false, w: bar()?.offsetWidth ?? 300 };
    };
    const move = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0];
      const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
      if (!g.engaged) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (g = null); // scrolling, not swiping
        if (Math.abs(dx) < 8 || (g.open ? dx > 0 : dx < 0)) return;
        g.engaged = true;
        if (!g.open) useStore.getState().setSidebarOpen(true); // (mounts the scrim)
      }
      e.preventDefault();
      const p = Math.max(0, Math.min(1, (g.open ? g.w + dx : dx) / g.w));
      place(p);
    };
    const end = (e: TouchEvent) => {
      if (!g) return;
      const was = g;
      g = null;
      if (!was.engaged) return;
      const dx = (e.changedTouches[0]?.clientX ?? was.x0) - was.x0;
      const open = was.open ? dx > -was.w * 0.3 : dx > was.w * 0.3;
      const s = bar(), m = scrim();
      if (s) {
        s.style.transition = ''; // and from here it slides the rest of the way, open or shut
        void s.offsetWidth;
        s.style.transform = '';
      }
      if (m) m.style.opacity = '';
      useStore.getState().setSidebarOpen(open);
    };
    document.addEventListener('touchstart', start, { capture: true, passive: true });
    document.addEventListener('touchmove', move, { capture: true, passive: false });
    document.addEventListener('touchend', end, { capture: true });
    document.addEventListener('touchcancel', end, { capture: true });
    return () => {
      document.removeEventListener('touchstart', start, { capture: true });
      document.removeEventListener('touchmove', move, { capture: true });
      document.removeEventListener('touchend', end, { capture: true });
      document.removeEventListener('touchcancel', end, { capture: true });
    };
  }, [on]);
}
