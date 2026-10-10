// Settings: theme, your name (filled into scheduling links), home time zone, default calendar, habit export, demo data.
import { useEffect } from 'react';
import { useStore } from '../data/store';
import { TimeZonePicker } from './TimeZonePicker';
import { Close } from './Icons';
import { downloadHabitsCsv } from './Habits';
import { THEMES } from '../lib/theme';
import { cls } from '../lib/format';
import { isApp } from '../lib/platform';
import type { CSSProperties } from 'react';

export function Settings({ onClose }: { onClose: () => void }) {
  const myName = useStore((s) => s.myName);
  const homeZone = useStore((s) => s.homeZone);
  const calendars = useStore((s) => s.calendars);
  const defaultId = useStore((s) => s.defaultCalendarId);
  const hasHabits = useStore((s) => s.habits.length > 0);
  const theme = useStore((s) => s.theme);
  const st = useStore.getState();
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="ce-scrim" onMouseDown={onClose}>
      <div className="ce sl-modal settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ce-head">
          <span className="ce-title">Settings</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Close /></button>
        </div>

        <section className="set-sec">
          <h3>Appearance</h3>
          {/* System (follows the computer) leads the light themes, then the dark ones */}
          {([['Light', THEMES.filter((t) => t.dark !== true)], ['Dark', THEMES.filter((t) => t.dark === true)]] as const).map(([label, list]) => (
            <div key={label} className="theme-group">
              <span className="theme-label">{label}</span>
              <div className="themes" role="radiogroup" aria-label={`${label} themes`}>
                {list.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={theme === t.id}
                    className={cls('theme', theme === t.id && 'on')}
                    onClick={() => st.setTheme(t.id)}
                    title={t.note}
                    style={{ '--pb': t.preview.bg, '--pp': t.preview.panel, '--pl': t.preview.line, '--pt': t.preview.text, '--pa': t.preview.accent } as CSSProperties}
                  >
                    {/* a tiny window: sidebar, a card with two lines of text and an accent pill */}
                    <span className={cls('theme-pv', t.id === 'system' && 'split')}>
                      <i className="pv-side" />
                      <span className="pv-card">
                        <i className="pv-line" />
                        <i className="pv-line short" />
                        <i className="pv-pill" />
                      </span>
                    </span>
                    <b>{t.name}</b>
                    <small>{t.note}</small>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="set-sec">
          <h3>Profile</h3>
          <label className="set-row">
            <span>Your name</span>
            <input className="set-in" value={myName} placeholder="e.g. Sam" onChange={(e) => st.setMyName(e.target.value)} autoFocus={!myName} />
          </label>
          <p className="set-note">Shown on your scheduling links (“Book time with …”).</p>
        </section>

        <section className="set-sec">
          <h3>Home time zone</h3>
          <TimeZonePicker value={homeZone} onChange={st.setHomeZone} />
        </section>

        <section className="set-sec">
          <h3>New events</h3>
          <label className="set-row">
            <span>Default calendar</span>
            <select className="pselect" value={defaultId} onChange={(e) => st.setDefaultCalendar(e.target.value)}>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </section>

        <section className="set-sec">
          <h3>Data</h3>
          <div className="set-row">
            <span>Your habits, every recorded day, as a spreadsheet</span>
            <button className="ce-btn" onClick={downloadHabitsCsv} disabled={!hasHabits}>Export CSV</button>
          </div>
          <div className="set-row">
            <span>
              {isApp() ? 'Everything is saved on this Mac, in one database file (with a snapshot of each of the last 14 days).' : 'Saved in this browser.'}
            </span>
            {isApp() && <button className="ce-btn" onClick={() => void showDataFolder()}>Show in Finder</button>}
          </div>
          {!isApp() && <div className="set-row">
            <span>Development: replace everything with the sample data</span>
            <button className="ce-btn subtle-danger" onClick={() => confirm('Replace everything with the demo data? (Your own events, habits and projects will be gone.)') && st.resetDemo()}>
              Load demo data
            </button>
          </div>}
          <div className="set-row">
            <span>Erase everything and start with an empty calendar</span>
            <button className="ce-btn subtle-danger" onClick={() => confirm('Erase all events, tasks, habits, projects and notes? This can’t be undone.') && st.startFresh()}>
              Erase everything
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Open the app's data folder in Finder (where worldline.db lives). */
async function showDataFolder() {
  const [{ appConfigDir }, { openPath }] = await Promise.all([import('@tauri-apps/api/path'), import('@tauri-apps/plugin-opener')]);
  await openPath(await appConfigDir());
}
