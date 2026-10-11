// Sidebar to-do list: Today (overdue first), Upcoming, Anytime. Add with one line; tick to finish.
import { useEffect, useMemo, useRef, useState } from 'react';
import { format, isSameDay, addDays, startOfDay } from 'date-fns';
import { useStore } from '../data/store';
import { useNow } from '../lib/hooks';
import { cls, fmtTime } from '../lib/format';
import { bucketTasks, doneStats, dueOf, overdueDays, stripTaskPrefix, taskFromParsed, type Task } from '../lib/tasks';
import { parseQuick } from '../lib/quickparse';
import { justDragged, startBlockDrag } from './BlockDrag';
import { weekStart } from '../lib/dates';

const ANYTIME_SHOWN = 6;
const UPCOMING_DAYS = 7; // Upcoming shows everything due this coming week; later ones fold under "N later"
const RECENT_MS = 30 * 60_000; // something you just added or scheduled is never folded away

function dueLabel(t: Task, now: number) {
  const d = dueOf(t);
  if (d === undefined) return null;
  const late = overdueDays(t, now);
  if (late > 0) return { text: late === 1 ? 'yesterday' : `${late}d late`, late: true };
  if (isSameDay(d, now)) return null; // it's in "Today" already
  if (isSameDay(d, addDays(now, 1))) return { text: 'Tomorrow', late: false };
  return { text: d - now < 6 * 86_400_000 ? format(d, 'EEE') : format(d, 'MMM d'), late: false };
}

export function TaskRow({ t, now, leaving, parentTitle, block, onTick }: {
  t: Task;
  now: number;
  leaving?: boolean;
  parentTitle?: string;
  block?: { id: string; start: number }; // time blocked out for it on the calendar
  onTick: (t: Task) => void;
}) {
  const selectedId = useStore((s) => s.selectedId);
  const flashId = useStore((s) => s.flashId);
  const due = dueLabel(t, now);
  const done = t.done || leaving;
  return (
    <div
      className={cls('tk', done && 'done', leaving && 'leaving', t.id === selectedId && 'selected', t.id === flashId && 'flash')}
      onClick={() => !justDragged() && useStore.getState().toggleSelect(t.id)}
      onPointerDown={(e) => !t.done && startBlockDrag(e, { kind: 'task', id: t.id, title: t.title })}
      title="Click to edit · drag onto the calendar to block out time"
    >
      <button
        className="tk-check"
        aria-label={done ? `Mark “${t.title}” not done` : `Mark “${t.title}” done`}
        onClick={(e) => {
          e.stopPropagation();
          onTick(t);
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span className="tk-body">
        <span className="tk-title">{t.title}</span>
        {(parentTitle || block) && (
          <span className="tk-meta">
            {block && (
              <button
                className="tk-block"
                title="Time blocked for this on the calendar — click to see it"
                onClick={(e) => {
                  e.stopPropagation();
                  useStore.getState().goTo(block.start);
                  useStore.getState().select(block.id);
                }}
              >
                🕑 {isSameDay(block.start, now) ? 'Today' : isSameDay(block.start, addDays(now, 1)) ? 'Tomorrow' : format(block.start, 'EEE MMM d')}{' '}
                {fmtTime(block.start)}
              </button>
            )}
            {parentTitle && <span className="tk-parent">⚑ {parentTitle}</span>}
          </span>
        )}
      </span>
      {due && <span className={cls('tk-due', due.late && 'late')}>{due.text}</span>}
    </div>
  );
}

/** Tick a task: it strikes through, lingers a moment, then slides out of the list (Undo in the toast). */
export function useTick() {
  const [leaving, setLeaving] = useState<Record<string, true>>({});
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const tick = (t: Task) => {
    const st = useStore.getState();
    if (t.done) return st.setTaskDone(t.id, false);
    st.setTaskDone(t.id, true);
    setLeaving((l) => ({ ...l, [t.id]: true }));
    timers.current.push(
      window.setTimeout(() => setLeaving((l) => {
        const { [t.id]: _, ...rest } = l;
        return rest;
      }), 1400),
    );
  };
  return { leaving, tick };
}

export function useTaskSummary() {
  const tasks = useStore((s) => s.tasks);
  const now = useNow(60_000);
  const b = useMemo(() => bucketTasks(tasks, now), [tasks, now]);
  return { count: b.today.length, overdue: b.today.some((t) => overdueDays(t, now) > 0) };
}

export function TasksBody() {
  const tasks = useStore((s) => s.tasks);
  const events = useStore((s) => s.events);
  const calendars = useStore((s) => s.calendars);
  const now = useNow(60_000);
  const { leaving, tick } = useTick();
  const [draft, setDraft] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [more, setMore] = useState({ upcoming: false, anytime: false });

  // Blocks of time made for tasks (dragged onto the calendar): the next one per task.
  const blocks = useMemo(() => {
    const m = new Map<string, { id: string; start: number }>();
    const today0 = startOfDay(now).getTime();
    for (const e of events) {
      if (!e.linkedTo || e.end < today0) continue;
      const cur = m.get(e.linkedTo);
      if (!cur || e.start < cur.start) m.set(e.linkedTo, { id: e.id, start: e.start });
    }
    return m;
  }, [events, now]);
  const scheduled = useMemo(() => new Map([...blocks].map(([k, v]) => [k, v.start])), [blocks]);
  // Just-ticked tasks stay in place (struck through) for a moment before leaving.
  const b = useMemo(
    () => bucketTasks(tasks.map((t) => (leaving[t.id] ? { ...t, done: false } : t)), now, scheduled),
    [tasks, leaving, now, scheduled],
  );
  const doneToday = useMemo(() => bucketTasks(tasks, now).doneToday, [tasks, now]);
  const stats = useMemo(() => doneStats(tasks, now), [tasks, now]);
  const flashId = useStore((s) => s.flashId);
  const selectedId = useStore((s) => s.selectedId);
  const keep = (t: Task) => now - t.createdAt < RECENT_MS || t.id === flashId || t.id === selectedId;
  const deadlineTitle = useMemo(() => new Map(events.filter((e) => e.kind === 'deadline').map((e) => [e.id, e.title])), [events]);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    useStore.getState().addTask(taskFromParsed(parseQuick(stripTaskPrefix(text), calendars))); // "pay rent friday" → due Friday
    setDraft('');
  };
  const row = (t: Task) => (
    <TaskRow
      key={t.id}
      t={t}
      now={now}
      leaving={!!leaving[t.id]}
      parentTitle={t.parentId ? deadlineTitle.get(t.parentId) : undefined}
      block={blocks.get(t.id)}
      onTick={tick}
    />
  );
  const weekEnd = addDays(startOfDay(now), UPCOMING_DAYS + 1).getTime();
  const upcoming = more.upcoming ? b.upcoming : b.upcoming.filter((t) => dueOf(t)! < weekEnd || keep(t));
  const anytime = more.anytime ? b.anytime : b.anytime.filter((t, i) => i < ANYTIME_SHOWN || keep(t));

  return (
    <>
      <input
        className="tk-add"
        placeholder="Add a task…  (“pay rent friday”)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') add();
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="tk-group">Today</div>
      {b.today.length ? b.today.map(row) : <div className="tk-empty">No remaining time sensitive tasks</div>}
      {b.upcoming.length > 0 && <div className="tk-group">Upcoming</div>}
      {upcoming.map(row)}
      {b.upcoming.length > upcoming.length && (
        <button className="tk-more" onClick={() => setMore((m) => ({ ...m, upcoming: true }))}>{b.upcoming.length - upcoming.length} later</button>
      )}
      {b.anytime.length > 0 && <div className="tk-group">Anytime</div>}
      {anytime.map(row)}
      {b.anytime.length > anytime.length && (
        <button className="tk-more" onClick={() => setMore((m) => ({ ...m, anytime: true }))}>{b.anytime.length - anytime.length} more</button>
      )}
      {stats.week > 0 && (
        <div className="tk-stats">
          <button className="tk-done-today" onClick={() => setShowDone(!showDone)} disabled={!doneToday.length} title="Show what you finished today">
            ✓ {stats.today} today
          </button>
          <span className="tk-week">· {stats.week} this week</span>
          <span className="tk-spark" title="Finished per day this week">
            {stats.perDay.map((n, k) => (
              <i
                key={k}
                className={cls(k === stats.todayIndex && 'today', k > stats.todayIndex && 'future')}
                style={{ height: `${n ? 3 + (n / Math.max(...stats.perDay)) * 11 : 2}px` }}
                title={`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][(k + weekStart()) % 7]}: ${n} done`}
              />
            ))}
          </span>
        </div>
      )}
      {showDone && doneToday.map((t) => <TaskRow key={t.id} t={t} now={now} onTick={tick} />)}
    </>
  );
}

/** A deadline's checklist: its steps, progress, and a line to add more ("budget by oct 25"). */
export function Checklist({ deadlineId }: { deadlineId: string }) {
  const tasks = useStore((s) => s.tasks);
  const calendars = useStore((s) => s.calendars);
  const now = useNow(60_000);
  const [draft, setDraft] = useState('');
  const steps = useMemo(
    () =>
      tasks
        .filter((t) => t.parentId === deadlineId)
        .sort((a, b) => Number(!!a.done) - Number(!!b.done) || (dueOf(a) ?? Infinity) - (dueOf(b) ?? Infinity) || a.createdAt - b.createdAt),
    [tasks, deadlineId],
  );
  const done = steps.filter((t) => t.done).length;
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    useStore.getState().addTask({ ...taskFromParsed(parseQuick(stripTaskPrefix(text), calendars)), parentId: deadlineId });
    setDraft('');
  };
  return (
    <div className="checklist">
      <div className="checklist-head">
        <span>Checklist</span>
        {steps.length > 0 && <span className="checklist-count">{done}/{steps.length}</span>}
      </div>
      {steps.length > 0 && (
        <div className="checklist-bar">
          <i style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
      )}
      {steps.map((t) => (
        <TaskRow key={t.id} t={t} now={now} onTick={(x) => useStore.getState().setTaskDone(x.id, !x.done, true)} />
      ))}
      <input
        className="tk-add"
        placeholder="Add a step…  (“budget by oct 25”)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
    </div>
  );
}
