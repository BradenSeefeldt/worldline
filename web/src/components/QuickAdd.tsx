// Type (or dictate) a sentence, see what it understood, press Enter.
// A sentence either creates an event ("lunch with Sam tomorrow 12:30", "Alex 1:1 every friday at 3")
// or changes existing ones ("skip plasma meeting this week", "cancel all recurring Alex meetings").
// Suggestions are only ever offered: nothing is filled in unless you pick one (↓ then Enter).
import { useMemo, useState, type CSSProperties } from 'react';
import { format, isSameDay, isSameYear } from 'date-fns';
import { newEventCalendarId, useStore } from '../data/store';
import type { CalEvent } from '../data/types';
import { parseQuick } from '../lib/quickparse';
import { parseCommand, type Change, type Command } from '../lib/commands';
import { suggest, type SuggestionKind } from '../lib/suggest';
import { phraseAction, typeahead, type PhraseAction } from '../lib/typeahead';
import { parseHabitLog } from '../lib/habitlog';
import { amountOn, calendarCredit, periodProgress } from '../lib/habits';
import { decodeEvent, describeRecurrence, expand } from '../lib/recurrence';
import { cls, fmtTime, fmtTimeRange } from '../lib/format';
import { countdown, DEFAULT_LEAD_DAYS } from '../lib/deadlines';
import { dueOf, guessKind, hasTaskPrefix, stripTaskPrefix, taskFromParsed, tasksForCommands, type ItemKind } from '../lib/tasks';
import { startOfDay } from 'date-fns';

const KINDS: { id: ItemKind; label: string }[] = [
  { id: 'event', label: 'Event' },
  { id: 'task', label: 'Task' },
  { id: 'deadline', label: 'Deadline' },
];
import { Sparkle } from './Icons';

const DAY = 86_400_000;
const EXAMPLES = [
  'Lunch with Sam tomorrow 12:30 at Fran’s',
  'Alex 1:1 every friday at 3',
  'Skip journal club this week',
  'Push gym back 30 min',
  'Email Jordan the plots',
];
// One icon per thing a suggestion would DO, in three colours: green adds/completes, blue changes the time, red removes.
const svg = (d: React.ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const ACTION: Record<PhraseAction, { tone: 'add' | 'time' | 'remove'; label: string; icon: React.ReactNode }> = {
  event: { tone: 'add', label: 'New event', icon: svg(<path d="M12 5v14M5 12h14" />) },
  task: { tone: 'add', label: 'New task', icon: svg(<><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></>) },
  deadline: { tone: 'add', label: 'New deadline', icon: svg(<path d="M6 21V4M6 4h11l-2.5 4L17 12H6" />) },
  done: { tone: 'add', label: 'Mark done', icon: svg(<path d="M5 12.5l4.5 4.5L19 7.5" />) },
  move: { tone: 'time', label: 'Move', icon: svg(<path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4" />) },
  shift: { tone: 'time', label: 'Push / shift', icon: svg(<path d="M4 12h14M13 6l6 6-6 6" />) },
  resize: { tone: 'time', label: 'Change length', icon: svg(<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4" />) },
  delete: { tone: 'remove', label: 'Remove', icon: svg(<path d="M6 6l12 12M18 6L6 18" />) },
};
const VERB: Record<Command['kind'], string> = { delete: 'Delete', move: 'Move', shift: 'Shift', resize: 'Resize', done: 'Done ✓' };

function describeWhen(p: { start: number; end: number; allDay: boolean }) {
  const now = new Date();
  const day = (t: number) => format(t, isSameYear(t, now) ? 'EEE, MMM d' : 'EEE, MMM d, yyyy');
  if (p.allDay) {
    const last = p.end - 1;
    return isSameDay(p.start, last) ? `${day(p.start)} · all-day` : `${day(p.start)} – ${day(last)} · all-day`;
  }
  if (isSameDay(p.start, p.end - 1)) return `${day(p.start)} · ${fmtTimeRange(p.start, p.end)}`;
  return `${day(p.start)} ${fmtTime(p.start)} → ${day(p.end)} ${fmtTime(p.end)}`;
}

/** For a whole series: "Weekly on Friday · 3 – 4 PM" */
function describeSeries(e: { start: number; end: number; allDay: boolean; recurrence?: CalEvent['recurrence'] }) {
  const rule = e.recurrence ? describeRecurrence(e.recurrence, e.start) : '';
  return e.allDay ? rule : `${rule} · ${fmtTimeRange(e.start, e.end)}`;
}

function relative(t: number) {
  const days = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return `In ${days} days`;
  return null;
}

export function QuickAdd() {
  const calendars = useStore((s) => s.calendars);
  const raw = useStore((s) => s.events);
  const tasks = useStore((s) => s.tasks);
  const skipped = useStore((s) => s.skipped);
  const dismissed = useStore((s) => s.dismissed);
  const defaultId = useStore(newEventCalendarId);
  const st = useStore.getState;

  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string | null>(null); // calendar chosen by tapping the chip
  const [matchIdx, setMatchIdx] = useState(0); // which matching event a command applies to (Tab)
  const [hi, setHi] = useState(-1); // highlighted suggestion (↑/↓); -1 = none
  const [kindOverride, setKindOverride] = useState<ItemKind | null>(null); // Tab: event → task → deadline
  const [habitOff, setHabitOff] = useState(false); // Tab away from "Log habit" back to the usual preview
  const habits = useStore((s) => s.habits);
  const habitLog = useStore((s) => s.habitLog);

  // Events as the commands and suggestions see them: one-offs plus occurrences of series.
  const now = useMemo(() => Date.now(), []);
  const masters = useMemo(() => raw.filter((e) => e.recurrence).map(decodeEvent), [raw]);
  const events = useMemo(() => expand(raw, now - 120 * DAY, now + 400 * DAY), [raw, now]);
  // Commands and suggestions can also reach open tasks ("done email Jordan", "move pay rent to monday").
  const withTasks = useMemo(() => [...events, ...tasksForCommands(tasks, now)], [events, tasks, now]);
  const taskIds = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks]);

  const typing = text.trim().length > 0;
  const cmd = useMemo(
    () => (typing && !hasTaskPrefix(text) ? parseCommand(text, withTasks, calendars, new Date(), masters) : null),
    [typing, text, withTasks, calendars, masters],
  );
  const parsed = useMemo(() => (typing ? parseQuick(stripTaskPrefix(text), calendars) : null), [typing, text, calendars]);
  const kind: ItemKind = kindOverride ?? (parsed ? guessKind(text, parsed) : 'event');
  const taskPreview = parsed ? taskFromParsed(parsed) : null;
  // A deadline's due moment: the parsed time, or 5 PM on the day if none was given.
  const dlStart = !parsed ? 0 : parsed.deadline || parsed.hasTime || parsed.timeFromWords ? parsed.start : startOfDay(parsed.start).getTime() + 17 * 3_600_000;
  const lead = parsed?.deadline?.leadDays ?? DEFAULT_LEAD_DAYS;
  const weekAhead = useMemo(() => suggest(events, calendars, { skipped, dismissed, tasks, habits, habitLog }), [events, calendars, skipped, dismissed, tasks, habits, habitLog]);
  // Logging a habit ("did gym", "read 20 pages") — a strict, separate reader; when it says no, nothing below changes.
  const habitPlan = useMemo(() => (typing && !hasTaskPrefix(text) ? parseHabitLog(text, habits) : null), [typing, text, habits]);
  const asYouType = useMemo(
    () => (typing ? typeahead(text, withTasks, masters, calendars, weekAhead) : []),
    [typing, text, withTasks, masters, calendars, weekAhead],
  );
  const list = typing ? asYouType.map((x) => ({ ...x, id: x.phrase, kind: null as SuggestionKind | null })) : weekAhead;
  const active = typing ? hi : Math.max(hi, 0); // the empty box always has one highlighted
  const actions = useMemo(() => list.map((s) => phraseAction(s.phrase, calendars)), [list, calendars]);

  const calId = picked ?? parsed?.calendarId ?? defaultId;
  const cal = calendars.find((c) => c.id === calId) ?? calendars[0];
  const calById = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);

  const n = cmd?.matches.length ?? 0;
  const targets: CalEvent[] = !cmd || !n ? [] : cmd.all ? cmd.matches : [cmd.matches[matchIdx % n]];
  const habitMode = !!habitPlan && !habitOff && !(cmd && n > 0); // a command that finds something still wins
  const habitNow = useMemo(() => {
    if (!habitPlan) return null;
    const h = habitPlan.habit;
    const credit = calendarCredit(h, events, Date.now());
    const shown = amountOn(h, habitLog, credit, habitPlan.day);
    const next = h.kind === 'check' ? 1 : shown + habitPlan.amount;
    const after = { ...habitLog, [h.id]: { ...(habitLog[h.id] ?? {}), [habitPlan.day]: next } };
    return { shown, next, progress: periodProgress(h, after, credit, habitPlan.day), already: h.kind === 'check' && shown >= 1 };
  }, [habitPlan, events, habitLog]);

  const fill = (phrase: string) => {
    setText(phrase);
    setHi(-1);
    setMatchIdx(0);
  };
  const cycleCalendar = () => {
    const i = calendars.findIndex((c) => c.id === cal.id);
    setPicked(calendars[(i + 1) % calendars.length].id);
  };
  const close = () => st().setQuickAdd(false);
  const reveal = (t: number, id?: string) => {
    const { visibleRange: v } = st();
    if (t < v.start || t >= v.end) st().goTo(t); // only scroll if it's off-screen
    if (id) st().flash(id);
  };

  const cycleKind = () => setKindOverride(KINDS[(KINDS.findIndex((k) => k.id === kind) + 1) % KINDS.length].id);

  const create = () => {
    if (!parsed) return;
    if (kind === 'task') {
      const t = taskFromParsed(parsed);
      st().addTask(t);
      close();
      st().showToast(`Added task “${t.title}” · ${t.due === undefined ? 'Anytime' : relative(t.due) ?? format(t.due, 'EEE MMM d')}`);
      return;
    }
    const title = parsed.title || (kind === 'deadline' ? 'New deadline' : 'New Event');
    const { location, recurrence } = parsed;
    let { start, end, allDay } = parsed;
    const deadline = kind === 'deadline' ? parsed.deadline ?? { leadDays: DEFAULT_LEAD_DAYS } : undefined;
    if (deadline && !parsed.deadline) {
      // switched to "deadline" by hand: due at 5 PM on that day unless a time was given
      if (!parsed.hasTime && !parsed.timeFromWords) start = startOfDay(start).getTime() + 17 * 3_600_000;
      end = start;
      allDay = false;
    }
    if (kind === 'event' && parsed.deadline) end = start + 3_600_000; // switched away from "deadline"
    const id = st().createEvent({
      calendarId: deadline ? '' : cal.id, // deadlines don't belong to a calendar
      title, start, end, allDay, location,
      ...(recurrence ? { recurrence } : {}),
      ...(deadline ? { kind: 'deadline' as const, leadDays: deadline.leadDays } : {}),
    });
    close();
    reveal(start, recurrence ? undefined : id);
    st().showToast(
      deadline
        ? `Added deadline “${title}” · due ${format(start, 'EEE MMM d, h:mm a')}`
        : recurrence ? `Added “${title}” · ${describeRecurrence(recurrence, start)}` : `Added “${title}” · ${format(start, 'EEE MMM d')}`,
      true,
      recurrence ? undefined : id,
    );
  };

  const apply = () => {
    if (!cmd || !targets.length) return;
    const one = targets.length === 1 ? targets[0] : null;
    const name = one ? `“${one.title}”` : `${targets.length} ${targets.every((e) => taskIds.has(e.id)) ? 'tasks' : 'events'}`;
    // Tasks live in their own list; everything else goes through the event edits.
    const taskTargets = targets.filter((e) => taskIds.has(e.id));
    const eventTargets = targets.filter((e) => !taskIds.has(e.id));
    if (taskTargets.length) {
      for (const t of taskTargets) {
        if (cmd.kind === 'done') st().setTaskDone(t.id, true, true);
        else if (cmd.kind === 'delete') st().deleteTask(t.id);
        else if (cmd.kind === 'move' || cmd.kind === 'shift') st().updateTask(t.id, { due: startOfDay(cmd.plan(t)!.start).getTime() });
      }
      if (!eventTargets.length) {
        close();
        const p = one && cmd.plan(one);
        st().showToast(
          cmd.kind === 'done' ? `✓ ${name} done` : cmd.kind === 'delete' ? `Dropped ${name}` : `Moved ${name} → ${p ? format(p.start, 'EEE MMM d') : ''}`,
        );
        return;
      }
    }
    if (cmd.kind === 'done') {
      st().applyChanges(eventTargets.map((e) => ({ id: e.id, patch: { done: true } })), []);
      close();
      st().showToast(`✓ ${name} done`);
      return;
    }
    if (cmd.kind === 'delete') {
      if (cmd.series) {
        st().endSeries(targets.map((e) => e.id), Date.now());
        close();
        st().showToast(`Stopped ${name} repeating · past ones kept`);
      } else {
        st().applyChanges([], eventTargets.map((e) => e.id));
        close();
        st().showToast(`Deleted ${name}${one ? ` · ${format(one.start, 'EEE MMM d')}` : ''}`);
      }
      return;
    }
    const updates = eventTargets.map((e) => ({ id: e.id, patch: cmd.plan(e)! as Partial<CalEvent> }));
    st().applyChanges(updates, []);
    close();
    const first = updates[0].patch as Change;
    if (cmd.series) {
      st().showToast(`Changed ${name} · ${describeSeries({ ...first, recurrence: first.recurrence })}`);
      return;
    }
    reveal(first.start, one && !one.seriesId ? one.id : undefined);
    const when = first.allDay ? format(first.start, 'EEE MMM d') : format(first.start, 'EEE MMM d, h:mm a');
    st().showToast(
      cmd.kind === 'move' ? `Moved ${name} → ${when}` : cmd.kind === 'shift' ? `Shifted ${name} ${cmd.summary}` : `Made ${name} ${cmd.summary}`,
      true,
      one && !one.seriesId ? one.id : undefined,
    );
  };

  const logHabit = () => {
    if (!habitPlan || !habitNow) return;
    const h = habitPlan.habit;
    const when = habitPlan.yesterday ? 'yesterday' : 'today';
    close();
    if (habitNow.already) return st().showToast(`${h.title} is already done ${when}`);
    st().setHabitAmount(h.id, habitPlan.day, habitNow.next);
    const p = habitNow.progress;
    const unit = h.kind === 'count' && h.unit ? ` ${h.unit}` : '';
    st().showToast(
      h.kind === 'check'
        ? `✓ ${h.title} ${when}${h.period === 'week' ? ` · ${p.done}/${p.goal} this week` : ''}`
        : `Logged ${h.title} · +${habitPlan.amount}${unit} ${when} (${p.done}/${p.goal}${unit}${h.period === 'week' ? ' this week' : ''})`,
    );
  };

  const submit = (forceCreate = false) => (habitMode && !forceCreate ? logHabit() : cmd && !forceCreate ? apply() : create());

  const suggestionList = list.length ? (
    <div className="qa-suggest">
      <div className="qa-suggest-label">{typing ? 'Suggestions' : 'Suggested for the week ahead'}</div>
      {list.map((s, i) => (
        <div
          key={s.id}
          className={cls('qa-sug', i === active && 'hi')}
          role="button"
          tabIndex={-1}
          onMouseEnter={() => setHi(i)}
          onMouseLeave={() => typing && setHi(-1)}
          onClick={() => fill(s.phrase)}
        >
          <span className={cls('qa-sug-icon', ACTION[actions[i]].tone)} title={ACTION[actions[i]].label}>{ACTION[actions[i]].icon}</span>
          <span className="qa-sug-body">
            <span className="qa-sug-phrase">{s.phrase}</span>
            <span className="qa-sug-reason">{s.reason}</span>
          </span>
          {s.kind && (
            <button
              className="qa-sug-x"
              title="Don't suggest this"
              onClick={(e) => {
                e.stopPropagation();
                st().dismissSuggestion(s.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div className="qa-scrim" onMouseDown={close}>
      <div className="qa" onMouseDown={(e) => e.stopPropagation()} style={{ '--c': cal.color } as CSSProperties}>
        <div className="qa-input-row">
          <Sparkle />
          <input
            autoFocus
            className="qa-input"
            value={text}
            placeholder="Add or change an event — “coffee with Ana thu 3pm”, “skip gym tomorrow”"
            enterKeyHint="done"
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              setMatchIdx(0);
              setHi(-1);
              setKindOverride(null);
              setHabitOff(false);
            }}
            onKeyDown={(e) => {
              if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                const k = list.length;
                if (typing) setHi((h) => (e.key === 'ArrowDown' ? (h + 1 >= k ? -1 : h + 1) : h - 1 < -1 ? k - 1 : h - 1));
                else setHi((h) => (Math.max(h, 0) + (e.key === 'ArrowDown' ? 1 : -1) + k) % k);
                return;
              }
              if (e.key === 'Enter' && active >= 0 && list[active]) {
                e.preventDefault();
                fill(list[active].phrase); // a highlighted suggestion goes into the box; Enter again applies
                return;
              }
              if (e.key === 'Enter') submit(e.shiftKey);
              if (e.key === 'Escape') close();
              if (e.key === 'Tab') {
                e.preventDefault();
                if (!typing && list.length) fill(list[active].phrase);
                else if (habitPlan && (habitMode || !cmd)) {
                  // Log habit → Event → Task → Deadline → Log habit
                  const order = ['habit', ...KINDS.map((k) => k.id)] as const;
                  const next = order[(order.indexOf(habitMode ? 'habit' : kind) + 1) % order.length];
                  setHabitOff(next !== 'habit');
                  setKindOverride(next === 'habit' ? null : next);
                } else if (cmd && n > 1 && !cmd.all) setMatchIdx((i) => i + 1);
                else if (parsed && !cmd) cycleKind();
              }
            }}
          />
        </div>

        {habitMode && habitPlan && habitNow ? (
          <div className="qa-preview k-habit" role="button" tabIndex={-1} onClick={() => logHabit()} style={{ '--c': habitPlan.habit.color } as CSSProperties}>
            <span className="qa-bar" />
            <span className="qa-body">
              <span className="qa-kinds" onClick={(e) => e.stopPropagation()} title="What this is — Tab to switch">
                <button className="on">Log habit</button>
                {KINDS.map((k) => (
                  <button key={k.id} onClick={() => (setHabitOff(true), setKindOverride(k.id))}>{k.label}</button>
                ))}
              </span>
              <span className="qa-title">{habitPlan.habit.title}</span>
              <span className="qa-when">
                {habitNow.already ? (
                  <>Already done {habitPlan.yesterday ? 'yesterday' : 'today'}</>
                ) : (
                  <>
                    <b>{habitPlan.habit.kind === 'check' ? 'Done' : `+${habitPlan.amount}${habitPlan.habit.unit ? ` ${habitPlan.habit.unit}` : ''}`}</b>
                    {' '}{habitPlan.yesterday ? 'yesterday' : 'today'}
                    {' → '}
                    {habitNow.progress.done}/{habitNow.progress.goal}
                    {habitPlan.habit.kind === 'count' && habitPlan.habit.unit ? ` ${habitPlan.habit.unit}` : ''}
                    {habitPlan.habit.period === 'week' ? ' this week' : habitPlan.yesterday ? '' : ' today'}
                    {habitNow.progress.done >= habitNow.progress.goal ? ' · goal met' : ''}
                  </>
                )}
              </span>
            </span>
          </div>
        ) : cmd ? (
          <div className={cls('qa-cmd', cmd.kind)} role="button" tabIndex={-1} onClick={() => apply()}>
            <div className="qa-cmd-head">
              <span className="qa-verb">{cmd.series && cmd.kind === 'delete' ? 'Stop series' : cmd.series ? `${VERB[cmd.kind]} series` : VERB[cmd.kind]}</span>
              {cmd.kind !== 'move' && cmd.summary && !cmd.series && <span className="qa-cmd-sum">{cmd.summary}</span>}
              {cmd.series && cmd.kind === 'delete' && <span className="qa-cmd-sum">from today · past ones stay</span>}
              {cmd.series && cmd.kind === 'shift' && <span className="qa-cmd-sum">{cmd.summary}</span>}
              {!cmd.all && n > 1 && (
                <span className="qa-cmd-count">
                  {(matchIdx % n) + 1} of {n} matches · <kbd>tab</kbd> next
                </span>
              )}
            </div>
            {targets.length ? (
              targets.slice(0, 5).map((ev) => {
                const change = cmd.plan(ev);
                const task = taskIds.has(ev.id) ? tasks.find((t) => t.id === ev.id) : undefined;
                const taskDue = task ? dueOf(task) : undefined;
                const old = task
                  ? `☐ Task · ${taskDue === undefined ? 'Anytime' : `due ${relative(taskDue)?.toLowerCase() ?? format(taskDue, 'EEE MMM d')}`}`
                  : cmd.series ? describeSeries(ev) : describeWhen(ev);
                const next =
                  change &&
                  (task ? `due ${format(change.start, 'EEE MMM d')}` : cmd.series ? describeSeries({ ...change, recurrence: change.recurrence ?? ev.recurrence }) : describeWhen(change));
                return (
                  <div key={ev.id} className="qa-cmd-row" style={{ '--c': calById.get(ev.calendarId)?.color } as CSSProperties}>
                    <span className="qa-bar" />
                    <span className="qa-body">
                      <span className="qa-title">
                        {ev.title}
                        {(ev.recurrence || ev.seriesId) && !cmd.series && <span className="qa-repeat-tag"> ↻ one occurrence</span>}
                      </span>
                      <span className="qa-when">
                        <span className={cls(change || cmd.kind === 'delete' ? 'qa-old' : undefined)}>
                          {ev.kind === 'deadline' ? `⚑ due ${format(ev.start, 'EEE MMM d, h:mm a')} · ${countdown(ev)}` : old}
                        </span>
                        {next && (
                          <>
                            <span className="qa-arrow"> → </span>
                            <b>{next}</b>
                          </>
                        )}
                      </span>
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="qa-cmd-none">
                No upcoming event matches “{cmd.query}”. <kbd>⇧↵</kbd> adds it as a new event instead.
              </div>
            )}
            {targets.length > 5 && <div className="qa-cmd-count">and {targets.length - 5} more</div>}
          </div>
        ) : parsed ? (
          <div className={cls('qa-preview', `k-${kind}`)} role="button" tabIndex={-1} onClick={() => create()}>
            <span className="qa-bar" />
            <span className="qa-body">
              <span className="qa-kinds" onClick={(e) => e.stopPropagation()} title="What this is — Tab to switch">
                {habitPlan && <button onClick={() => (setHabitOff(false), setKindOverride(null))}>Log habit</button>}
                {KINDS.map((k) => (
                  <button key={k.id} className={cls(k.id === kind && 'on')} onClick={() => setKindOverride(k.id)}>
                    {k.label}
                  </button>
                ))}
              </span>
              {kind === 'task' ? (
                <>
                  <span className="qa-title"><span className="qa-box" />{taskPreview!.title}</span>
                  <span className="qa-when">
                    {taskPreview!.due === undefined ? (
                      <>Anytime · <i className="qa-nodate">no date — it goes on your Anytime list</i></>
                    ) : (
                      <>Due <b>{relative(taskPreview!.due) ?? format(taskPreview!.due, 'EEE, MMM d')}</b>{relative(taskPreview!.due) ? ` · ${format(taskPreview!.due, 'EEE, MMM d')}` : ''}</>
                    )}
                  </span>
                </>
              ) : kind === 'deadline' ? (
                <>
                  <span className="qa-title"><span className="qa-flag">⚑ </span>{parsed.title || 'New deadline'}</span>
                  <span className="qa-deadline">
                    Due {format(dlStart, 'EEE, MMM d')} at {format(dlStart, 'h:mm a')} · {countdown({ ...parsed, start: dlStart, end: dlStart, id: '', calendarId: '' })} · work starts{' '}
                    {lead % 7 === 0 ? `${lead / 7} week${lead === 7 ? '' : 's'}` : `${lead} days`} before
                  </span>
                </>
              ) : (
                <>
                  <span className="qa-title">{parsed.title || 'New Event'}</span>
                  <span className="qa-when">
                    {relative(parsed.start) && <b>{relative(parsed.start)} · </b>}
                    {parsed.recurrence ? 'from ' : ''}
                    {describeWhen(parsed.deadline ? { ...parsed, end: parsed.start + 3_600_000 } : parsed)}
                    {!parsed.hasDate && !parsed.recurrence && <i className="qa-nodate"> · no date found, so next hour</i>}
                  </span>
                  {parsed.recurrence && <span className="qa-repeat">↻ {describeRecurrence(parsed.recurrence, parsed.start)}</span>}
                  {parsed.location && <span className="qa-where">{parsed.location}</span>}
                </>
              )}
            </span>
            {kind === 'event' && (
              <button
                className="qa-cal"
                title="Change calendar"
                onClick={(e) => {
                  e.stopPropagation();
                  cycleCalendar();
                }}
              >
                <i className="qa-cal-dot" />
                {cal.name}
                <span className="qa-cal-caret">⌄</span>
              </button>
            )}
          </div>
        ) : null}

        {suggestionList ??
          (!typing && (
            <div className="qa-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => fill(ex)}>{ex}</button>
              ))}
            </div>
          ))}

        <div className="qa-foot">
          {!typing && list.length ? (
            <>
              <span><kbd>↑</kbd><kbd>↓</kbd> choose</span>
              <span><kbd>↵</kbd> use suggestion</span>
              <span>or just type</span>
            </>
          ) : cmd ? (
            <>
              <span><kbd>↵</kbd> apply</span>
              <span><kbd>⇧↵</kbd> add as new event instead</span>
              <span><kbd>⌘Z</kbd> undo</span>
              {list.length > 0 && <span><kbd>↓</kbd> suggestions</span>}
            </>
          ) : (
            <>
              <span><kbd>↵</kbd> add</span>
              <span><kbd>tab</kbd> event / task / deadline</span>
              {list.length > 0 ? <span><kbd>↓</kbd> suggestions</span> : <span>“every friday” repeats</span>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
