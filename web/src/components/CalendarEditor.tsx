// Create, rename, recolour or delete a calendar. Edits to an existing calendar apply as you go;
// deleting asks whether its events move to another calendar or go with it.
// A new calendar can also be a subscription (a link to a department's / team's / Google calendar, kept up to date,
// read-only) or an imported .ics file (copied in as your own, editable).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { CALENDAR_COLORS, useStore } from '../data/store';
import { cls } from '../lib/format';
import { Close, Trash } from './Icons';

export function CalendarEditor({ id, onClose }: { id: string | 'new'; onClose: () => void }) {
  const calendars = useStore((s) => s.calendars);
  const events = useStore((s) => s.events);
  const defaultId = useStore((s) => s.defaultCalendarId);
  const { addCalendar, updateCalendar, deleteCalendar, setDefaultCalendar, subscribeCalendar, refreshCalendar, importIcs, showToast } = useStore.getState();
  const [mode, setMode] = useState<'new' | 'subscribe' | 'import'>('new');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false); // an .ics file is being dragged over the drop area
  const fileRef = useRef<HTMLInputElement>(null);
  const existing = id === 'new' ? undefined : calendars.find((c) => c.id === id);
  const unused = CALENDAR_COLORS.find((c) => !calendars.some((x) => x.color === c)) ?? CALENDAR_COLORS[0];

  const [name, setName] = useState(existing?.name ?? '');
  const [color, setColor] = useState(existing?.color ?? unused);
  const [makeDefault, setMakeDefault] = useState(existing ? existing.id === defaultId : false);
  const [confirming, setConfirming] = useState(false);
  const others = calendars.filter((c) => c.id !== id);
  const [moveTo, setMoveTo] = useState<string>(others[0]?.id ?? '');
  const [fate, setFate] = useState<'move' | 'delete'>('move');
  const count = existing ? events.filter((e) => e.calendarId === existing.id).length : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Existing calendars update live; a new one is created on "Create".
  const rename = (v: string) => {
    setName(v);
    if (existing && v.trim()) updateCalendar(existing.id, { name: v });
  };
  const recolor = (c: string) => {
    setColor(c);
    if (existing) updateCalendar(existing.id, { color: c });
  };
  const toggleDefault = (on: boolean) => {
    setMakeDefault(on);
    if (existing && on) setDefaultCalendar(existing.id);
  };
  const subscribe = () => {
    if (!/^(https?|webcals?):\/\//i.test(url.trim())) return;
    subscribeCalendar(url, name, color);
    showToast('Subscribed — its events will appear in a moment', false);
    onClose();
  };
  const importFile = async (f: File) => {
    const text = await f.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) return showToast("That file isn't a calendar (.ics)", false);
    const r = importIcs(text, name.trim() || f.name.replace(/\.ics$/i, ''), color);
    showToast(`Imported ${r.count} event${r.count === 1 ? '' : 's'}`);
    onClose();
  };
  const refresh = async () => {
    if (!existing) return;
    setBusy(true);
    await refreshCalendar(existing.id);
    setBusy(false);
  };
  const create = () => {
    const newId = addCalendar(name, color);
    if (makeDefault) setDefaultCalendar(newId);
    onClose();
  };
  const remove = () => {
    if (!existing) return;
    deleteCalendar(existing.id, count && fate === 'move' ? moveTo : count ? null : others[0].id);
    onClose();
  };

  return (
    <div className="ce-scrim" onMouseDown={onClose}>
      <div className="ce" onMouseDown={(e) => e.stopPropagation()} style={{ '--c': color } as CSSProperties}>
        <div className="ce-head">
          <span className="ce-dot" />
          <span className="ce-title">{existing ? (existing.url ? 'Subscribed calendar' : 'Edit calendar') : 'Add a calendar'}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Close />
          </button>
        </div>

        {!existing && (
          <div className="seg ce-modes" role="tablist" aria-label="Kind of calendar">
            <button role="tab" aria-selected={mode === 'new'} className={cls(mode === 'new' && 'on')} onClick={() => setMode('new')}>New</button>
            <button role="tab" aria-selected={mode === 'subscribe'} className={cls(mode === 'subscribe' && 'on')} onClick={() => setMode('subscribe')}>Subscribe to a link</button>
            <button role="tab" aria-selected={mode === 'import'} className={cls(mode === 'import' && 'on')} onClick={() => setMode('import')}>Import a file</button>
          </div>
        )}
        {!existing && mode === 'subscribe' && (
          <>
            <input
              autoFocus className="ce-name ce-url" placeholder="Calendar link: webcal://… or https://….ics" value={url} onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && subscribe()}
            />
            <p className="ce-help">
              Any calendar's “subscribe”, “iCal” or “.ics” link: a department or seminar calendar, a team's schedule, a Google calendar's
              <i> Secret address in iCal format</i>, an Outlook “publish” link. It stays up to date (every 30 min) and is read-only here.
            </p>
          </>
        )}
        {!existing && mode === 'import' && (
          <>
            <div
              className={cls('ce-drop', dragOver && 'over')}
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
              onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void importFile(f);
              }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3m0 0-4 4m4-4 4 4" /><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" /></svg>
              <b>{dragOver ? 'Drop to import' : 'Drop an .ics file here'}</b>
              <span>or click to choose one</span>
            </div>
            <p className="ce-help">
              A calendar file (<b>.ics</b>), e.g. exported from another app. Its events are copied in as a new calendar of your own, which you can edit.
            </p>
          </>
        )}
        {existing?.url && (
          <div className="ce-sub">
            <div className="ce-sub-url" title={existing.url}>{existing.url}</div>
            <div className={cls('ce-sub-status', existing.syncError && 'err')}>
              {existing.syncError ? `Couldn't update: ${existing.syncError}` : existing.lastSync ? `Updated ${formatDistanceToNow(existing.lastSync, { addSuffix: true })}` : 'Not loaded yet'}
              <button className="ce-btn" onClick={() => void refresh()} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh now'}</button>
            </div>
          </div>
        )}

        <input
          autoFocus={mode === 'new'}
          className="ce-name"
          placeholder={mode === 'new' || existing ? 'Calendar name' : 'Name (optional)'}
          value={name}
          onChange={(e) => rename(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (existing ? onClose() : mode === 'subscribe' ? subscribe() : mode === 'new' ? create() : undefined)}
        />

        <div className="ce-colors" role="radiogroup" aria-label="Colour">
          {CALENDAR_COLORS.map((c) => (
            <button
              key={c}
              className={cls('ce-swatch', c.toLowerCase() === color.toLowerCase() && 'on')}
              style={{ '--s': c } as CSSProperties}
              onClick={() => recolor(c)}
              aria-label={`Colour ${c}`}
            />
          ))}
          <label className="ce-custom" title="Custom colour">
            <input type="color" value={color} onChange={(e) => recolor(e.target.value)} />
            <span>Custom</span>
          </label>
        </div>

        {!existing?.url && mode !== 'subscribe' && <label className="ce-row">
          <span>Default calendar for new events</span>
          <input
            type="checkbox"
            className="switch"
            checked={makeDefault}
            disabled={!!existing && existing.id === defaultId}
            onChange={(e) => toggleDefault(e.target.checked)}
          />
        </label>}
        {existing && <div className="ce-meta">{count} event{count === 1 ? '' : 's'} · {existing.url ? 'subscribed (read-only)' : existing.account}</div>}

        {existing ? (
          confirming ? (
            <div className="ce-confirm">
              <div className="ce-confirm-title">Delete “{existing.name}”?</div>
              {count > 0 && (
                <>
                  <label className="ce-radio">
                    <input type="radio" checked={fate === 'move'} onChange={() => setFate('move')} />
                    Move its {count} event{count === 1 ? '' : 's'} to
                    <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} onFocus={() => setFate('move')}>
                      {others.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="ce-radio">
                    <input type="radio" checked={fate === 'delete'} onChange={() => setFate('delete')} />
                    Delete its {count} event{count === 1 ? '' : 's'} too
                  </label>
                </>
              )}
              <div className="ce-actions">
                <button className="ce-btn" onClick={() => setConfirming(false)}>Keep it</button>
                <button className="ce-btn danger" onClick={remove}>
                  <Trash /> Delete calendar
                </button>
              </div>
              <div className="ce-meta">You can undo this with ⌘Z.</div>
            </div>
          ) : (
            <div className="ce-actions">
              {existing.url ? (
                <button className="ce-btn subtle-danger" onClick={() => { deleteCalendar(existing.id, null); onClose(); }} disabled={!others.length}>
                  <Trash /> Unsubscribe
                </button>
              ) : (
                <button className="ce-btn subtle-danger" onClick={() => setConfirming(true)} disabled={!others.length} title={others.length ? '' : 'You need at least one calendar'}>
                  <Trash /> Delete…
                </button>
              )}
              <button className="ce-btn primary" onClick={onClose}>Done</button>
            </div>
          )
        ) : (
          <div className="ce-actions">
            <button className="ce-btn" onClick={onClose}>Cancel</button>
            {mode === 'new' && <button className="ce-btn primary" onClick={create} disabled={!name.trim()}>Create</button>}
            {mode === 'subscribe' && <button className="ce-btn primary" onClick={subscribe} disabled={!/^(https?|webcals?):\/\/\S+/i.test(url.trim())}>Subscribe</button>}
            {mode === 'import' && (
              <>
                <input ref={fileRef} type="file" accept=".ics,text/calendar" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
                <button className="ce-btn primary" onClick={() => fileRef.current?.click()}>Choose a file…</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
