// Shown instead of the app when the saved data couldn't be loaded (data/persist.ts): nothing has been changed or
// written over. Bring back a daily snapshot or a backup file, or start over (the unreadable copy stays kept aside).
import { useEffect, useRef, useState } from 'react';
import { beforeRestore, listSnapshots, replaceSaved, snapshotValue, startOverKeepingUnreadable } from '../data/persist';
import { readBackup } from '../lib/backup';
import { isApp } from '../lib/platform';
import { STORE_VERSION } from '../data/storeVersion';

const KEY = 'calendar-v1';

/** `crash`: the app opened but drawing failed (components/CrashScreen.tsx) — the same ways back, plus Reload. */
export function Recovery({ reason, crash }: { reason: string; crash?: Error }) {
  const [undo, setUndo] = useState<string | null>(null);
  useEffect(() => void beforeRestore(KEY).then(setUndo), []);
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => void listSnapshots().then((d) => { setDays(d); setDay(d[0] ?? ''); }, () => setDays([])), []);
  const done = () => window.location.reload();
  const fromSnapshot = async () => {
    const v = day && (await snapshotValue(day).catch(() => null));
    if (!v) return setMsg('That snapshot couldn’t be read either — try an earlier day or a backup file.');
    try {
      await replaceSaved(KEY, v);
      done();
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  const fromFile = async (f: File) => {
    const r = readBackup(await f.text(), STORE_VERSION);
    if (!r.ok) return setMsg(r.reason);
    await replaceSaved(KEY, JSON.stringify({ state: r.backup.state, version: r.backup.storeVersion }));
    done();
  };
  return (
    <div className="rc">
      <div className="rc-card">
        <h1>{crash ? 'Something went wrong' : 'Worldline couldn’t open your data'}</h1>
        <p>{reason} {crash ? 'Everything you’d done is saved — try Reload first; if this keeps happening, go back to a snapshot or a backup.' : 'Nothing has been changed or written over.'}</p>
        {crash && <pre className="rc-err">{String(crash.message || crash)}</pre>}
        {crash && (
          <div className="rc-actions">
            <button className="ce-btn primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="ce-btn" onClick={() => void navigator.clipboard?.writeText(`${crash.message}\n${crash.stack ?? ''}`)}>Copy details</button>
          </div>
        )}
        {undo && (
          <div className="rc-row">
            <span>Undo the last restore (go back to just before it):</span>
            <button className="ce-btn" onClick={() => void replaceSaved(KEY, undo).then(done)}>Undo restore</button>
          </div>
        )}
        {isApp() && days.length > 0 && (
          <div className="rc-row">
            <span>Go back to a daily snapshot:</span>
            <select className="pselect" value={day} onChange={(e) => setDay(e.target.value)}>{days.map((d) => <option key={d}>{d}</option>)}</select>
            <button className="ce-btn primary" onClick={() => void fromSnapshot()}>Restore</button>
          </div>
        )}
        <div className="rc-row">
          <span>{isApp() && days.length > 0 ? 'Or restore from a backup file:' : 'Restore from a backup file:'}</span>
          <button className="ce-btn" onClick={() => fileRef.current?.click()}>Choose backup…</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void fromFile(f); }} />
        </div>
        {msg && <p className="rc-msg">{msg}</p>}
        <div className="rc-row rc-last">
          <span>Or start over with an empty calendar ({crash ? 'what you have now' : 'the unreadable data'} is kept aside, not deleted).</span>
          <button className="ce-btn subtle-danger" onClick={() => void startOverKeepingUnreadable(KEY).then(done)}>Start over</button>
        </div>
      </div>
    </div>
  );
}

/** Take the data over from the other tab (it saves, says so, and reloads as the second one — main.tsx), then start
 *  here: only once it has said it saved (or after 8 s, if it's gone), so this tab never loads older data. */
const takeOver = () => {
  const ch = new BroadcastChannel('worldline-app');
  const saved = new Promise<void>((r) => {
    ch.onmessage = (e) => e.data === 'saved' && r();
    setTimeout(r, 8000);
  });
  void navigator.locks?.request('worldline-app', { steal: true }, () => saved).finally(() => location.reload());
};

/** The web version, opened in a second tab or window: the first one owns the data (main.tsx). */
export function OpenElsewhere() {
  return (
    <div className="rc">
      <div className="rc-card">
        <h1>Worldline is open in another tab</h1>
        <p>To keep your data from being saved over, Worldline runs in one tab or window at a time. Switch to that one, or use it here instead (the other one saves and steps aside).</p>
        <div className="rc-row rc-last">
          <span />
          <button className="ce-btn" onClick={() => location.reload()}>Reload</button>
          <button className="ce-btn primary" onClick={takeOver}>Use it here instead</button>
        </div>
      </div>
    </div>
  );
}
