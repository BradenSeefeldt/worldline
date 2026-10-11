import { Suspense, lazy, useEffect } from 'react';
import { DAYS_IN_VIEW, useStore } from './data/store';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { Fab, PhoneTabs, PhoneTopBar, useEdgeSwipe } from './components/PhoneBars';
import { EventPanel } from './components/EventPanel';
import { TaskPanel } from './components/TaskPanel';
import { DragGhost } from './components/BlockDrag';
import { QuickAdd } from './components/QuickAdd';
import { HabitsPage } from './components/Habits';
import { Toast } from './components/Toast';
import { ConfirmHost } from './components/Confirm';
import { Settings } from './components/Settings';
import { TimeGrid } from './views/TimeGrid';
import { MonthView } from './views/MonthView';
import { useMediaQuery } from './lib/hooks';
import { cls } from './lib/format';
import { applyTheme } from './lib/theme';
import { localZone, zoneAbbr, zoneCity } from './lib/zone';
import { onSaveTrouble } from './data/persist';
import { checkForUpdate } from './lib/updates';
import { isApp } from './lib/platform';

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
  const themeLight = useStore((s) => s.settings.themeLight);
  const themeDark = useStore((s) => s.settings.themeDark);
  // The chosen theme; "System" follows the Mac switching between your light theme and your dark theme.
  useEffect(() => {
    const pair = { light: themeLight, dark: themeDark };
    applyTheme(theme, pair);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyTheme(theme, pair);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme, themeLight, themeDark]);
  // Settings the whole calendar is drawn with: when one changes, the views redraw from scratch (like a zone change).
  const weekStartsOn = useStore((s) => s.settings.weekStartsOn);
  const hour24 = useStore((s) => s.settings.hour24);
  const hideWeekends = useStore((s) => s.settings.hideWeekends);
  const eventStyle = useStore((s) => s.settings.eventStyle);
  const subsEvery = useStore((s) => s.settings.subsRefreshMin) * 60_000;
  const phone = useMediaQuery('(max-width: 699px)');
  const navSeq = useStore((s) => s.nav.seq);
  useEdgeSwipe(phone); // a phone: drag the sidebar out from the left edge
  const zone = useStore((s) => s.zone);

  // Automatic updates (the Mac app): a first look a minute after launch, then once a day.
  const autoUpdate = useStore((s) => s.settings.autoUpdate);
  useEffect(() => {
    if (!isApp() || !autoUpdate) return;
    const look = () => void checkForUpdate(useStore.getState().setUpdate);
    const first = setTimeout(look, 60_000);
    const daily = setInterval(look, 24 * 3_600_000);
    return () => {
      clearTimeout(first);
      clearInterval(daily);
    };
  }, [autoUpdate]);

  // Saving failed (disk full, database locked…): say so once; it keeps trying and says when it works again.
  useEffect(
    () => onSaveTrouble((ok) => useStore.getState().showToast(ok ? 'Saving works again — everything is saved' : 'Couldn’t save your latest changes — trying again…', false)),
    [],
  );

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
    const stale = () => st().calendars.some((c) => c.url && Date.now() - (c.lastSync ?? 0) > subsEvery);
    void st().refreshSubscriptions();
    const id = setInterval(() => void st().refreshSubscriptions(), subsEvery); // Settings → Calendars
    const onFocus = () => stale() && void st().refreshSubscriptions();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [subsEvery]);

  // On a phone the sidebar is a drawer: close it on narrow screens and after picking a date.
  useEffect(() => {
    if (phone) useStore.getState().setSidebarOpen(false);
  }, [phone, navSeq]);
  // a phone: going to another page (the tabs) folds the month back into the week strip
  useEffect(() => useStore.getState().setPhoneMonth(false), [page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        (e.target as HTMLElement).blur?.();
        return st.select(null);
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        return st.openSettings(st.settingsOpen ? null : 'general');
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
    <div className={cls('app', sidebarOpen && 'sidebar-open', phone && 'phone')} data-events={eventStyle}>
      <Sidebar />
      {phone && sidebarOpen && <div className="scrim" onClick={() => useStore.getState().setSidebarOpen(false)} />}
      <main className="main">
        {phone ? <PhoneTopBar /> : <Toolbar />}
        <div className="view" key={`${zone}|${weekStartsOn}|${hour24}|${hideWeekends}` /* redraw everything in the new zone / week / clock */}>
          {page === 'habits' ? (
            <HabitsPage />
          ) : page === 'projects' ? (
            <Suspense fallback={null}>
              <ProjectsPage />
            </Suspense>
          ) : (
            <>
              {view === 'month' ? <MonthView /> : <TimeGrid key={view} days={view === 'week' && hideWeekends ? 5 : DAYS_IN_VIEW[view]} />}
              {hasSelection && <EventPanel />}
              {hasSelection && <TaskPanel />}
            </>
          )}
        </div>
        {phone && <PhoneTabs />}
      </main>
      {phone && <Fab />}
      {quickAddOpen && <QuickAdd />}
      <Toast />
      <Settings />
      <ConfirmHost />
      <DragGhost />
    </div>
  );
}
