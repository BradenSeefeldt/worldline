// Month view: an endless vertical scroll of week rows. Days outside the month you're
// looking at are dimmed, so months read as blocks while you scroll continuously.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { addDays, addMonths, format, startOfMonth } from 'date-fns';
import { newEventCalendarId, useStore } from '../data/store';
import { useEventsIn } from '../data/useEvents';
import type { CalEvent } from '../data/types';
import { MIN, TOTAL_WEEKS, atMinutes, clamp, dateAt, dayIndex, dayStart, isWeekend, weekNumber } from '../lib/dates';
import { assignLanes } from '../lib/layout';
import { useElementSize, useMediaQuery, useNow } from '../lib/hooks';
import { cls, fmtTimeShort } from '../lib/format';
import { asButton } from '../lib/a11y';
import { URGENCY_COLOR, urgency } from '../lib/deadlines';
import { taskAsEvent } from '../lib/tasks';
import { prefs } from '../lib/prefs';

interface Item { ev: CalEvent; a: number; b: number; bar: boolean; lane: number }

export function MonthView() {
  useStore((s) => s.settings.deadlineLook); // (deadline colours: redrawn when they change in Settings)
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(ref);
  const narrow = width > 0 && width < 600;
  const weekNums = useStore((s) => s.settings.weekNumbers);
  const rowH = height ? Math.max(narrow ? 76 : 96, Math.floor(height / 5.4)) : 100;
  const colW = width / 7;
  const laneH = narrow ? 16 : 19;
  const headH = narrow ? 24 : 28;
  const maxLanes = Math.max(1, Math.floor((rowH - headH - 4) / laneH));

  const calendars = useStore((s) => s.calendars);
  const nav = useStore((s) => s.nav);
  const selectedId = useStore((s) => s.selectedId);
  const flashId = useStore((s) => s.flashId);
  const goDay = useStore((s) => s.openDay);
  // a phone's month is too small to read a day in: a tap opens it in 3 Day (that day first); elsewhere, in Day
  const phone = useMediaQuery('(max-width: 699px)');
  const openDay = (date: number) => goDay(date, phone ? '3day' : 'day');
  const calById = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const showDeadlines = useStore((s) => s.showDeadlines);
  const now = useNow(60_000);
  const todayIdx = dayIndex(now);

  const [scrollTop, setScrollTop] = useState(0);
  const first = Math.floor(scrollTop / rowH);
  const rowFrom = Math.max(0, first - 2);
  const rowTo = Math.min(TOTAL_WEEKS, first + Math.ceil((height || 800) / rowH) + 3);
  const calEvents = useEventsIn(dayStart(rowFrom * 7), dayStart(rowTo * 7));
  const tasks = useStore((s) => s.tasks);
  const showTasks = useStore((s) => s.showTasks);
  const events = useMemo(() => [...calEvents, ...tasks.filter((t) => t.due !== undefined).map((t) => taskAsEvent(t))], [calEvents, tasks]);
  const focusRow = Math.floor((scrollTop + (height || 800) * 0.4) / rowH);
  const focusMonth = startOfMonth(dateAt(focusRow * 7 + 3)).getTime();

  // ---- navigation ------------------------------------------------------------------
  const anchorRow = useRef(0);
  const lastSeq = useRef(-1);
  const raf = useRef(0);
  const rowHRef = useRef(rowH);
  rowHRef.current = rowH;

  useLayoutEffect(() => {
    if (lastSeq.current === -1) return; // not scrolled into place yet
    useStore.getState().setVisibleRange({ start: focusMonth, end: addMonths(focusMonth, 1).getTime() });
  }, [focusMonth]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !height) return;
    if (lastSeq.current === nav.seq) {
      el.scrollTop = anchorRow.current * rowH;
      setScrollTop(el.scrollTop);
      return;
    }
    const initial = lastSeq.current === -1;
    lastSeq.current = nav.seq;
    const row = clamp(Math.floor(dayIndex(startOfMonth(nav.date)) / 7), 0, TOTAL_WEEKS - 1);
    if (!initial && nav.smooth && Math.abs(row - anchorRow.current) < 14) {
      el.scrollTo({ top: row * rowH, behavior: 'smooth' });
    } else {
      el.scrollTop = row * rowH;
      setScrollTop(el.scrollTop);
      anchorRow.current = row;
    }
  }, [nav.seq, rowH, height]);

  const onScroll = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = ref.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      anchorRow.current = Math.round(el.scrollTop / rowHRef.current);
    });
  };

  // ---- per-week layout: bars for multi-day/all-day, dot rows for timed ------------
  const rows = useMemo(() => {
    const vis = events.filter((e) => (e.kind === 'deadline' ? showDeadlines : e.kind === 'task' ? showTasks : calById.get(e.calendarId)?.visible));
    const out: { r: number; items: Item[]; more: number[] }[] = [];
    for (let r = rowFrom; r < rowTo; r++) {
      const d0 = r * 7;
      const ws = dayStart(d0);
      const we = dayStart(d0 + 7);
      const raw = vis
        .filter((e) => e.start < we && e.end > ws)
        .map((ev) => {
          const a = Math.max(0, dayIndex(ev.start) - d0);
          const b = Math.min(6, dayIndex(Math.max(ev.start, ev.end - 1)) - d0);
          return { ev, a, b, bar: ev.kind !== 'task' && (ev.allDay || b > a) };
        })
        .sort(
          (x, y) =>
            Number(y.bar) - Number(x.bar) ||
            x.a - y.a ||
            y.b - y.a - (x.b - x.a) ||
            x.ev.start - y.ev.start,
        );
      const laned = assignLanes(raw);

      // Hide what doesn't fit; a day with hidden items shows "+N more" in its last lane.
      const hidden = new Set(laned.filter((it) => it.lane >= maxLanes));
      for (let changed = true; changed; ) {
        changed = false;
        const needsMore = Array.from({ length: 7 }, (_, k) => [...hidden].some((it) => it.a <= k && k <= it.b));
        for (const it of laned) {
          if (hidden.has(it) || it.lane !== maxLanes - 1) continue;
          for (let k = it.a; k <= it.b; k++)
            if (needsMore[k]) { hidden.add(it); changed = true; break; }
        }
      }
      const more = Array.from({ length: 7 }, (_, k) => [...hidden].filter((it) => it.a <= k && k <= it.b).length);
      out.push({ r, items: laned.filter((it) => !hidden.has(it)), more });
    }
    return out;
  }, [events, calById, showDeadlines, showTasks, rowFrom, rowTo, maxLanes]);

  const newEventOn = (dayIdx: number) => {
    const st = useStore.getState();
    const start = atMinutes(dayIdx, 9 * 60);
    const cal = newEventCalendarId(st);
    st.startDraft({ calendarId: cal, title: '', start, end: start + prefs.defaultEventMin * MIN, allDay: false });
  };

  const weekdays = Array.from({ length: 7 }, (_, k) => format(dateAt(k), narrow ? 'EEEEE' : 'EEE'));

  return (
    <div className="mv">
      <div className="mv-weekdays">
        {weekdays.map((w, k) => (
          <div key={k} className={cls(isWeekend(k) && 'weekend')}>{w}</div>
        ))}
      </div>
      <div className="mv-scroller" ref={ref} onScroll={onScroll}>
        <div className="mv-canvas" style={{ height: TOTAL_WEEKS * rowH }}>
          {rows.map(({ r, items, more }) => (
            <div key={r} className="mv-row" style={{ top: r * rowH, height: rowH }}>
              {Array.from({ length: 7 }, (_, k) => {
                const i = r * 7 + k;
                const date = dateAt(i);
                const inFocus = startOfMonth(date).getTime() === focusMonth;
                return (
                  <div
                    key={k}
                    className={cls('mv-cell', !inFocus && 'dim', isWeekend(i) && 'weekend', i === todayIdx && 'today')}
                    style={{ left: k * colW, width: colW }}
                    onDoubleClick={(e) => e.target === e.currentTarget && newEventOn(i)}
                  >
                    <button className="mv-daynum" onClick={() => openDay(date.getTime())}>
                      <span className={cls('mv-mon', date.getDate() === 1 && 'first')}>{format(date, 'MMM')}</span> {date.getDate()}
                    </button>
                    {weekNums && k === 0 && <span className="mv-wk" title="Week number">W{weekNumber(date)}</span>}
                  </div>
                );
              })}
              {items.map(({ ev, a, b, bar, lane }) => {
                const isDl = ev.kind === 'deadline';
                const color = isDl ? URGENCY_COLOR[urgency(ev, now)] : calById.get(ev.calendarId)?.color;
                const d0 = r * 7;
                return (
                  <div
                    key={ev.id}
                    className={cls(
                      'mv-item',
                      isDl && 'deadline',
                      isDl && ev.done && 'done',
                      ev.kind === 'task' && 'task',
                      ev.kind === 'task' && ev.done && 'done',
                      bar ? 'bar' : 'dot',
                      ev.id === selectedId && 'selected',
                      ev.end <= now && 'past',
                      ev.id === flashId && 'flash',
                      bar && ev.start < dayStart(d0 + a) && 'cont-l',
                      bar && ev.end > dayStart(d0 + b + 1) && 'cont-r',
                      startOfMonth(dateAt(d0 + a)).getTime() !== focusMonth && 'dim',
                    )}
                    style={{
                      left: a * colW + 2,
                      width: (b - a + 1) * colW - 4,
                      top: headH + lane * laneH,
                      height: laneH - 2,
                      '--c': color,
                    } as CSSProperties}
                    onClick={() => useStore.getState().toggleSelect(ev.id)}
                    {...asButton(`${ev.title || 'New Event'}, ${format(ev.start, 'EEEE MMMM d')}${ev.allDay ? '' : `, ${fmtTimeShort(ev.start)}`}`, () => useStore.getState().toggleSelect(ev.id))}
                    onDoubleClick={(e) => {
                      if (ev.kind !== 'task') return;
                      e.stopPropagation();
                      useStore.getState().setTaskDone(ev.id, !ev.done);
                    }}
                  >
                    {isDl ? <span className="mv-flag">⚑</span> : ev.kind === 'task' ? <i className="mv-box" /> : !bar && <i className="mv-dot" />}
                    <span className="mv-title">{ev.title || 'New Event'}</span>
                    {!bar && !narrow && ev.kind !== 'task' && <span className="mv-time">{fmtTimeShort(ev.start)}</span>}
                  </div>
                );
              })}
              {more.map((n, k) =>
                n > 0 ? (
                  <button
                    key={'m' + k}
                    className="mv-more"
                    style={{ left: k * colW + 2, width: colW - 4, top: headH + (maxLanes - 1) * laneH, height: laneH - 2 }}
                    onClick={() => openDay(addDays(dateAt(r * 7), k).getTime())}
                  >
                    +{n} more
                  </button>
                ) : null,
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
