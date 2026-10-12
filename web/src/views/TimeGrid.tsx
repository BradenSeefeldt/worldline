// Day / 3-day / week view: one scroll box over a very wide canvas (2020–2035).
// Only the columns near the viewport are actually drawn ("virtualized"), so scrolling
// sideways through days is continuous and cheap. Header and hour gutter are CSS-sticky.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { format, startOfWeek } from 'date-fns';
import { DRAFT_ID, HOUR_H_RANGE, isLocked, newEventCalendarId, useStore } from '../data/store';
import { useEventsIn } from '../data/useEvents';
import type { CalEvent } from '../data/types';
import * as D from '../lib/dates';
import { MIN, clamp, minutesOfDay } from '../lib/dates';
import { allDays, weekdaysOnly, type Slots } from '../lib/slots';
import { assignLanes, layoutDay } from '../lib/layout';
import { useElementSize, useNow } from '../lib/hooks';
import { cls, fmtHour, fmtTime, fmtTimeRange } from '../lib/format';
import { asButton } from '../lib/a11y';
import { wallClock, zoneAbbr, zoneCity } from '../lib/zone';
import { URGENCY_COLOR, countdown, runwayStart, urgency } from '../lib/deadlines';
import { taskAsEvent } from '../lib/tasks';
import { registerDropTarget } from '../components/BlockDrag';
import { prefs } from '../lib/prefs';

const DAY_HEAD_H = 50;
const RIB_H = 22; // one deadline ribbon
const MAX_RIBBONS = 4;
const LANE_H = 22; // all-day bar height
const MAX_ALLDAY_LANES = 4;
const SNAP = 15; // minutes
const LONG_PRESS_MS = 420;

type Preview = { id: string; start: number; end: number } | null;
interface Seg { ev: CalEvent; start: number; end: number; contBefore: boolean; contAfter: boolean }
interface Drag {
  kind: 'move' | 'resize' | 'create';
  id?: string;
  pointerId: number;
  touch: boolean;
  x0: number;
  y0: number;
  day0: number;
  min0: number;
  origStart: number;
  origEnd: number;
  active: boolean;
  timer?: number;
  locked?: boolean; // a subscribed calendar's event: click to open, never drag
}

const snap = (m: number) => Math.round(m / SNAP) * SNAP;

// Columns ↔ days (lib/slots.ts). Every position here is a column index; with weekends hidden (Settings → Calendar)
// only Monday–Friday have columns. These helpers convert, so the rest of the grid never needs to know.
let S: Slots = allDays(D.TOTAL_DAYS);
const dateAt = (i: number) => D.dateAt(S.toDay(i));
const dayStart = (i: number) => D.dayStart(S.toDay(i));
const dayEnd = (i: number) => D.dayStart(S.toDay(i) + 1); // the midnight after column i's day
const atMinutes = (i: number, m: number) => D.atMinutes(S.toDay(i), m);
const isWeekend = (i: number) => D.isWeekend(S.toDay(i));
const dayIndex = (t: Date | number) => S.toSlot(D.dayIndex(t), 'ceil'); // the column of t's day, or the next one
const lastIndex = (t: Date | number) => S.toSlot(D.dayIndex(t), 'floor'); // …or the one before (for ends)
const exactIndex = (t: Date | number) => S.toSlot(D.dayIndex(t), 'exact'); // -1 for a hidden day

export function TimeGrid({ days }: { days: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(scrollerRef);
  // Away from home: a second, narrower hour column in home time (left of the local one).
  const zone = useStore((s) => s.zone);
  const homeZone = useStore((s) => s.homeZone);
  const showHome = useStore((s) => s.showHomeHours) && zone !== homeZone;
  const HOME_W = 40;
  const gutterW = (width && width < 600 ? 46 : 58) + (showHome ? HOME_W : 0);
  const colW = width ? (width - gutterW) / days : 0;
  const hideWeekends = useStore((s) => s.settings.hideWeekends) && days > 1;
  S = hideWeekends ? weekdaysOnly(D.TOTAL_DAYS, D.weekStart()) : allDays(D.TOTAL_DAYS);
  const TOTAL_DAYS = S.total; // columns
  const dayStartHour = useStore((s) => s.settings.dayStartHour);

  const calendars = useStore((s) => s.calendars);
  const nav = useStore((s) => s.nav);
  const selectedId = useStore((s) => s.selectedId);
  const openDay = useStore((s) => s.openDay);
  const hourH = useStore((s) => s.hourH); // px per hour (pinch / ⌘-scroll to zoom)
  const flashId = useStore((s) => s.flashId);
  const calById = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars]);
  const showDeadlines = useStore((s) => s.showDeadlines);
  // Deadlines don't belong to a calendar; they have their own show/hide.
  const showTasks = useStore((s) => s.showTasks);
  const tasks = useStore((s) => s.tasks);
  const isShown = (e: CalEvent) =>
    e.kind === 'deadline' ? showDeadlines : e.kind === 'task' ? showTasks : !!calById.get(e.calendarId)?.visible;
  // Checklist progress per deadline ("2/4"), for the runway label.
  const progress = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const t of tasks) {
      if (!t.parentId) continue;
      const p = m.get(t.parentId) ?? { done: 0, total: 0 };
      p.total++;
      if (t.done) p.done++;
      m.set(t.parentId, p);
    }
    return m;
  }, [tasks]);
  const defaultCal = useStore(newEventCalendarId);

  const [scrollLeft, setScrollLeft] = useState(0);
  const [preview, setPreviewState] = useState<Preview>(null);
  const previewRef = useRef<Preview>(null);
  const setPreview = (p: Preview) => {
    previewRef.current = p;
    setPreviewState(p);
  };
  const now = useNow();
  const todayIdx = exactIndex(now);

  // ---- which day columns to draw --------------------------------------------------
  const first = colW ? clamp(Math.floor(scrollLeft / colW + 0.01), 0, TOTAL_DAYS - days) : 0;
  const from = Math.max(0, first - days);
  const to = Math.min(TOTAL_DAYS, first + 2 * days + 1);
  const rangeStart = dayStart(from);
  const rangeEnd = dayStart(to);
  const calEvents = useEventsIn(rangeStart, rangeEnd); // includes occurrences of recurring events
  // Dated tasks are drawn too: light ☐ items in the all-day row.
  const events = useMemo(
    () => [...calEvents, ...tasks.filter((t) => t.due !== undefined).map((t) => taskAsEvent(t))],
    [calEvents, tasks],
  );

  const shown = useMemo(() => {
    let list = events;
    if (preview?.id === DRAFT_ID)
      list = [...events, { id: DRAFT_ID, calendarId: defaultCal, title: '', start: preview.start, end: preview.end, allDay: false }];
    else if (preview) list = events.map((e) => (e.id === preview.id ? { ...e, start: preview.start, end: preview.end } : e));
    return list.filter((e) => isShown(e) && e.start < rangeEnd && e.end > rangeStart);
  }, [events, preview, calById, showDeadlines, showTasks, defaultCal, rangeStart, rangeEnd]);

  // Timed events cut into per-day pieces, then laid out side by side within each day.
  const timedByDay = useMemo(() => {
    const buckets = new Map<number, Seg[]>();
    for (const ev of shown) {
      if (ev.allDay || ev.kind === 'deadline') continue; // deadlines get flags, not boxes
      const a = Math.max(from, dayIndex(ev.start));
      const b = Math.min(to - 1, lastIndex(Math.max(ev.start, ev.end - 1)));
      for (let i = a; i <= b; i++) {
        const ds = dayStart(i);
        const de = dayEnd(i);
        if (ev.end <= ds || ev.start >= de) continue; // (a day with no column in between)
        const seg: Seg = {
          ev,
          start: ev.start <= ds ? 0 : minutesOfDay(ev.start),
          end: ev.end >= de ? 1440 : minutesOfDay(ev.end),
          contBefore: ev.start < ds,
          contAfter: ev.end > de,
        };
        if (!buckets.has(i)) buckets.set(i, []);
        buckets.get(i)!.push(seg);
      }
    }
    return new Map([...buckets].map(([i, segs]) => [i, layoutDay(segs)]));
  }, [shown, from, to]);

  const allDayBars = useMemo(() => {
    const items = shown
      .filter((e) => e.allDay && e.kind !== 'deadline')
      // events first (they occupy the day), then tasks; within each, by date and length
      .sort((x, y) => Number(x.kind === 'task') - Number(y.kind === 'task') || x.start - y.start || y.end - y.start - (x.end - x.start))
      .map((e) => ({ ev: e, a: Math.max(from, dayIndex(e.start)), b: Math.min(to - 1, lastIndex(e.end - 1)) }))
      .filter((x) => x.a <= x.b); // only on hidden days
    return assignLanes(items);
  }, [shown, from, to]);
  const lanesInView = allDayBars.reduce(
    (m, bar) => (bar.a < first + days && bar.b >= first ? Math.max(m, bar.lane + 1) : m), 0);
  const allDayH = Math.max(1, Math.min(lanesInView, MAX_ALLDAY_LANES)) * LANE_H + 8;

  // ---- deadline ribbons: each open deadline's runway (default 2 weeks), drawn ahead of time ----
  const ahead = useEventsIn(rangeStart, rangeEnd + 120 * 86_400_000);
  const ribbons = useMemo(() => {
    const items = ahead
      .filter((e) => e.kind === 'deadline' && !e.done && showDeadlines)
      .map((e) => ({ ev: e, run: dayIndex(runwayStart(e)), due: lastIndex(e.start) }))
      .filter((x) => x.run <= x.due)
      .filter((x) => x.run < to && x.due >= from)
      .sort((x, y) => x.ev.start - y.ev.start)
      .map((x) => ({ ...x, a: Math.max(from, x.run), b: Math.min(to - 1, x.due) }));
    return assignLanes(items);
  }, [ahead, showDeadlines, from, to]);
  const ribbonLanes = ribbons.reduce((m, r) => (r.a < first + days && r.b >= first ? Math.max(m, r.lane + 1) : m), 0);
  const ribbonH = ribbonLanes ? Math.min(ribbonLanes, MAX_RIBBONS) * RIB_H + 4 : 0;
  const AD_TOP = DAY_HEAD_H + ribbonH; // the all-day row sits under the ribbons

  // ---- scrolling & navigation -------------------------------------------------------
  const headH = DAY_HEAD_H + ribbonH + allDayH;
  const geom = useRef({ colW, gutterW, days, hourH, headH });
  geom.current = { colW, gutterW, days, hourH, headH };
  const anchorIdx = useRef(0);
  const lastSeq = useRef(-1);
  const raf = useRef(0);

  const report = (el: HTMLDivElement) => {
    const { colW, days } = geom.current;
    if (!colW) return;
    const i = Math.round(el.scrollLeft / colW);
    anchorIdx.current = i;
    useStore.getState().setVisibleRange({ start: dayStart(i), end: dayEnd(i + days - 1) });
  };

  const onScroll = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = scrollerRef.current;
      if (!el) return;
      setScrollLeft(el.scrollLeft);
      report(el);
    });
  };

  // Jump instantly, with snapping briefly off so the browser doesn't snap to a stale column.
  const jumpTo = (el: HTMLDivElement, left: number) => {
    el.style.scrollSnapType = 'none';
    el.scrollLeft = left;
    setScrollLeft(left);
    report(el);
    requestAnimationFrame(() => requestAnimationFrame(() => (el.style.scrollSnapType = '')));
  };

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !colW) return;
    if (lastSeq.current === nav.seq) {
      // Width changed (window resize, sidebar toggle): keep the same first day in view.
      jumpTo(el, anchorIdx.current * colW);
      return;
    }
    const initial = lastSeq.current === -1;
    lastSeq.current = nav.seq;
    const idx = days >= 5 ? dayIndex(startOfWeek(nav.date, { weekStartsOn: D.weekStart() })) : dayIndex(nav.date); // a week view starts on the week's first day
    const left = clamp(idx, 0, TOTAL_DAYS - days) * colW;
    if (initial) {
      jumpTo(el, left);
      const today = exactIndex(Date.now());
      const showsToday = today >= idx && today < idx + days;
      el.scrollTop = (showsToday ? Math.max(0, minutesOfDay(Date.now()) / 60 - 2) : dayStartHour) * hourH;
    } else if (nav.smooth && Math.abs(idx - anchorIdx.current) <= 45) {
      el.scrollTo({ left, behavior: 'smooth' });
    } else jumpTo(el, left);
  }, [nav.seq, colW]);

  // ---- pointer interactions: click, drag-create, move, resize -----------------------
  const dragRef = useRef<Drag | null>(null);

  const slotAt = (x: number, y: number) => {
    const r = bodyRef.current!.getBoundingClientRect();
    const { colW, gutterW, hourH } = geom.current;
    return {
      day: Math.floor((x - r.left - gutterW) / colW),
      min: clamp(((y - r.top) / hourH) * 60, 0, 1440),
    };
  };

  const computePreview = (d: Drag, x: number, y: number): Preview => {
    const { day, min } = slotAt(x, y);
    if (d.kind === 'move') {
      // real days between the columns (with weekends hidden, Friday → Monday is 3), and the time on the wall clock
      const start = D.shiftWall(d.origStart, S.toDay(day) - S.toDay(d.day0), snap(min - d.min0));
      return { id: d.id!, start, end: start + (d.origEnd - d.origStart) };
    }
    if (d.kind === 'resize') {
      const end = Math.max(atMinutes(day, snap(min)), d.origStart + SNAP * MIN);
      return { id: d.id!, start: d.origStart, end };
    }
    const a = atMinutes(d.day0, Math.floor(d.min0 / SNAP) * SNAP);
    const b = atMinutes(d.day0, snap(min));
    return b >= a
      ? { id: DRAFT_ID, start: a, end: Math.max(b, a + SNAP * MIN) }
      : { id: DRAFT_ID, start: b, end: a + SNAP * MIN };
  };

  // While dragging near the top/bottom edge, scroll the grid and keep the event under the pointer.
  const lastPtr = useRef({ x: 0, y: 0 });
  const autoScroll = (d: Drag) => {
    const tick = () => {
      const el = scrollerRef.current;
      if (dragRef.current !== d || !el) return;
      const r = el.getBoundingClientRect();
      const top = r.top + geom.current.headH;
      const edge = 44;
      const { x, y } = lastPtr.current;
      const v = y < top + edge ? -(top + edge - y) / 3 : y > r.bottom - edge ? (y - r.bottom + edge) / 3 : 0;
      if (v) {
        el.scrollTop += clamp(v, -24, 24);
        setPreview(computePreview(d, x, y));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const activate = (d: Drag) => {
    d.active = true;
    lastPtr.current = { x: d.x0, y: d.y0 };
    autoScroll(d);
    if (d.kind === 'create' && d.touch) {
      const start = atMinutes(d.day0, Math.floor(d.min0 / 30) * 30);
      setPreview({ id: DRAFT_ID, start, end: start + 60 * MIN });
    } else if (d.kind !== 'create') setPreview({ id: d.id!, start: d.origStart, end: d.origEnd });
    navigator.vibrate?.(8);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !colW) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tg-gutter')) return;
    const slot = slotAt(e.clientX, e.clientY);
    const evEl = target.closest<HTMLElement>('[data-ev]');
    const ev = evEl ? events.find((x) => x.id === evEl.dataset.ev) : undefined;
    const d: Drag = {
      kind: ev ? (target.closest('[data-resize]') ? 'resize' : 'move') : 'create',
      id: ev?.id,
      pointerId: e.pointerId,
      touch: e.pointerType === 'touch',
      x0: e.clientX,
      y0: e.clientY,
      day0: slot.day,
      min0: slot.min,
      origStart: ev?.start ?? 0,
      origEnd: ev?.end ?? 0,
      active: false,
      locked: !!ev && isLocked(useStore.getState(), ev.id),
    };
    if (d.touch) d.timer = window.setTimeout(() => activate(d), LONG_PRESS_MS);
    dragRef.current = d;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (d.locked) return;
      if (!d.active) {
        const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
        if (d.touch) {
          if (dist > 8) { clearTimeout(d.timer); dragRef.current = null; } // it's a scroll
          return;
        }
        if (dist < 4) return;
        activate(d);
      }
      lastPtr.current = { x: e.clientX, y: e.clientY };
      setPreview(computePreview(d, e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      clearTimeout(d.timer);
      dragRef.current = null;
      const st = useStore.getState();
      const p = previewRef.current;
      setPreview(null);
      if (!d.active) return d.id ? st.toggleSelect(d.id) : st.select(null); // click again to close
      if (!p) return;
      if (d.kind === 'create') {
        const cal = newEventCalendarId(st);
        st.startDraft({ calendarId: cal, title: '', start: p.start, end: p.end, allDay: false });
      } else {
        // Dragging one occurrence of a series changes just that one (it becomes an exception).
        st.select(st.updateEvent(d.id!, { start: p.start, end: p.end }));
      }
    };
    const onCancel = () => {
      if (dragRef.current) clearTimeout(dragRef.current.timer);
      dragRef.current = null;
      setPreview(null);
    };
    // While a touch drag is active, stop the page from scrolling under the finger.
    const onTouchMove = (e: TouchEvent) => {
      if (dragRef.current?.active) e.preventDefault();
    };
    const sc = scrollerRef.current!;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    sc.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      sc.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // ---- zoom: trackpad pinch (ctrl+wheel in Chrome, gesture events in Safari), ⌘+scroll ----
  // The time under the pointer stays fixed while the hour height changes.
  const zoomAnchor = useRef<{ minute: number; y: number } | null>(null);
  const liveHourH = useRef(hourH);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const a = zoomAnchor.current;
    if (!el || !a) return;
    const r = el.getBoundingClientRect();
    el.scrollTop = headH + (a.minute / 60) * hourH - (a.y - r.top);
    zoomAnchor.current = null;
  }, [hourH]);

  useEffect(() => {
    const el = scrollerRef.current!;
    let gestureBase = liveHourH.current;
    const zoomTo = (clientY: number, h: number) => {
      const { hourH, headH } = geom.current; // what is on screen right now
      const r = el.getBoundingClientRect();
      const minute = clamp(((clientY - r.top - headH + el.scrollTop) / hourH) * 60, 0, 1440);
      zoomAnchor.current = { minute, y: clientY };
      liveHourH.current = clamp(h, HOUR_H_RANGE[0], HOUR_H_RANGE[1]);
      useStore.getState().setHourH(liveHourH.current);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(e.clientY, liveHourH.current * Math.exp(-e.deltaY * 0.01));
    };
    type Gesture = Event & { scale: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureBase = liveHourH.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      zoomTo((e as Gesture).clientY, gestureBase * (e as Gesture).scale);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, []);

  // ---- drop target: tasks / deadlines dragged from the sidebar become a 1-hour block ----------
  const blockDrag = useStore((s) => s.blockDrag);
  /** Where a 1-hour block would go for a pointer at (x, y), or null if not over the hours. */
  const slotForPoint = (x: number, y: number) => {
    const el = scrollerRef.current;
    if (!el || !bodyRef.current) return null;
    const r = el.getBoundingClientRect();
    const { headH, gutterW } = geom.current;
    if (x < r.left + gutterW || x > r.right || y < r.top + headH || y > r.bottom) return null;
    const { day, min } = slotAt(x, y);
    return { day, start: clamp(Math.round((min - 15) / SNAP) * SNAP, 0, 23 * 60) }; // pointer near the block's top
  };
  useEffect(
    () =>
      registerDropTarget({
        hover: (x, y) => !!slotForPoint(x, y),
        drop: (x, y, item) => {
          const slot = slotForPoint(x, y);
          if (!slot) return false;
          const start = atMinutes(slot.day, slot.start);
          const st = useStore.getState();
          const id = st.blockOut(item, start);
          st.flash(id);
          if (item.kind === 'task') window.setTimeout(() => useStore.getState().flash(item.id), 1700); // then the task's new 🕑 chip
          st.showToast(`Blocked ${format(start, 'EEE')} ${fmtTimeRange(start, start + 60 * MIN)} for “${item.title}”`, true, id);
          return true;
        },
      }),
    [],
  );
  // While dragging near the top or bottom of the grid, scroll it.
  const dragging = blockDrag?.phase === 'drag';
  useEffect(() => {
    if (!dragging) return;
    let raf = 0;
    const tick = () => {
      const el = scrollerRef.current;
      const d = useStore.getState().blockDrag;
      if (!el || !d || d.phase !== 'drag') return;
      const r = el.getBoundingClientRect();
      const top = r.top + geom.current.headH;
      if (d.x > r.left && d.x < r.right && d.y > r.top - 20 && d.y < r.bottom + 20) {
        const v = d.y < top + 40 ? -(top + 40 - d.y) / 3 : d.y > r.bottom - 40 ? (d.y - r.bottom + 40) / 3 : 0;
        if (v) {
          el.scrollTop += clamp(v, -22, 22);
          useStore.getState().setBlockDrag({ ...d }); // redraw the preview at the new scroll position
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragging]);
  const dropSlot = blockDrag?.phase === 'drag' && blockDrag.over ? slotForPoint(blockDrag.x, blockDrag.y) : null;

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-ev], .tg-gutter')) return;
    const { day, min } = slotAt(e.clientX, e.clientY);
    const start = atMinutes(day, Math.floor(min / 30) * 30);
    const st = useStore.getState();
    st.startDraft({ calendarId: defaultCal, title: '', start, end: start + prefs.defaultEventMin * MIN, allDay: false });
  };

  // ---- render --------------------------------------------------------------------
  const cols: number[] = [];
  for (let i = from; i < to; i++) cols.push(i);
  const snapFrom = Math.max(0, first - 60);
  const snapTo = Math.min(TOTAL_DAYS, first + days + 60);
  const colLeft = (i: number) => gutterW + i * colW;
  const nowMin = minutesOfDay(now);

  return (
    <div
      className="tg-scroller"
      ref={scrollerRef}
      onScroll={onScroll}
      style={{ scrollPaddingLeft: gutterW, '--hour': `${hourH}px` } as CSSProperties}
    >
      <div className="tg-canvas" style={{ width: colW ? gutterW + TOTAL_DAYS * colW : '100%' }}>
        <div className="tg-header" style={{ height: headH }}>
          <div className="tg-corner" style={{ width: gutterW, height: headH }}>
            <span className="tg-zones" style={{ top: DAY_HEAD_H - 17 }} title={`Times shown in ${zone}`}>
              {showHome && (
                <span className="home" style={{ width: HOME_W }} title={`Home: ${homeZone}`}>
                  {zoneAbbr(homeZone)}
                </span>
              )}
              <span>{zoneAbbr(zone)}</span>
            </span>
            {ribbonH > 0 && <span className="tg-allday-label" style={{ top: DAY_HEAD_H + 5 }}>due</span>}
            <span className="tg-allday-label" style={{ top: AD_TOP + 4 }}>all-day</span>
          </div>
          {cols.map((i) => {
            const d = dateAt(i);
            return (
              <button
                key={i}
                className={cls('tg-dayhead', i === todayIdx && 'today', isWeekend(i) && 'weekend')}
                style={{ left: colLeft(i), width: colW, height: DAY_HEAD_H }}
                onClick={() => days > 1 && openDay(d.getTime())}
              >
                <span className="dow">{format(d, days === 1 ? 'EEEE' : 'EEE')}</span>
                <span className="dnum">{d.getDate() === 1 && days > 1 ? format(d, 'MMM d') : d.getDate()}</span>
              </button>
            );
          })}
          {cols.map((i) => (
            <div key={'ad' + i} className="tg-allday-cell" style={{ left: colLeft(i), width: colW, top: DAY_HEAD_H, height: ribbonH + allDayH }} />
          ))}
          {ribbons.map(({ ev, run, due, a, b, lane }) => {
            if (lane >= MAX_RIBBONS) return null;
            const color = URGENCY_COLOR[urgency(ev, now)];
            const fullW = (due - run + 1) * colW; // the whole runway, so the colour ramp lines up when clipped
            return (
              <div
                key={'rb' + ev.id}
                className={cls('rb', ev.id === selectedId && 'selected', urgency(ev, now))}
                style={{
                  left: colLeft(a) + 2,
                  width: (b - a + 1) * colW - 4,
                  top: DAY_HEAD_H + 3 + lane * RIB_H,
                  height: RIB_H - 4,
                  '--c': color,
                  backgroundSize: `${fullW}px 3px, ${fullW}px 100%`,
                  backgroundPosition: `${-(a - run) * colW}px 100%, ${-(a - run) * colW}px 0`,
                } as CSSProperties}
                onClick={() => useStore.getState().toggleSelect(ev.id)}
                title={`${ev.title} · due ${format(ev.start, 'EEE MMM d, h:mm a')}`}
              >
                <span className="rb-label" style={{ left: gutterW + 6 }}>
                  ⚑ {ev.title}{' '}
                  {progress.get(ev.id) && <span className="rb-steps">{progress.get(ev.id)!.done}/{progress.get(ev.id)!.total}</span>}
                  <span className="rb-count">· {countdown(ev, now)}{due >= first + days ? ` · ${format(ev.start, 'EEE MMM d')}` : ''}</span>
                </span>
                {due < to ? (
                  <span className="rb-flag">⚑ {fmtTime(ev.start)}</span>
                ) : (
                  <span className="rb-end">→ {format(ev.start, 'MMM d')}</span>
                )}
              </div>
            );
          })}
          {allDayBars.map(({ ev, a, b, lane }) =>
            lane < MAX_ALLDAY_LANES && ev.kind === 'task' ? (
              <div
                key={'tk' + ev.id}
                className={cls('ad-task', ev.done && 'done', ev.id === selectedId && 'selected')}
                style={{ left: colLeft(a) + 2, width: colW - 4, top: AD_TOP + 4 + lane * LANE_H, height: LANE_H - 3 }}
                onClick={() => useStore.getState().toggleSelect(ev.id)}
                title={ev.title}
              >
                <button
                  className="ad-task-check"
                  aria-label={ev.done ? `Mark “${ev.title}” not done` : `Mark “${ev.title}” done`}
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().setTaskDone(ev.id, !ev.done);
                  }}
                />
                <span className="ad-title">{ev.title}</span>
              </div>
            ) : lane < MAX_ALLDAY_LANES ? (
              <div
                key={ev.id}
                className={cls('ad-bar', ev.id === selectedId && 'selected', ev.end <= now && 'past', ev.id === flashId && 'flash', ev.start < dayStart(a) && 'cont-l', ev.end > dayEnd(b) && 'cont-r')}
                {...asButton(`${ev.title}, all day, ${format(ev.start, 'EEEE MMMM d')}`, () => useStore.getState().toggleSelect(ev.id))}
                style={{
                  left: colLeft(a) + 2,
                  width: (b - a + 1) * colW - 4,
                  top: AD_TOP + 4 + lane * LANE_H,
                  height: LANE_H - 3,
                  '--c': calById.get(ev.calendarId)?.color,
                } as CSSProperties}
                onClick={() => useStore.getState().toggleSelect(ev.id)}
              >
                {ev.start < dayStart(a) && <span className="ad-arrow">‹</span>}
                <span className="ad-title">{ev.title || 'New Event'}</span>
                {Math.round((ev.end - ev.start) / 86_400_000) > 1 && (
                  <span className="ad-len">{Math.round((ev.end - ev.start) / 86_400_000)} days</span>
                )}
                {ev.end > dayEnd(b) && <span className="ad-arrow">›</span>}
              </div>
            ) : null,
          )}
        </div>

        <div
          className="tg-body"
          ref={bodyRef}
          style={{ height: 24 * hourH }}
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
          onContextMenu={(e) => dragRef.current && e.preventDefault()}
        >
          <div className="tg-gutter" style={{ width: gutterW }}>
            {showHome && (
              <div className="tg-gutter-home" style={{ width: HOME_W }} title={`${zoneCity(homeZone)} time`}>
                {Array.from({ length: 23 }, (_, k) => k + 1).map((h) => {
                  const w = wallClock(atMinutes(first, h * 60), homeZone);
                  const h12 = w.h % 12 || 12;
                  return (
                    <span key={h} className="tg-hour home" style={{ top: h * hourH }}>
                      {h12}
                      {w.min ? `:${String(w.min).padStart(2, '0')}` : ''}
                      {w.h < 12 ? 'a' : 'p'}
                    </span>
                  );
                })}
              </div>
            )}
            {Array.from({ length: 23 }, (_, k) => k + 1).map((h) =>
              todayIdx >= first && todayIdx < first + days && Math.abs(nowMin - h * 60) < 15 ? null : (
                <span key={h} className="tg-hour" style={{ top: h * hourH }}>{fmtHour(h)}</span>
              ),
            )}
            {todayIdx >= first && todayIdx < first + days && (
              <span className="tg-now-label" style={{ top: (nowMin / 60) * hourH }}>{fmtTime(now).replace(/ [AP]M$/, '')}</span>
            )}
          </div>

          {Array.from({ length: snapTo - snapFrom }, (_, k) => (
            <div key={'s' + (snapFrom + k)} className="tg-snap" style={{ left: colLeft(snapFrom + k) }} />
          ))}

          {cols.map((i) => (
            <div key={i} className={cls('tg-col', isWeekend(i) && 'weekend', i === todayIdx && 'today')} style={{ left: colLeft(i), width: colW }}>
              {(timedByDay.get(i) ?? []).map(({ item: seg, col, cols: n, span }) => {
                const ev = seg.ev;
                const top = (seg.start / 60) * hourH;
                const h = (Math.max(seg.end - seg.start, 15) / 60) * hourH;
                const short = h < 38;
                return (
                  <div
                    key={ev.id}
                    data-ev={ev.id}
                    {...asButton(`${ev.title || 'New Event'}, ${format(ev.start, 'EEEE MMMM d')}, ${fmtTimeRange(ev.start, ev.end)}`, () => useStore.getState().toggleSelect(ev.id))}
                    className={cls(
                      'ev',
                      short && 'short',
                      ev.id === selectedId && 'selected',
                      ev.end <= now && 'past',
                      ev.id === flashId && 'flash',
                      (ev.id === preview?.id || ev.id === DRAFT_ID) && 'dragging',
                      seg.contBefore && 'cont-t',
                      seg.contAfter && 'cont-b',
                    )}
                    style={{
                      top: top + 1,
                      height: h - 2,
                      left: `calc(${(col / n) * 100}% + 1px)`,
                      width: `calc(${(span / n) * 100}% - 3px)`,
                      '--c': calById.get(ev.calendarId)?.color,
                    } as CSSProperties}
                  >
                    <div className="ev-title">
                      {ev.title || 'New Event'}
                      {ev.seriesId && <span className="ev-repeat" title="Repeats">↻</span>}
                      {short && <span className="ev-time-inline">{fmtTime(ev.start)}</span>}
                    </div>
                    {!short && <div className="ev-time">{fmtTimeRange(ev.start, ev.end)}</div>}
                    {h >= 60 && ev.location && <div className="ev-loc">{ev.location}</div>}
                    {!seg.contAfter && <div className="ev-resize" data-resize />}
                  </div>
                );
              })}
              {shown
                .filter((e) => e.kind === 'deadline' && exactIndex(e.start) === i)
                .map((e) => (
                  <div
                    key={'dl' + e.id}
                    data-ev={e.id}
                    className={cls('dl-flag', e.done && 'done', urgency(e, now), e.id === selectedId && 'selected', (e.id === preview?.id) && 'dragging')}
                    style={{ top: (minutesOfDay(e.start) / 60) * hourH, '--c': URGENCY_COLOR[urgency(e, now)] } as CSSProperties}
                    title={`${e.title} · due ${fmtTime(e.start)}`}
                  >
                    <span className="dl-flag-label">⚑ {e.title}{e.done ? ' ✓' : ''}</span>
                  </div>
                ))}
              {dropSlot?.day === i && blockDrag && (() => {
                const s0 = atMinutes(i, dropSlot.start);
                return (
                  <div
                    className="ev block-preview"
                    style={{ top: (dropSlot.start / 60) * hourH + 1, height: hourH - 2, left: 1, width: 'calc(100% - 3px)', '--c': calById.get(defaultCal)?.color } as CSSProperties}
                  >
                    <div className="ev-title">{blockDrag.kind === 'deadline' ? `Work on ${blockDrag.title}` : blockDrag.title}</div>
                    <div className="ev-time">{fmtTimeRange(s0, s0 + 60 * MIN)}</div>
                  </div>
                );
              })()}
              {i === todayIdx && <div className="now-line" style={{ top: (nowMin / 60) * hourH }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
