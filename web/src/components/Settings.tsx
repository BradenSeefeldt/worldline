// Settings, like the Mac's System Settings: sections on the left (with a search box), the chosen section's settings
// on the right as rounded groups of rows — a name and a line of explanation, the control beside it.
// Opens from ⚙ Settings in the sidebar or ⌘, (App.tsx). The settings themselves: data/settings.ts.
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useStore } from '../data/store';
import { DEFAULT_DEADLINE_LOOK, type AppSettings, type DeadlineLook, type StartPage } from '../data/settings';
import type { ViewMode } from '../data/types';
import { HOUR_H_RANGE, readOnly } from '../data/store';
import { TimeZonePicker } from './TimeZonePicker';
import { CalendarEditor } from './CalendarEditor';
import { Close } from './Icons';
import { downloadHabitsCsv } from './Habits';
import { ask } from './Confirm';
import { THEMES, resolveTheme, type ThemeId } from '../lib/theme';
import { cls, fmtTime, fmtWhen } from '../lib/format';
import { APP_VERSION, autostart, confirmUninstall, fetchText, isApp, openExternal, saveFile, uninstallApp } from '../lib/platform';
import { beforeRestore, listSnapshots, replaceSaved, snapshotValue } from '../data/persist';
import { isNewer, makeBackup, readBackup } from '../lib/backup';
import { toIcs } from '../lib/icsExport';
import { relayHealth } from '../data/schedSync';
import { canUpdate, checkForUpdate, restartToUpdate } from '../lib/updates';
import { notificationAccess, testAlert } from '../data/alerts';
import { askMacAccess, macAccess, macCalendarList, macHost, showMacCalendar, type MacAccess, type MacCalendar } from '../data/macCalendars';
import { ALL_DAY_CHOICES, TIMED_CHOICES } from '../lib/alerts';
// (loaded when opened: it carries the QR code maker and reader, which nothing else needs)
const SyncSettings = lazy(() => import('./SyncSettings').then((m) => ({ default: m.SyncSettings })));

const REPO = 'worldline-calendar/worldline';
const STORE_KEY = 'calendar-v1';

const SECTIONS: { id: string; title: string; icon: string; color: string; words: string }[] = [
  { id: 'general', title: 'General', icon: '⚙︎', color: '#8e8e93', words: 'name time zone home week starts monday sunday time format 12 24 hour clock start open login launch keep running window' },
  { id: 'appearance', title: 'Appearance', icon: '◐', color: '#5e5ce6', words: 'theme light dark follow mac colour color hour height zoom event stripe filled' },
  { id: 'calendar', title: 'Calendar', icon: '▦', color: '#ff3b30', words: 'view day week month 3 day starts scroll weekends week numbers default calendar length event travelling home time tasks deadlines runway' },
  { id: 'calendars', title: 'Calendars', icon: '⟳', color: '#34a853', words: 'calendars subscriptions subscribe refresh import ics link feed google outlook' },
  { id: 'alerts', title: 'Alerts', icon: '🔔', color: '#ff3b30', words: 'alerts reminders notifications notify remind before minutes all-day deadline test' },
  { id: 'tasks', title: 'Tasks & Deadlines', icon: '✓', color: '#0a84ff', words: 'deadline due time runway suggestions nudge overdue focus block regular meeting' },
  { id: 'habits', title: 'Habits', icon: '◔', color: '#ff9f0a', words: 'habits calendar count nudge weekly export csv' },
  { id: 'scheduling', title: 'Scheduling', icon: '◷', color: '#af52de', words: 'scheduling booking link poll length hours single use buffer notice relays' },
  { id: 'sync', title: 'Sync', icon: '⇄', color: '#00a3a3', words: 'sync iphone phone devices pair pairing qr code join mac' },
  { id: 'data', title: 'Data & Backups', icon: '⛁', color: '#636366', words: 'data backup restore snapshot export ics csv finder erase demo' },
  { id: 'about', title: 'About', icon: 'ⓘ', color: '#30b0c7', words: 'about version update source code licence keyboard shortcuts' },
];
const GAPS = new Set(['calendars', 'scheduling']); // a little space after these in the list

// ---------------------------------------------------------------- building blocks
function Group({ title, foot, children }: { title?: string; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-grp">
      {title && <h3>{title}</h3>}
      <div className="st-box">{children}</div>
      {foot && <p className="st-foot">{foot}</p>}
    </div>
  );
}
function Row({ title, note, children, stack }: { title: ReactNode; note?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={cls('st-row', stack && 'stack')}>
      <div className="st-lab"><b>{title}</b>{note && <span>{note}</span>}</div>
      {children && <div className="st-ctl">{children}</div>}
    </div>
  );
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={cls('st-tog', on && 'on')} onClick={() => onChange(!on)} />;
}
function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <span className="st-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={String(v)} role="radio" aria-checked={v === value} className={cls(v === value && 'on')} onClick={() => onChange(v)}>{l}</button>
      ))}
    </span>
  );
}
function Pick<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <select className="pselect" aria-label={label} value={String(value)} onChange={(e) => onChange(options.find(([v]) => String(v) === e.target.value)![0])}>
      {options.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
    </select>
  );
}
const at = (min: number) => fmtTime(new Date(2026, 0, 1, 0, min).getTime()); // "5 PM" / "17:00"
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fromHhmm = (v: string) => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
const mins = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);

function useSettings() {
  const s = useStore((x) => x.settings);
  const set = useStore((x) => x.setSettings);
  return [s, set] as const;
}

// ---------------------------------------------------------------- the window
export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const openSettings = useStore((s) => s.openSettings);
  const [q, setQ] = useState('');
  const [nested, setNested] = useState(false); // a calendar editor is open on top: Esc closes that first
  const close = () => openSettings(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && !nested && !document.querySelector('.cf') && close();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return SECTIONS.filter((s) => words.every((w) => `${s.title} ${s.words}`.toLowerCase().includes(w)));
  }, [q]);
  if (!open) return null;
  const current = shown.find((s) => s.id === open) ?? shown[0] ?? SECTIONS[0];
  return (
    <div className="ce-scrim st-scrim" onMouseDown={close}>
      <div className="st" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="st-side">
          <label className="st-search">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
            <input placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {shown.map((s) => (
            <div key={s.id} className={cls(GAPS.has(s.id) && !q && 'st-gap-after')}>
              <button className={cls('st-item', s.id === current.id && 'on')} onClick={() => openSettings(s.id)}>
                <span className="st-ico" style={{ '--c': s.color } as CSSProperties}>{s.icon}</span>
                {s.title}
              </button>
            </div>
          ))}
          {!shown.length && <p className="st-none">No setting matches “{q}”</p>}
        </nav>
        <section className="st-main">
          <header className="st-head">
            <h2>{current.title}</h2>
            <button className="icon-btn" onClick={close} aria-label="Close settings (Esc)"><Close /></button>
          </header>
          <div className="st-body" key={current.id}>
            {current.id === 'general' && <General />}
            {current.id === 'appearance' && <Appearance />}
            {current.id === 'calendar' && <CalendarPane />}
            {current.id === 'calendars' && <CalendarsPane onNested={setNested} />}
            {current.id === 'tasks' && <TasksPane />}
            {current.id === 'alerts' && <AlertsPane />}
            {current.id === 'habits' && <HabitsPane />}
            {current.id === 'scheduling' && <SchedulingPane />}
            {current.id === 'sync' && (
              <Suspense fallback={null}>
                <SyncSettings />
              </Suspense>
            )}
            {current.id === 'data' && <DataPane />}
            {current.id === 'about' && <About />}
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- General
function General() {
  const [s, set] = useSettings();
  const myName = useStore((x) => x.myName);
  const homeZone = useStore((x) => x.homeZone);
  const st = useStore.getState();
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => void autostart.get().then(setLogin, () => setLogin(false)), []);
  return (
    <>
      <Group title="You">
        <Row title="Your name" note="Shown on your scheduling links (“Book time with …”)">
          <input className="st-in" value={myName} placeholder="e.g. Sam" onChange={(e) => st.setMyName(e.target.value)} />
        </Row>
        <Row title="Home time zone" note="Where you normally are; a pill and a second hour column appear when you’re away" stack>
          <TimeZonePicker value={homeZone} onChange={st.setHomeZone} />
        </Row>
      </Group>
      <Group title="Dates & times">
        <Row title="Week starts on" note="Week view, the mini month, month view, “this week”, the task chart">
          <Seg label="Week starts on" value={s.weekStartsOn} options={[[1, 'Monday'], [0, 'Sunday']]} onChange={(v) => set({ weekStartsOn: v })} />
        </Row>
        <Row title="Time format" note="Everywhere times are shown. Typing “15:30” or “3:30pm” works either way">
          <Seg label="Time format" value={s.hour24 ? 24 : 12} options={[[12, '12-hour'], [24, '24-hour']]} onChange={(v) => set({ hour24: v === 24 })} />
        </Row>
      </Group>
      <Group title="When Worldline opens">
        <Row title="Start on">
          <Pick<StartPage> label="Start on" value={s.startPage} options={[['last', 'Where I left off'], ['calendar', 'Calendar, today'], ['habits', 'Habits'], ['projects', 'Projects']]} onChange={(v) => set({ startPage: v })} />
        </Row>
        {isApp() && (
          <>
            <Row title="Keep running when the window is closed" note="So scheduling links stay live and bookings keep arriving. ⌘Q quits">
              <Toggle label="Keep running when the window is closed" on={s.keepRunning} onChange={(v) => set({ keepRunning: v })} />
            </Row>
            <Row title="Open at login" note="Starts Worldline (in the background) when you log in to your Mac">
              <Toggle label="Open at login" on={!!login} onChange={async (v) => { await autostart.set(v); setLogin(await autostart.get()); }} />
            </Row>
          </>
        )}
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- Appearance
function ThemeTiles({ list, selected, onPick }: { list: typeof THEMES; selected: ThemeId; onPick: (id: ThemeId) => void }) {
  return (
    <div className="themes st-themes" role="radiogroup">
      {list.map((t) => (
        <button
          key={t.id}
          role="radio"
          aria-checked={selected === t.id}
          className={cls('theme', selected === t.id && 'on')}
          onClick={() => onPick(t.id)}
          title={t.note}
          style={{ '--pb': t.preview.bg, '--pp': t.preview.panel, '--pl': t.preview.line, '--pt': t.preview.text, '--pa': t.preview.accent } as CSSProperties}
        >
          <span className="theme-pv"><i className="pv-side" /><span className="pv-card"><i className="pv-line" /><i className="pv-line short" /><i className="pv-pill" /></span></span>
          <b>{t.name}</b>
          <small>{t.note}</small>
        </button>
      ))}
    </div>
  );
}
function Appearance() {
  const [s, set] = useSettings();
  const theme = useStore((x) => x.theme);
  const hourH = useStore((x) => x.hourH);
  const st = useStore.getState();
  const follow = theme === 'system';
  const light = THEMES.filter((t) => t.dark === false), dark = THEMES.filter((t) => t.dark === true);
  const macDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  return (
    <>
      <Group>
        <Row title="Follow the Mac’s light / dark setting" note="Pick a light theme and a dark theme; Worldline switches between them when your Mac does">
          <Toggle
            label="Follow the Mac’s light / dark setting"
            on={follow}
            onChange={(on) => st.setTheme(on ? 'system' : resolveTheme('system', macDark, { light: s.themeLight, dark: s.themeDark }).theme)}
          />
        </Row>
      </Group>
      {follow ? (
        <>
          <Group title="Light theme — when your Mac is in light mode"><ThemeTiles list={light} selected={s.themeLight} onPick={(id) => set({ themeLight: id })} /></Group>
          <Group title="Dark theme — when your Mac is in dark mode"><ThemeTiles list={dark} selected={s.themeDark} onPick={(id) => set({ themeDark: id })} /></Group>
        </>
      ) : (
        <>
          <Group title="Light themes"><ThemeTiles list={light} selected={theme} onPick={st.setTheme} /></Group>
          <Group title="Dark themes" foot="One theme, always."><ThemeTiles list={dark} selected={theme} onPick={st.setTheme} /></Group>
        </>
      )}
      <Group title="Calendar look">
        <Row title="Hour height" note="Same as pinching the grid (or ⌘-scroll)">
          <input type="range" className="st-range" aria-label="Hour height" min={HOUR_H_RANGE[0]} max={HOUR_H_RANGE[1]} value={hourH} onChange={(e) => st.setHourH(+e.target.value)} />
        </Row>
        <Row title="Event colours" note="The calendar’s colour fills the event, or just a stripe at its edge">
          <Seg label="Event colours" value={s.eventStyle} options={[['filled', 'Filled'], ['stripe', 'Stripe']]} onChange={(v) => set({ eventStyle: v })} />
        </Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- Calendar
function CalendarPane() {
  const [s, set] = useSettings();
  const calendars = useStore((x) => x.calendars);
  const defaultId = useStore((x) => x.defaultCalendarId);
  const showHome = useStore((x) => x.showHomeHours);
  const showTasks = useStore((x) => x.showTasks);
  const showDeadlines = useStore((x) => x.showDeadlines);
  const st = useStore.getState();
  return (
    <>
      <Group title="View">
        <Row title="Default view" note="What the calendar opens in">
          <Seg<ViewMode> label="Default view" value={s.startView} options={[['day', 'Day'], ['3day', '3 Day'], ['week', 'Week'], ['month', 'Month']]} onChange={(v) => { set({ startView: v }); st.setView(v); }} />
        </Row>
        <Row title="Day starts at" note="Where the grid scrolls to when you open a day (today scrolls to now)">
          <Pick label="Day starts at" value={s.dayStartHour} options={[5, 6, 7, 8, 9, 10].map((h) => [h, at(h * 60)] as [number, string])} onChange={(v) => set({ dayStartHour: v })} />
        </Row>
        <Row title="Show weekends" note="Off: the week view shows Monday to Friday">
          <Toggle label="Show weekends" on={!s.hideWeekends} onChange={(on) => set({ hideWeekends: !on })} />
        </Row>
        <Row title="Week numbers" note="In the mini month and month view">
          <Toggle label="Week numbers" on={s.weekNumbers} onChange={(on) => set({ weekNumbers: on })} />
        </Row>
      </Group>
      <Group title="New events">
        <Row title="Default calendar">
          <Pick label="Default calendar" value={defaultId} options={calendars.filter((c) => !readOnly(c)).map((c) => [c.id, c.name] as [string, string])} onChange={st.setDefaultCalendar} />
        </Row>
        <Row title="Default length" note="When quick add or a double-click doesn’t say">
          <Pick label="Default length" value={s.defaultEventMin} options={[15, 30, 45, 60, 90, 120].map((m) => [m, mins(m)] as [number, string])} onChange={(v) => set({ defaultEventMin: v })} />
        </Row>
      </Group>
      <Group title="Travelling">
        <Row title="Second hour column in home time when away"><Toggle label="Home-time column" on={showHome} onChange={st.setShowHomeHours} /></Row>
      </Group>
      <Group title="Also on the calendar" foot="Same switches as in the sidebar.">
        <Row title="Dated tasks"><Toggle label="Dated tasks" on={showTasks} onChange={st.setShowTasks} /></Row>
        <Row title="Deadline runways"><Toggle label="Deadline runways" on={showDeadlines} onChange={st.setShowDeadlines} /></Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- Calendars
function CalendarsPane({ onNested }: { onNested: (open: boolean) => void }) {
  const [s, set] = useSettings();
  const calendars = useStore((x) => x.calendars);
  const events = useStore((x) => x.events);
  const defaultId = useStore((x) => x.defaultCalendarId);
  const [editing, setEditing] = useState<{ id: string; mode?: 'new' | 'subscribe' | 'import' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => onNested(!!editing), [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = (id: string) => events.filter((e) => e.calendarId === id).length;
  const refresh = async (id: string) => { setBusy(id); await useStore.getState().refreshCalendar(id); setBusy(null); };
  const own = calendars.filter((c) => !c.url && !c.mac), subs = calendars.filter((c) => c.url);
  const dot = (color: string) => <i className="st-dot" style={{ background: color }} />;
  return (
    <>
      <MacCalendarsGroup />
      <Group title="Your calendars">
        {own.map((c) => (
          <Row key={c.id} title={<>{dot(c.color)}{c.name}{c.id === defaultId ? ' ★' : ''}</>} note={`On this ${isApp() ? 'Mac' : 'browser'} · ${count(c.id)} events`}>
            <button className="ce-btn" onClick={() => setEditing({ id: c.id })}>Edit</button>
          </Row>
        ))}
      </Group>
      {subs.length > 0 && (
        <Group title="Subscriptions">
          {subs.map((c) => (
            <Row
              key={c.id}
              title={<>{dot(c.color)}{c.name}</>}
              note={c.syncError ? <span className="st-err">Couldn’t update: {c.syncError}</span> : c.lastSync ? `Updated ${formatDistanceToNow(c.lastSync, { addSuffix: true })}` : 'Not loaded yet'}
            >
              <button className="ce-btn" disabled={busy === c.id} onClick={() => void refresh(c.id)}>{busy === c.id ? 'Refreshing…' : 'Refresh'}</button>
              <button className="ce-btn" onClick={() => setEditing({ id: c.id })}>Edit</button>
            </Row>
          ))}
        </Group>
      )}
      <Group>
        <Row title="Check subscriptions every">
          <Pick label="Check subscriptions every" value={s.subsRefreshMin} options={[[15, '15 min'], [30, '30 min'], [60, 'Hour'], [180, '3 hours']]} onChange={(v) => set({ subsRefreshMin: v })} />
        </Row>
      </Group>
      <div className="st-btns">
        <button className="ce-btn" onClick={() => setEditing({ id: 'new', mode: 'new' })}>+ New calendar</button>
        <button className="ce-btn" onClick={() => setEditing({ id: 'new', mode: 'subscribe' })}>Subscribe to a link…</button>
        <button className="ce-btn" onClick={() => setEditing({ id: 'new', mode: 'import' })}>Import a file…</button>
      </div>
      {editing && <CalendarEditor id={editing.id} mode={editing.mode} onClose={() => setEditing(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- Tasks & Deadlines
function TasksPane() {
  const [s, set] = useSettings();
  const sug = (k: keyof AppSettings['suggest'], on: boolean) => set({ suggest: { ...s.suggest, [k]: on } });
  return (
    <>
      <Group title="Deadlines">
        <Row title="Due time when none is given" note="“abstract due friday”">
          <Pick label="Due time" value={s.dueMinutes} options={[9 * 60, 12 * 60, 15 * 60, 17 * 60, 18 * 60, 23 * 60 + 59].map((m) => [m, at(m)] as [number, string])} onChange={(v) => set({ dueMinutes: v })} />
        </Row>
        <Row title="Runway when none is given" note="How long before the deadline work starts (deadlines that set their own keep it)">
          <Pick label="Runway" value={s.leadDays} options={[[3, '3 days'], [7, '1 week'], [14, '2 weeks'], [21, '3 weeks'], [30, '1 month']]} onChange={(v) => set({ leadDays: v })} />
        </Row>
      </Group>
      <DeadlineColors />
      <Group title="Suggestions" foot="Each switch turns off one kind of suggestion in the quick-add box.">
        <Row title="Nudge overdue tasks" note="One suggestion after 3 days overdue"><Toggle label="Nudge overdue tasks" on={s.suggest.stale} onChange={(v) => sug('stale', v)} /></Row>
        <Row title="Offer focus blocks for deadlines" note="“Work on NSERC proposal tomorrow at 9am”"><Toggle label="Offer focus blocks" on={s.suggest.focus} onChange={(v) => sug('focus', v)} /></Row>
        <Row title="Suggest missing regular meetings" note="A weekly meeting that isn’t on this week"><Toggle label="Suggest missing regular meetings" on={s.suggest.add} onChange={(v) => sug('add', v)} /></Row>
      </Group>
    </>
  );
}

/** When a deadline changes colour, and to what — on the calendar's runways, in the sidebar and in the event panel. */
function DeadlineColors() {
  const [s, set] = useSettings();
  const look = s.deadlineLook;
  const put = (p: Partial<DeadlineLook>) => set({ deadlineLook: { ...look, ...p } });
  const color = (k: keyof DeadlineLook['colors'], name: string) => (
    <input type="color" className="st-color" aria-label={`${name} colour`} value={look.colors[k]} onChange={(e) => put({ colors: { ...look.colors, [k]: e.target.value } })} />
  );
  const pct = (v: number) => [v, `${v}% left`] as [number, string];
  const stages: [keyof DeadlineLook['colors'], string, ReactNode, ReactNode][] = [
    ['plenty', 'Plenty of time', 'Most of the runway still ahead', null],
    ['halfway', 'Halfway', 'Less of the runway left than', <Pick label="Yellow from" value={look.halfway} options={[40, 50, 60, 70, 80].map(pct)} onChange={(v) => put({ halfway: v, closing: Math.min(look.closing, v) })} />],
    ['closing', 'Getting close', 'Less of the runway left than', <Pick label="Orange from" value={look.closing} options={[10, 15, 20, 25, 33, 40].filter((v) => v <= look.halfway).map(pct)} onChange={(v) => put({ closing: v })} />],
    ['soon', 'Due very soon', 'In the last', <Pick label="Red from" value={look.soonHours} options={[[0, 'never'], [12, '12 hours'], [24, '24 hours'], [48, '48 hours'], [72, '3 days'], [168, '1 week']]} onChange={(v) => put({ soonHours: v })} />],
    ['overdue', 'Overdue', 'Past its due time', null],
  ];
  const changed = JSON.stringify(look) !== JSON.stringify(DEFAULT_DEADLINE_LOOK);
  return (
    <Group
      title="Deadline colours"
      foot={
        <>
          <span className="st-dl-bar" aria-hidden>{stages.map(([k]) => <i key={k} style={{ background: look.colors[k] }} />)}</span>
          A deadline's runway and its countdown change colour as the due time gets closer.{' '}
          {changed && <button className="st-link" onClick={() => set({ deadlineLook: DEFAULT_DEADLINE_LOOK })}>Back to the usual colours</button>}
        </>
      }
    >
      {stages.map(([k, title, note, pick]) => (
        <Row key={k} title={<span className="st-dl-title">{color(k, title)}{title}</span>} note={note}>{pick}</Row>
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------- Habits
// Calendars on this Mac (iCloud, Google, Exchange…): connect, then pick which to show — data/macCalendars.ts
function MacCalendarsGroup() {
  const calendars = useStore((x) => x.calendars);
  const [access, setAccess] = useState<MacAccess | null>(null);
  const [list, setList] = useState<MacCalendar[]>([]);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const a = await macAccess().catch(() => 'denied' as MacAccess);
    setAccess(a);
    if (a === 'full') setList(await macCalendarList().catch(() => []));
  };
  useEffect(() => {
    if (!isApp()) return;
    void macHost().then(setHost);
    void load();
  }, []);
  const fromMac = calendars.filter((c) => c.mac);
  if (!isApp())
    return fromMac.length ? (
      <Group title="Calendars on your Mac" foot="Kept in step with the Calendar app by your Mac: changes made here reach it (and iCloud, Google…) the next time your Mac is on.">
        {fromMac.map((c) => <Row key={c.id} title={<><i className="st-dot" style={{ background: c.color }} />{c.name}</>} note={c.account + (c.mac!.writable ? '' : ' · read-only')} />)}
      </Group>
    ) : null;
  const connect = async () => {
    setBusy(true);
    try {
      setAccess(await askMacAccess());
      await load();
    } finally {
      setBusy(false);
    }
  };
  const accounts = [...new Set(list.map((c) => c.account))];
  return (
    <Group title="Calendars on this Mac" foot="iCloud, Google, Exchange — whatever the Calendar app has. Changes go both ways, and your iPhone sees them through sync. Turning one off only takes it out of Worldline.">
      {access === 'notDetermined' && (
        <Row title="Show your Mac’s calendars here" note="macOS asks you once whether Worldline may use your calendars">
          <button className="ce-btn primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Waiting…' : 'Connect…'}</button>
        </Row>
      )}
      {(access === 'denied' || access === 'restricted' || access === 'writeOnly') && (
        <Row title="Worldline can’t read your calendars" note="System Settings → Privacy & Security → Calendars → set Worldline to Full Access, then come back here">
          <button className="ce-btn" onClick={() => void load()}>Check again</button>
        </Row>
      )}
      {access === 'full' && !list.length && <Row title="No calendars in the Calendar app" note="Add an account in System Settings → Internet Accounts, or a calendar in the Calendar app" />}
      {access === 'full' && accounts.map((a) => (
        <div key={a}>
          <div className="st-sub">{a}</div>
          {list.filter((c) => c.account === a).map((c) => {
            const shown = calendars.find((x) => x.mac?.id === c.id);
            const elsewhere = shown && shown.mac!.host !== host;
            return (
              <Row key={c.id} title={<><i className="st-dot" style={{ background: c.color }} />{c.title}</>} note={elsewhere ? 'Kept in step by another Mac' : c.writable ? undefined : 'Read-only'}>
                <Toggle label={`Show ${c.title} in Worldline`} on={!!shown} onChange={(v) => void showMacCalendar(c, v)} />
              </Row>
            );
          })}
        </div>
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------- Alerts
function AlertsPane() {
  const [s, set] = useSettings();
  const [access, setAccess] = useState<'granted' | 'denied' | 'default' | 'unsupported' | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  useEffect(() => void notificationAccess().then(setAccess), []);
  // (null is "None": selects work in strings)
  const pick = (value: number | null, choices: [number, string][], onChange: (v: number | null) => void, label: string) => (
    <Pick label={label} value={value === null ? 'none' : String(value)} options={[['none', 'None'], ...choices.map(([m, l]) => [String(m), l] as [string, string])]} onChange={(v) => onChange(v === 'none' ? null : Number(v))} />
  );
  const status = {
    granted: isApp() ? 'Allowed — reminders appear as Mac notifications, even while the window is closed.' : 'Allowed — shown while Worldline is open.',
    denied: isApp() ? 'Turned off for Worldline in System Settings → Notifications. Reminders still show inside the app.' : 'Blocked for this site — reminders still show inside the app while it’s open.',
    default: 'Not allowed yet.',
    unsupported: 'This browser can’t show notifications — reminders show inside the app while it’s open.',
  };
  return (
    <>
      <Group title="Remind me" foot="Each event can have its own (its card → Alert). Subscribed calendars remind only if you turn alerts on in the calendar’s ⋯ card.">
        <Row title="Events" note="Before each event in your calendars">{pick(s.alertMin, TIMED_CHOICES, (v) => set({ alertMin: v }), 'Alert for events')}</Row>
        <Row title="All-day events">{pick(s.alertAllDayMin, ALL_DAY_CHOICES, (v) => set({ alertAllDayMin: v }), 'Alert for all-day events')}</Row>
        <Row title="Deadlines" note="Before the moment it’s due">{pick(s.alertDeadlineMin, TIMED_CHOICES, (v) => set({ alertDeadlineMin: v }), 'Alert for deadlines')}</Row>
      </Group>
      <Group title="Notifications" foot={isApp() ? undefined : 'On the iPhone, reminders come only while Worldline is open — a web app can’t wake itself up. Your Mac sends them on time.'}>
        <Row title={access === 'granted' ? 'Notifications are on' : 'Notifications'} note={access ? status[access] : ' '}>
          {access === 'default' && <button className="ce-btn primary" onClick={() => void notificationAccess(true).then(setAccess)}>Allow</button>}
        </Row>
        <Row title="Send a test alert" note={tested ?? 'See how a reminder looks'}>
          <button className="ce-btn" onClick={() => void testAlert().then(() => setTested('Sent — it should appear now'), (e) => setTested(`Couldn’t send it: ${String((e as Error)?.message ?? e)}`))}>Send</button>
        </Row>
      </Group>
    </>
  );
}

function HabitsPane() {
  const [s, set] = useSettings();
  const hasHabits = useStore((x) => x.habits.length > 0);
  return (
    <>
      <Group title="Counting">
        <Row title="Let calendar events count" note="A habit’s calendar word (“gym”) ticks it once those events have happened">
          <Toggle label="Let calendar events count" on={s.habitsFromCalendar} onChange={(v) => set({ habitsFromCalendar: v })} />
        </Row>
        <Row title="Weekly nudge" note="From Wednesday: “Gym tomorrow at 7:30am · 1 of 3 this week”">
          <Toggle label="Weekly nudge" on={s.suggest.habit} onChange={(v) => set({ suggest: { ...s.suggest, habit: v } })} />
        </Row>
      </Group>
      <Group title="Export">
        <Row title="Every habit, every recorded day, as a spreadsheet"><button className="ce-btn" disabled={!hasHabits} onClick={() => void downloadHabitsCsv()}>Export CSV</button></Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- Scheduling
function SchedulingPane() {
  const [s, set] = useSettings();
  const d = s.linkDefaults;
  const up = (patch: Partial<AppSettings['linkDefaults']>) => set({ linkDefaults: { ...d, ...patch } });
  const [health, setHealth] = useState(relayHealth());
  useEffect(() => {
    const id = setInterval(() => setHealth(relayHealth()), 2000);
    return () => clearInterval(id);
  }, []);
  const working = health.relays.filter((r) => r.ok).length;
  return (
    <>
      <Group title="New links start with" foot="Each link can still be changed on its own.">
        <Row title="Length"><Pick label="Length" value={d.durationMin} options={[15, 20, 30, 45, 60, 90, 120].map((m) => [m, mins(m)] as [number, string])} onChange={(v) => up({ durationMin: v })} /></Row>
        <Row title="Hours offered">
          <span className="pinputs">
            <input type="time" step={1800} aria-label="From" value={hhmm(d.windowStart)} onChange={(e) => e.target.value && fromHhmm(e.target.value) < d.windowEnd && up({ windowStart: fromHhmm(e.target.value) })} />
            <input type="time" step={1800} aria-label="To" value={hhmm(d.windowEnd)} onChange={(e) => e.target.value && fromHhmm(e.target.value) > d.windowStart && up({ windowEnd: fromHhmm(e.target.value) })} />
          </span>
        </Row>
        <Row title="Close after one booking" note="Off for office-hours style links"><Toggle label="Close after one booking" on={d.singleUse} onChange={(v) => up({ singleUse: v })} /></Row>
        <Row title="Keep free around events"><Pick label="Keep free around events" value={d.bufferMin} options={[0, 5, 10, 15, 30].map((m) => [m, m ? `${m} min` : 'none'] as [number, string])} onChange={(v) => up({ bufferMin: v })} /></Row>
        <Row title="Earliest booking">
          <Pick label="Earliest booking" value={d.noticeMin} options={[[0, 'any time'], [60, '1 h ahead'], [240, '4 h ahead'], [720, '12 h ahead'], [1440, '1 day ahead'], [2880, '2 days ahead']]} onChange={(v) => up({ noticeMin: v })} />
        </Row>
      </Group>
      <Group title="Relays" foot="Kept up to date automatically (checked weekly). Messages go to all of them; any one is enough.">
        <div className="st-row">
          <div className="st-lab st-relays">
            {health.relays.length ? health.relays.map((r) => (
              <span key={r.url}><i className={cls('st-dot', r.ok ? 'ok' : 'off')} />{r.url.replace('wss://', '')}{!r.ok && <em> · not connected</em>}</span>
            )) : <span>Connecting…</span>}
          </div>
          <div className="st-ctl st-relay-sum">
            <span>{working} of {health.relays.length} connected</span>
            {health.updated && <span>List updated {health.updated}</span>}
          </div>
        </div>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------- Data & Backups
function DataPane() {
  const calendars = useStore((x) => x.calendars);
  const hasHabits = useStore((x) => x.habits.length > 0);
  // (replacing the data with sync on: the other devices keep theirs, and this one takes it back from them — syncEngine.ts)
  const synced = useStore((x) => x.sync.on) ? ' Sync is on: your other devices keep their data, and this device then takes it back from them. To keep the result on this device only, turn sync off first.' : '';
  const st = useStore.getState();
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState('');
  const [cal, setCal] = useState(calendars[0]?.id ?? '');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => void listSnapshots().then((d) => { setDays(d); setDay(d[0] ?? ''); }), []);
  const [undoable, setUndoable] = useState(false);
  useEffect(() => void beforeRestore(STORE_KEY).then((v) => setUndoable(!!v)), []);
  const undoRestore = async () => {
    const v = await beforeRestore(STORE_KEY);
    if (!v || !(await ask({ title: 'Undo the last restore?', body: 'Everything goes back to how it was just before you restored.', confirm: 'Undo restore' }))) return;
    await replaceSaved(STORE_KEY, v);
    window.location.reload();
  };
  const opts = useStore.persist.getOptions();
  const storeVersion = opts.version ?? 0;
  const replaceAndReload = async (state: unknown) => {
    await replaceSaved(STORE_KEY, JSON.stringify({ state, version: storeVersion }));
    window.location.reload();
  };
  const backup = async () => {
    const b = makeBackup(opts.partialize!(useStore.getState()) as Record<string, unknown>, storeVersion, APP_VERSION);
    if (await saveFile(`Worldline backup ${b.savedAt.slice(0, 10)}.json`, JSON.stringify(b), 'application/json')) setMsg({ text: 'Backup saved.' });
  };
  const restoreFile = async (f: File) => {
    const r = readBackup(await f.text(), storeVersion);
    if (!r.ok) return setMsg({ text: r.reason, bad: true });
    if (!(await ask({ title: 'Restore this backup?', body: `Everything is replaced with the backup from ${fmtWhen(new Date(r.backup.savedAt).getTime())}. Save a backup of what you have now first if you might want it.${synced}`, confirm: 'Restore', danger: true }))) return;
    await replaceAndReload(r.backup.state);
  };
  const restoreSnapshot = async () => {
    if (!day || !(await ask({ title: `Go back to ${day}?`, body: `Everything is replaced with how it was on that day. Save a backup first if you might want what you have now.${synced}`, confirm: 'Restore snapshot', danger: true }))) return;
    const value = await snapshotValue(day);
    if (!value) return setMsg({ text: 'That snapshot couldn’t be read.', bad: true });
    await replaceSaved(STORE_KEY, value);
    window.location.reload();
  };
  const uninstall = async () => {
    if (!(await confirmUninstall())) return; // asked by the Mac itself (lib.rs): nothing happens before a yes there
    setMsg({ text: 'Uninstalling…' });
    await autostart.set(false).catch(() => undefined); // remove the login item properly
    // close open scheduling links so guests see "closed" (data/schedSync.ts publishes the notice), then go
    for (const l of st.links) st.deleteLink(l.id);
    await new Promise((r) => setTimeout(r, 2500));
    await uninstallApp();
  };
  const exportIcs = async () => {
    const c = calendars.find((x) => x.id === cal);
    if (!c) return;
    const text = toIcs(c.name, st.events.filter((e) => e.calendarId === c.id), c.color);
    if (await saveFile(`${c.name}.ics`, text, 'text/calendar')) setMsg({ text: `Exported “${c.name}”.` });
  };
  return (
    <>
      <Group title="Where it’s kept">
        <Row title={isApp() ? 'On this Mac, in one database file' : 'On this device, in the browser’s storage'} note={isApp() ? '~/Library/Application Support/io.github.bradenseefeldt.worldline/worldline.db' : 'Kept here, offline too — save a backup now and then'}>
          {isApp() && <button className="ce-btn" onClick={() => void showDataFolder()}>Show in Finder</button>}
        </Row>
      </Group>
      <Group title="Backups">
        {isApp() && (
          <Row title="Daily snapshots" note="One a day for the last 14 days, kept inside the database">
            {days.length ? (
              <>
                <Pick label="Snapshot" value={day} options={days.map((d) => [d, d] as [string, string])} onChange={setDay} />
                <button className="ce-btn" onClick={() => void restoreSnapshot()}>Restore…</button>
              </>
            ) : <span className="st-muted">None yet</span>}
          </Row>
        )}
        {undoable && (
          <Row title="Undo the last restore" note="Go back to how things were just before your last restore">
            <button className="ce-btn" onClick={() => void undoRestore()}>Undo restore…</button>
          </Row>
        )}
        <Row title="Back up everything to a file" note="One .json file you can keep anywhere (a USB stick, iCloud Drive), and restore from">
          <button className="ce-btn" onClick={() => void backup()}>Save backup…</button>
          <button className="ce-btn" onClick={() => fileRef.current?.click()}>Restore from file…</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void restoreFile(f); }} />
        </Row>
      </Group>
      <Group title="Export">
        <Row title="A calendar as an .ics file" note="For Apple Calendar, Google, Outlook">
          <Pick label="Calendar" value={cal} options={calendars.map((c) => [c.id, c.name] as [string, string])} onChange={setCal} />
          <button className="ce-btn" onClick={() => void exportIcs()}>Export</button>
        </Row>
        <Row title="Habits as a spreadsheet"><button className="ce-btn" disabled={!hasHabits} onClick={() => void downloadHabitsCsv()}>Export CSV</button></Row>
      </Group>
      {msg && <p className={cls('st-msg', msg.bad && 'bad')}>{msg.text}</p>}
      <Group title="Start over">
        {!isApp() && (
          <Row title="Load the demo data" note="Replace everything with sample data, to try things out">
            <button className="ce-btn subtle-danger" onClick={async () => (await ask({ title: 'Replace everything with the demo data?', body: 'Your own events, habits and projects will be gone.', confirm: 'Load demo data', danger: true })) && st.resetDemo()}>Load demo data</button>
          </Row>
        )}
        {isApp() && (
          <Row title="Uninstall Worldline" note="Quits, and moves the app and all of its data to the Trash — nothing is left behind">
            <button className="ce-btn subtle-danger" onClick={() => void uninstall()}>Uninstall…</button>
          </Row>
        )}
        <Row title="Erase everything" note="Events, tasks, habits, projects and notes">
          <button className="ce-btn subtle-danger" onClick={async () => (await ask({ title: 'Erase everything?', body: `All events, tasks, habits, projects and notes. This can’t be undone (save a backup first if in doubt).${synced}`, confirm: 'Erase everything', danger: true })) && st.startFresh()}>Erase everything…</button>
        </Row>
      </Group>
    </>
  );
}

/** Open the app's data folder in Finder (where worldline.db lives). */
async function showDataFolder() {
  const [{ appConfigDir }, { invoke }] = await Promise.all([import('@tauri-apps/api/path'), import('@tauri-apps/api/core')]);
  await invoke('show_in_finder', { path: await appConfigDir() });
}

// ---------------------------------------------------------------- About
function About() {
  const [s, set] = useSettings();
  const update = useStore((x) => x.update);
  const [check, setCheck] = useState<{ state: 'idle' | 'checking' | 'current' | 'newer' | 'failed'; latest?: string }>({ state: 'idle' });
  const releases = `https://github.com/${REPO}/releases/latest`;
  // In development there's nothing to install: just say whether a newer release exists.
  const run = async () => {
    setCheck({ state: 'checking' });
    try {
      const latest = (JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/releases/latest`)) as { tag_name?: string }).tag_name ?? '';
      setCheck(latest && isNewer(latest, APP_VERSION) ? { state: 'newer', latest } : { state: 'current', latest });
    } catch {
      setCheck({ state: 'failed' });
    }
  };
  const appNote = {
    idle: 'Calendar, habits and research projects · free, no account, no server',
    checking: 'Checking…',
    current: '✓ This is the newest version.',
    downloading: `Downloading ${'version' in update ? update.version : ''}…`,
    ready: isApp() ? `Version ${'version' in update ? update.version : ''} is downloaded — restart to use it.` : `Version ${'version' in update ? update.version : ''} is available — everything is saved first.`,
    failed: `Couldn’t check: ${'error' in update ? update.error : ''}`,
  }[update.state];
  const browserNote = check.state === 'current' ? '✓ This is the newest version.' : check.state === 'newer' ? `Version ${check.latest?.replace(/^v/, '')} is available.` : check.state === 'failed' ? 'Couldn’t check (no network?).' : 'Calendar, habits and research projects · free, no account, no server';
  const keys: [string, string[]][] = [
    ['Quick add', ['⌘', 'K']], ['Day / 3 Day / Week / Month', ['D', '3', 'W', 'M']], ['Today · back · forward', ['T', '←', '→']],
    ['Habits · Projects', ['H', 'P']], ['Search projects', ['/']], ['Settings', ['⌘', ',']], ['Undo · redo', ['⌘Z', '⇧⌘Z']],
    ['Move a sidebar card', ['⌥↑', '⌥↓']],
  ];
  return (
    <>
      <Group>
        {canUpdate() ? (
          <>
            <Row title={<span className="st-big">Worldline {APP_VERSION}</span>} note={appNote}>
              {update.state === 'ready' ? (
                <button className="ce-btn primary" onClick={() => void restartToUpdate()}>{isApp() ? 'Restart to update' : 'Update now'}</button>
              ) : (
                <button className="ce-btn primary" disabled={update.state === 'checking' || update.state === 'downloading'} onClick={() => void checkForUpdate(useStore.getState().setUpdate)}>
                  {update.state === 'checking' ? 'Checking…' : update.state === 'downloading' ? 'Downloading…' : 'Check for updates'}
                </button>
              )}
            </Row>
            <Row title="Check for updates automatically" note={isApp() ? 'Once a day; a new version downloads in the background and waits for you to restart' : 'When you open it, and once a day; a new version waits for you to tap Update'}>
              <Toggle label="Check for updates automatically" on={s.autoUpdate} onChange={(v) => set({ autoUpdate: v })} />
            </Row>
          </>
        ) : (
          <Row title={<span className="st-big">Worldline {APP_VERSION}</span>} note={browserNote}>
            {check.state === 'newer' ? (
              <button className="ce-btn primary" onClick={() => void openExternal(releases)}>Download</button>
            ) : (
              <button className="ce-btn primary" disabled={check.state === 'checking'} onClick={() => void run()}>{check.state === 'checking' ? 'Checking…' : 'Check for updates'}</button>
            )}
          </Row>
        )}
        <Row title="Source code" note={`github.com/${REPO} · MIT licence`}><button className="ce-btn" onClick={() => void openExternal(`https://github.com/${REPO}`)}>Open</button></Row>
      </Group>
      <Group title="Keyboard shortcuts">
        {keys.map(([what, ks]) => <Row key={what} title={what}>{ks.map((k) => <kbd key={k} className="st-kbd">{k}</kbd>)}</Row>)}
      </Group>
    </>
  );
}
