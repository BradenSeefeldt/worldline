import { Suspense, lazy, useEffect } from 'react';
import { DAYS_IN_VIEW, useStore } from './data/store';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { EventPanel } from './components/EventPanel';
import { TaskPanel } from './components/TaskPanel';
import { DragGhost } from './components/BlockDrag';
import { QuickAdd } from './components/QuickAdd';
import { HabitsPage } from './components/Habits';
import { Toast } from './components/Toast';
import { TimeGrid } from './views/TimeGrid';
import { MonthView } from './views/MonthView';
import { useMediaQuery } from './lib/hooks';
import { cls } from './lib/format';
import { applyTheme } from './lib/theme';
import { localZone, zoneAbbr, zoneCity } from './lib/zone';

// The Projects tab brings a document editor with it: load it the first time it's opened.
const ProjectsPage = lazy(() => import('./components/Projects').then((m) => ({ default: m.ProjectsPage })));

const inField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]');

export default function App() {
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const hasSelection = useStore((s) => s.selectedId !== null);
  const quickAddOpen = useStore((s) => s.quickAddOpen);
  const page = useStore((s) => s.page);
  const theme = useStore((s) => s.theme);
  // The chosen theme; "System" also follows the computer switching between light and dark.
  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme(theme);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);
  const phone = useMediaQuery('(max-width: 699px)');
  const navSeq = useStore((s) => s.nav.seq);
  const zone = useStore((s) => s.zone);

  // Notice when this computer's time zone changes (you landed somewhere): check every 30 s
  // and whenever the app comes back to the foreground.
  useEffect(() => {
    const check = () => {
      const z = localZone();
      const st = useStore.getState();
      if (z === st.zone) return;
      st.setZone(z);
      st.showToast(`Time zone changed to ${zoneCity(z)} (${zoneAbbr(z)}) · times now shown in local time`, false);
    };
    check();
    const id = setInterval(check, 30_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  // Subscribed calendars (department, team, …): refresh now, every 30 min, and on coming back to the app if it's been a while.
  useEffect(() => {
    const st = () => useStore.getState();
    const stale = () => st().calendars.some((c) => c.url && Date.now() - (c.lastSync ?? 0) > 30 * 60_000);
    void st().refreshSubscriptions();
    const id = setInterval(() => void st().refreshSubscriptions(), 30 * 60_000);
    const onFocus = () => stale() && void st().refreshSubscriptions();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // On a phone the sidebar is a drawer: close it on narrow screens and after picking a date.
  useEffect(() => {
    if (phone) useStore.getState().setSidebarOpen(false);
  }, [phone, navSeq]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        (e.target as HTMLElement).blur?.();
        return st.select(null);
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        return st.setQuickAdd(true);
      }
      if (inField(e.target)) return; // let fields keep their own typing and undo
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        return e.shiftKey ? st.redo() : st.undo();
      }
      if (mod || e.altKey || st.quickAddOpen) return;
      const actions: Record<string, () => void> = {
        t: () => (st.setPage('calendar'), st.goToday()),
        d: () => (st.setPage('calendar'), st.setView('day')),
        '3': () => (st.setPage('calendar'), st.setView('3day')),
        w: () => (st.setPage('calendar'), st.setView('week')),
        m: () => (st.setPage('calendar'), st.setView('month')),
        h: () => st.setPage(st.page === 'habits' ? 'calendar' : 'habits'),
        p: () => st.setPage(st.page === 'projects' ? 'calendar' : 'projects'),
        n: () => st.setQuickAdd(true),
        ArrowLeft: () => st.step(-1),
        ArrowRight: () => st.step(1),
        Backspace: () => st.selectedId && (st.tasks.some((t) => t.id === st.selectedId) ? st.deleteTask(st.selectedId) : st.deleteEvent(st.selectedId)),
        Delete: () => st.selectedId && (st.tasks.some((t) => t.id === st.selectedId) ? st.deleteTask(st.selectedId) : st.deleteEvent(st.selectedId)),
      };
      const fn = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (fn) {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={cls('app', sidebarOpen && 'sidebar-open', phone && 'phone')}>
      <Sidebar />
      {phone && sidebarOpen && <div className="scrim" onClick={() => useStore.getState().setSidebarOpen(false)} />}
      <main className="main">
        <Toolbar />
        <div className="view" key={zone /* redraw everything in the new zone */}>
          {page === 'habits' ? (
            <HabitsPage />
          ) : page === 'projects' ? (
            <Suspense fallback={null}>
              <ProjectsPage />
            </Suspense>
          ) : (
            <>
              {view === 'month' ? <MonthView /> : <TimeGrid key={view} days={DAYS_IN_VIEW[view]} />}
              {hasSelection && <EventPanel />}
              {hasSelection && <TaskPanel />}
            </>
          )}
        </div>
      </main>
      {quickAddOpen && <QuickAdd />}
      <Toast />
      <DragGhost />
    </div>
  );
}
