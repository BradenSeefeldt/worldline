// Details / edit card for the selected event. Edits save as you type — no Save button.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { addDays, format, startOfDay } from 'date-fns';
import { isLocked, newEventCalendarId, useStore } from '../data/store';
import type { CalEvent, Recurrence } from '../data/types';
import { MIN } from '../lib/dates';
import { ALL_DAY_CHOICES, TIMED_CHOICES, alertFor, describeAlert } from '../lib/alerts';
import { decodeEvent, describeRecurrence, isOccurrenceId, resolveEvent } from '../lib/recurrence';
import type { Scope } from '../lib/mutate';
import { cls, fmtTimeRange } from '../lib/format';
import { wallClock, zoneAbbr, zoneCity } from '../lib/zone';
import { defaultLeadDays, URGENCY_COLOR, countdown, urgency } from '../lib/deadlines';

const LEAD_CHOICES: [number, string][] = [
  [3, '3 days before'], [7, '1 week before'], [14, '2 weeks before'], [21, '3 weeks before'],
  [30, '1 month before'], [42, '6 weeks before'], [60, '2 months before'],
];
import { Close, Trash } from './Icons';
import { Checklist } from './TasksSection';

/** "☐ For task: Go grocery shopping  [Mark done]" on a block made from the sidebar. */
function LinkedTo({ id }: { id: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === id));
  const deadline = useStore((s) => s.events.find((e) => e.id === id && e.kind === 'deadline'));
  const st = useStore.getState();
  if (task)
    return (
      <div className="plink">
        <span>☐ For task: <b>{task.title}</b></span>
        <button className={cls('plink-btn', task.done && 'done')} onClick={() => st.setTaskDone(task.id, !task.done)}>
          {task.done ? '✓ Done' : 'Mark done'}
        </button>
      </div>
    );
  if (deadline)
    return (
      <div className="plink">
        <span>⚑ For deadline: <b>{deadline.title}</b></span>
        <button className="plink-btn" onClick={() => st.select(deadline.id)}>Open</button>
      </div>
    );
  return null;
}

const toDate = (t: number) => format(t, 'yyyy-MM-dd');
const toTime = (t: number) => format(t, 'HH:mm');
const withDate = (t: number, v: string) => {
  const [y, m, d] = v.split('-').map(Number);
  const x = new Date(t);
  x.setFullYear(y, m - 1, d);
  return x.getTime();
};
const withTime = (t: number, v: string) => {
  const [h, m] = v.split(':').map(Number);
  const x = new Date(t);
  x.setHours(h, m, 0, 0);
  return x.getTime();
};

type RepeatChoice = 'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';

function choiceOf(r?: Recurrence): RepeatChoice {
  if (!r) return 'none';
  if (r.until !== undefined) return 'custom';
  if (r.freq === 'daily' && r.interval === 1) return 'daily';
  if (r.freq === 'weekly' && r.byDay?.join() === '1,2,3,4,5' && r.interval === 1) return 'weekdays';
  if (r.freq === 'weekly' && (r.byDay?.length ?? 1) <= 1) return r.interval === 1 ? 'weekly' : r.interval === 2 ? 'biweekly' : 'custom';
  if (r.freq === 'monthly' && r.interval === 1) return 'monthly';
  if (r.freq === 'yearly' && r.interval === 1) return 'yearly';
  return 'custom';
}

function ruleOf(c: RepeatChoice, start: number): Recurrence | undefined {
  const wd = new Date(start).getDay();
  switch (c) {
    case 'daily': return { freq: 'daily', interval: 1 };
    case 'weekdays': return { freq: 'weekly', interval: 1, byDay: [1, 2, 3, 4, 5] };
    case 'weekly': return { freq: 'weekly', interval: 1, byDay: [wd] };
    case 'biweekly': return { freq: 'weekly', interval: 2, byDay: [wd] };
    case 'monthly': return { freq: 'monthly', interval: 1 };
    case 'yearly': return { freq: 'yearly', interval: 1 };
    default: return undefined;
  }
}

export function EventPanel() {
  const events = useStore((s) => s.events);
  const selectedId = useStore((s) => s.selectedId);
  const ev = useMemo(() => resolveEvent(events, selectedId), [events, selectedId]);
  const calendars = useStore((s) => s.calendars);
  const zone = useStore((s) => s.zone);
  const homeZone = useStore((s) => s.homeZone);
  const { updateEvent, deleteEvent, select } = useStore.getState();
  const titleRef = useRef<HTMLInputElement>(null);

  // For one occurrence of a repeating event: change just this one, or the whole series?
  const occurrence = !!selectedId && isOccurrenceId(selectedId);
  const seriesKey = ev?.seriesId ?? ev?.id;
  const [scope, setScope] = useState<Scope>('this');
  useEffect(() => setScope('this'), [seriesKey]);

  useEffect(() => {
    if (ev && !ev.title) titleRef.current?.focus();
  }, [ev?.id]);

  // A just-dragged event is a draft: clicking anywhere but its card (or the block itself) throws it away.
  const pending = useStore((s) => !!ev && s.pendingId === ev.id);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pending || !ev) return;
    const id = ev.id;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (asideRef.current?.contains(t) || t.closest?.(`[data-ev="${CSS.escape(id)}"]`)) return;
      useStore.getState().select(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [pending, ev?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ev) return null;
  if (isLocked(useStore.getState(), ev.id)) return <SubscribedEvent ev={ev} />;
  const rawMaster = occurrence ? events.find((e) => e.id === ev.seriesId) : undefined;
  const master = ev.recurrence ? (rawMaster ? decodeEvent(rawMaster) : ev) : undefined;
  const isException = !occurrence && !!ev.seriesId;
  const cal = calendars.find((c) => c.id === ev.calendarId);
  const up = (patch: Partial<CalEvent>, typing = false) => updateEvent(ev.id, patch, typing, occurrence ? scope : 'this');
  const setRepeat = (c: RepeatChoice) => {
    const rule = ruleOf(c, ev.start);
    if (occurrence) {
      updateEvent(ev.id, { recurrence: rule }, false, 'all');
      if (!rule) select(ev.seriesId!); // no longer repeating: show the one remaining event
    } else updateEvent(ev.id, { recurrence: rule });
  };
  const dur = ev.end - ev.start;

  // Moving the start keeps the duration; the end can never go before the start.
  const setStart = (start: number) => !isNaN(start) && up({ start, end: start + dur });
  const setEnd = (end: number) => {
    if (isNaN(end)) return;
    up({ end: Math.max(end, ev.start + (ev.allDay ? 0 : 15 * MIN)) });
  };
  // All-day events store an exclusive end (next midnight); the form shows the last day.
  const lastDay = ev.allDay ? ev.end - 1 : ev.end;

  // A deadline is a moment (start = end), 5 PM unless a time is set.
  const setDue = (t: number) => !isNaN(t) && up({ start: t, end: t });
  const toggleDeadline = (on: boolean) => {
    if (on) {
      const t = ev.allDay ? withTime(ev.start, '17:00') : ev.end; // an event's end is when it's "due"
      up({ kind: 'deadline', calendarId: '', allDay: false, start: t, end: t, leadDays: ev.leadDays ?? defaultLeadDays() });
    } else up({ kind: undefined, done: undefined, calendarId: newEventCalendarId(useStore.getState()), end: ev.start + 60 * MIN });
  };

  const toggleAllDay = (allDay: boolean) => {
    if (allDay) {
      const s = startOfDay(ev.start).getTime();
      up({ allDay, start: s, end: Math.max(addDays(startOfDay(ev.end - 1), 1).getTime(), addDays(s, 1).getTime()) });
    } else {
      const s = withTime(ev.start, '09:00');
      up({ allDay, start: s, end: s + 60 * MIN });
    }
  };

  return (
    <aside
      ref={asideRef}
      className={cls('panel', pending && 'pending')}
      // Enter anywhere in a draft's card (except the notes box) keeps it.
      onKeyDown={(e) => {
        if (pending && e.key === 'Enter' && !e.shiftKey && !(e.target as HTMLElement).closest('textarea')) {
          e.preventDefault();
          useStore.getState().confirmDraft();
        }
      }}
      style={{ '--c': ev.kind === 'deadline' ? URGENCY_COLOR[urgency(ev)] : cal?.color } as CSSProperties}>
      <div className="panel-top">
        {ev.kind === 'deadline' ? (
          <span className="panel-cal panel-cal-static">⚑ Deadline</span>
        ) : (
          <>
            <span className="panel-cal-dot" />
            <select className="panel-cal" value={ev.calendarId} onChange={(e) => up({ calendarId: e.target.value })}>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </>
        )}
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close">
          <Close />
        </button>
      </div>

      <input
        ref={titleRef}
        className="panel-title"
        value={ev.title}
        placeholder="New Event"
        onChange={(e) => up({ title: e.target.value }, true)}
        onKeyDown={(e) => e.key === 'Enter' && !pending && (e.target as HTMLInputElement).blur()}
      />

      {ev.kind === 'deadline' && (
        <div className={cls('pdl', urgency(ev), ev.done && 'done')} style={{ '--c': URGENCY_COLOR[urgency(ev)] } as CSSProperties}>
          ⚑ Deadline · {ev.done ? 'done ✓' : countdown(ev)}
        </div>
      )}

      {occurrence && (
        <div className="scope" role="radiogroup" aria-label="Apply changes to">
          <span>Changes apply to</span>
          <div className="seg">
            <button className={cls(scope === 'this' && 'on')} onClick={() => setScope('this')}>This event</button>
            <button className={cls(scope === 'all' && 'on')} onClick={() => setScope('all')}>All events</button>
          </div>
        </div>
      )}

      <div className="panel-rows">
        <label className="prow">
          <span>Deadline</span>
          <input type="checkbox" className="switch" checked={ev.kind === 'deadline'} onChange={(e) => toggleDeadline(e.target.checked)} />
        </label>
        {ev.kind === 'deadline' ? (
          <>
            <div className="prow">
              <span>Due</span>
              <div className="pinputs">
                <input type="date" value={toDate(ev.start)} onChange={(e) => setDue(withDate(ev.start, e.target.value))} />
                <input type="time" step={300} value={toTime(ev.start)} onChange={(e) => setDue(withTime(ev.start, e.target.value))} />
              </div>
            </div>
            <div className="prow">
              <span>Work starts</span>
              <select className="pselect" value={ev.leadDays ?? defaultLeadDays()} onChange={(e) => up({ leadDays: +e.target.value })}>
                {[...LEAD_CHOICES, ...(LEAD_CHOICES.some(([d]) => d === (ev.leadDays ?? defaultLeadDays())) ? [] : [[ev.leadDays!, `${ev.leadDays} days before`] as [number, string]])].map(([d, label]) => (
                  <option key={d} value={d}>{label}</option>
                ))}
              </select>
            </div>
            <label className="prow">
              <span>Done</span>
              <input type="checkbox" className="switch" checked={!!ev.done} onChange={(e) => up({ done: e.target.checked })} />
            </label>
          </>
        ) : (
          <>
        <label className="prow">
          <span>All-day</span>
          <input type="checkbox" className="switch" checked={ev.allDay} onChange={(e) => toggleAllDay(e.target.checked)} />
        </label>
        <div className="prow">
          <span>Starts</span>
          <div className="pinputs">
            <input type="date" value={toDate(ev.start)} onChange={(e) => setStart(withDate(ev.start, e.target.value))} />
            {!ev.allDay && <input type="time" step={300} value={toTime(ev.start)} onChange={(e) => setStart(withTime(ev.start, e.target.value))} />}
          </div>
        </div>
        <div className="prow">
          <span>Ends</span>
          <div className="pinputs">
            <input
              type="date"
              value={toDate(lastDay)}
              onChange={(e) => {
                const d = withDate(lastDay, e.target.value);
                setEnd(ev.allDay ? addDays(startOfDay(d), 1).getTime() : d);
              }}
            />
            {!ev.allDay && <input type="time" step={300} value={toTime(ev.end)} onChange={(e) => setEnd(withTime(ev.end, e.target.value))} />}
          </div>
        </div>
          </>
        )}
        <div className="prow">
          <span>Repeat</span>
          {isException ? (
            <span className="prow-note">Changed occurrence of a repeating event</span>
          ) : (
            <select className="pselect" value={choiceOf(master?.recurrence)} onChange={(e) => setRepeat(e.target.value as RepeatChoice)}>
              <option value="none">Never</option>
              <option value="daily">Every day</option>
              <option value="weekdays">Every weekday</option>
              <option value="weekly">Every week ({format(ev.start, 'EEEE')})</option>
              <option value="biweekly">Every 2 weeks ({format(ev.start, 'EEEE')})</option>
              <option value="monthly">Every month (the {format(ev.start, 'do')})</option>
              <option value="yearly">Every year ({format(ev.start, 'MMM d')})</option>
              {choiceOf(master?.recurrence) === 'custom' && <option value="custom">{describeRecurrence(master!.recurrence!, master!.start)}</option>}
            </select>
          )}
        </div>
        <div className="prow">
          <span>Alert</span>
          {(() => {
            const st = useStore.getState();
            const d = { alertMin: st.settings.alertMin, alertAllDayMin: st.settings.alertAllDayMin, alertDeadlineMin: st.settings.alertDeadlineMin };
            const own = master?.alert !== undefined ? master.alert : ev.alert;
            const fallback = alertFor({ ...ev, alert: undefined }, cal, d);
            const choices = ev.allDay && ev.kind !== 'deadline' ? ALL_DAY_CHOICES : TIMED_CHOICES;
            const value = own === undefined ? 'default' : own === null ? 'none' : String(own);
            const set = (v: string) => {
              const alert = v === 'default' ? undefined : v === 'none' ? null : Number(v);
              updateEvent(ev.id, { alert }, false, occurrence ? 'all' : 'this'); // a series' alert is the series'
            };
            return (
              <select className="pselect" value={value} onChange={(e) => set(e.target.value)} aria-label="Alert">
                <option value="default">Default · {describeAlert(fallback, ev.allDay && ev.kind !== 'deadline').replace('minutes', 'min').replace(/^(\w)/, (c) => c.toLowerCase())}</option>
                <option value="none">None</option>
                {choices.map(([m, l]) => <option key={m} value={String(m)}>{l}</option>)}
                {typeof own === 'number' && !choices.some(([m]) => m === own) && <option value={String(own)}>{describeAlert(own, ev.allDay)}</option>}
              </select>
            );
          })()}
        </div>
      </div>

      {zone !== homeZone && !ev.allDay && (() => {
        const w = wallClock(ev.start, homeZone);
        const t = `${w.h % 12 || 12}:${String(w.min).padStart(2, '0')} ${w.h < 12 ? 'AM' : 'PM'}`;
        const sameDay = wallClock(ev.start).d === w.d;
        return (
          <div className="ptz">
            ✈ Times shown in {zoneCity(zone)} time ({zoneAbbr(zone)}) · {t}
            {sameDay ? '' : ` (${w.d > wallClock(ev.start).d ? 'next day' : 'previous day'})`} in {zoneCity(homeZone)}
          </div>
        );
      })()}

      {ev.kind === 'deadline' && <Checklist deadlineId={ev.id} />}
      {ev.linkedTo && <LinkedTo id={ev.linkedTo} />}

      <div className="panel-rows">
        <input className="pfield" placeholder="Location" value={ev.location ?? ''} onChange={(e) => up({ location: e.target.value }, true)} />
        <input className="pfield" placeholder="URL" value={ev.url ?? ''} onChange={(e) => up({ url: e.target.value }, true)} />
        <textarea className="pfield notes" placeholder="Notes" value={ev.notes ?? ''} onChange={(e) => up({ notes: e.target.value }, true)} />
      </div>

      {pending ? (
        <div className="draft-row">
          <button className="draft-discard" onClick={() => select(null)}>Discard</button>
          <button className="draft-add" onClick={() => useStore.getState().confirmDraft()}>
            Add event <kbd>↵</kbd>
          </button>
        </div>
      ) : master ? (
        <div className="delete-row">
          <button className="delete-btn" onClick={() => deleteEvent(ev.id, 'this')}>
            <Trash /> Delete this event
          </button>
          <button className="delete-btn" onClick={() => deleteEvent(ev.id, 'all')}>
            Delete all events
          </button>
        </div>
      ) : (
        <button className="delete-btn" onClick={() => deleteEvent(ev.id)}>
          <Trash /> Delete event
        </button>
      )}
    </aside>
  );
}

/** An event from a subscribed calendar (department, team…): shown, not edited — it changes at its source. */
function SubscribedEvent({ ev }: { ev: CalEvent }) {
  const cal = useStore((s) => s.calendars.find((c) => c.id === ev.calendarId));
  const when = ev.allDay
    ? ev.end - ev.start > 86_400_000
      ? `${format(ev.start, 'EEE, MMM d')} – ${format(ev.end - 1, 'EEE, MMM d')}`
      : format(ev.start, 'EEEE, MMMM d')
    : `${format(ev.start, 'EEEE, MMMM d')} · ${fmtTimeRange(ev.start, ev.end)}`;
  return (
    <aside className="panel panel-ro" style={{ '--c': cal?.color } as CSSProperties}>
      <div className="panel-top">
        <span className="panel-cal-dot" />
        <span className="panel-cal panel-cal-static">{cal?.name} · subscribed</span>
        <button className="icon-btn" onClick={() => useStore.getState().select(null)} aria-label="Close"><Close /></button>
      </div>
      <h2 className="panel-title ro">{ev.title}</h2>
      <div className="ro-when">{when}</div>
      {ev.location && <div className="ro-row">📍 {ev.location}</div>}
      {ev.url && <a className="ro-row ro-link" href={ev.url} target="_blank" rel="noopener noreferrer">{ev.url}</a>}
      {ev.notes && <div className="ro-notes">{ev.notes}</div>}
      <div className="ro-foot">From a subscribed calendar — read-only here; it updates from its source.</div>
    </aside>
  );
}
