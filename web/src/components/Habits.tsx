// Habits: a sidebar card (tap a ring to tick today), a page of cards, and a page per habit for the long
// view (strength over its whole life, totals by week / month / year, every calendar year, weekday pattern).
// The maths lives in lib/habits.ts. Colour carries identity; no emoji.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { format } from 'date-fns';
import { CALENDAR_COLORS, useStore } from '../data/store';
import { expand } from '../lib/recurrence';
import type { CalEvent } from '../data/types';
import {
  HABIT_TEMPLATES, SKIP, amountOn, bestStreak, calendarCredit, canMatch, firstDay, habitsCsv, dateOfDay, dayOf, dayValue, describeAmount, describeGoal, isSkipped,
  periodProgress, strength, strengthSeries, streak, sumBetween, totals, weekStart, weekdayRates, yearGrid, yearWeeks,
  type Bucket, type Credit, type Habit, type HabitLog,
} from '../lib/habits';
import { epochDay } from '../lib/zone';
import { useNow } from '../lib/hooks';
import { cls } from '../lib/format';
import { Close, Trash } from './Icons';
import { saveFile } from '../lib/platform';

/** Save every habit's record as a CSV file (Settings → Data, and the Habits page). */
export function downloadHabitsCsv() {
  const { habits, habitLog, habitNotes, events } = useStore.getState();
  const now = Date.now();
  const today = dayOf(now);
  const since = Math.min(today - 371, ...habits.map((h) => dayOf(h.createdAt)));
  const past = expand(events, dateOfDay(since).getTime(), dateOfDay(today + 1).getTime());
  const csv = habitsCsv(habits, habitLog, habitNotes, (h) => calendarCredit(h, past, now));
  return saveFile(`habits-${format(now, 'yyyy-MM-dd')}.csv`, csv, 'text/csv'); // the Save panel in the Mac app
}

/** Your calendar since `since` (repeating events unrolled) — only events a habit could count: their title has one of
 *  the habits' calendar words. (Unrolling years of every event on each keystroke took over a second.) The sidebar's
 *  two habit pieces ask for the same thing: the last answer is kept and shared. */
let lastPast: { events: CalEvent[]; words: string; since: number; today: number; relevant: CalEvent[]; out: CalEvent[] } | null = null;
function habitEvents(events: CalEvent[], words: string, since: number, today: number): CalEvent[] {
  const c = lastPast;
  const same = !!c && c.words === words && c.since === since && c.today === today;
  if (same && c.events === events) return c.out;
  const ws = words ? words.split('\u0001') : [];
  const relevant = ws.length ? events.filter((e) => { const t = (e.title ?? '').toLowerCase(); return ws.some((w) => t.includes(w)); }) : [];
  // an edit to an event no habit counts (most edits): the same answer as before, so nothing downstream recomputes
  if (same && relevant.length === c.relevant.length && relevant.every((e, i) => e === c.relevant[i])) {
    c.events = events;
    return c.out;
  }
  const out = relevant.length ? expand(relevant, dateOfDay(since).getTime(), dateOfDay(today + 1).getTime()) : [];
  lastPast = { events, words, since, today, relevant, out };
  return out;
}

/** The habits' stats: the sidebar's badge and card both show them — worked out once for both. */
let lastStats: { habits: Habit[]; log: HabitLog; past: CalEvent[]; now: number; today: number; stats: HabitStatRow[] } | null = null;
type HabitStatRow = { h: Habit; auto: ReturnType<typeof calendarCredit>; progress: ReturnType<typeof periodProgress>; met: boolean; rest: boolean; strength: number; streak: number };
function habitStats(habits: Habit[], log: HabitLog, past: CalEvent[], now: number, today: number): HabitStatRow[] {
  const c = lastStats;
  if (c && c.habits === habits && c.log === log && c.past === past && c.now === now && c.today === today) return c.stats;
  const stats = habits.map((h) => {
    const auto = calendarCredit(h, past, now);
    const p = periodProgress(h, log, auto, today);
    return { h, auto, progress: p, met: p.done >= p.goal, rest: isSkipped(h, log, today), strength: strength(h, log, auto, today), streak: streak(h, log, auto, today) };
  });
  lastStats = { habits, log, past, now, today, stats };
  return stats;
}

/** Everything the screens show for each habit, worked out once. */
export function useHabitStats() {
  const habits = useStore((s) => s.habits);
  const log = useStore((s) => s.habitLog);
  const events = useStore((s) => s.events);
  const now = useNow(60_000);
  const today = dayOf(now);
  // Your calendar since the oldest habit began (repeating events unrolled), for habits your calendar ticks.
  const since = useMemo(() => Math.min(today - 371, ...habits.map((h) => dayOf(h.createdAt))), [habits, today]);
  const words = habits.map((h) => (h.match ?? '').trim().toLowerCase()).filter(Boolean).join('\u0001');
  const past = useMemo(() => habitEvents(events, words, since, today), [events, words, since, today]);
  const stats = useMemo(() => habitStats(habits, log, past, now, today), [habits, log, past, now, today]);
  return { stats, active: stats.filter((s) => !s.h.archived), today, log, past };
}
export type HabitStat = ReturnType<typeof useHabitStats>['stats'][number];

const Cross = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
);
const Check = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden><path d="M2.5 6.3 5 8.7l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/** A progress ring; children sit in the middle. */
export function Ring({ value, color, size = 30, stroke = 3.5, children }: { value: number; color: string; size?: number; stroke?: number; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="ring" style={{ width: size, height: size } as CSSProperties}>
      <svg width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))} transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.35s ease' }}
        />
      </svg>
      <span className="ring-mid">{children}</span>
    </span>
  );
}

const streakText = (h: Habit, n: number) => (h.period === 'day' ? `${n} day${n === 1 ? '' : 's'}` : `${n} week${n === 1 ? '' : 's'}`);

// ---------------------------------------------------------------- sidebar card body
/** The bar under a habit's name: segments you fill one by one (this week's days, or the N times a week), or a
 *  smooth bar for amounts. Each segment: 1 = done, 0 = not, null = still to come. */
function habitBar(s: HabitStat, log: HabitLog, today: number): { segs: (number | null)[] } | { value: number } {
  const { h, auto } = s;
  const mon = weekStart(today);
  if (h.kind === 'count') return { value: Math.min(1, s.progress.done / Math.max(h.goal, 1e-9)) };
  if (h.kind === 'check' && h.period === 'week') return { segs: Array.from({ length: Math.max(1, h.goal) }, (_, i) => (i < s.progress.done ? 1 : 0)) };
  // every day, or an avoid habit: the 7 days of this week
  const first = firstDay(h, log, auto);
  return {
    segs: Array.from({ length: 7 }, (_, i) => {
      const d = mon + i;
      if (d > today || d < first) return null;
      const v = dayValue(h, log, auto, d);
      return v === SKIP ? null : v >= 1 ? 1 : 0;
    }),
  };
}

/** What the right side of a row says: "2/3 this week", "12/20 pages", "4 days". */
const rowText = ({ h, progress: p, streak: n, rest }: HabitStat) => {
  if (rest) return 'Rest day';
  if (h.kind === 'count') return `${Math.round(p.done * 10) / 10}/${p.goal}${h.unit ? ` ${h.unit}` : ''}`;
  if (h.kind === 'check' && h.period === 'week') return `${p.done}/${p.goal} this week`;
  if (h.kind === 'avoid') return p.done ? 'Slipped' : n > 1 ? `${n} days clean` : 'Clean';
  return n > 1 ? `${n}-day streak` : '';
};

/** "+" for an amount habit: type how much, Enter adds it. (No guessing an amount for you.) */
function AddAmount({ h, today, log, auto, onDone }: { h: Habit; today: number; log: HabitLog; auto: Credit; onDone: () => void }) {
  const [v, setV] = useState('');
  const add = () => {
    const n = Number(v);
    if (n > 0) useStore.getState().setHabitAmount(h.id, today, amountOn(h, log, auto, today) + n);
    onDone();
  };
  return (
    <form className="hb-add" onSubmit={(e) => (e.preventDefault(), add())}>
      <input autoFocus type="number" min={0} step="any" inputMode="decimal" placeholder="0" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onDone())} onBlur={() => !v && onDone()} />
      <span>{h.unit || 'today'}</span>
      <button type="submit" disabled={!(Number(v) > 0)}>Add</button>
    </form>
  );
}

export function HabitsCardBody({ onNew }: { onNew: () => void }) {
  const { active, today, log } = useHabitStats();
  const [adding, setAdding] = useState<string | null>(null);
  const st = useStore.getState;
  if (!active.length)
    return (
      <div className="hb-empty">
        <span>Build a habit — gym 3× a week, read 20 pages a day…</span>
        <button className="sl-new-btn" onClick={onNew}>+ New habit</button>
      </div>
    );
  const all = active.every((s) => s.met);
  // The power bar: overall strength (the average of every habit's), drawn through the habits' colours.
  const power = active.reduce((t, s) => t + s.strength, 0) / active.length;
  const colors = active.map((s) => s.h.color);
  const gradient = colors.length > 1 ? `linear-gradient(90deg, ${colors.join(', ')})` : colors[0];
  return (
    <div className="hb-card">
      <button className={cls('hb-power', all && 'all')} onClick={() => st().setPage('habits')} title={`Overall habit strength${all ? ' · all done today' : ''} — open Habits`}>
        <span className="hb-power-line">
          <span>Strength</span>
          <b>{Math.round(power * 100)}%</b>
        </span>
        <span className="hb-power-bar">
          <i style={{ width: `${power * 100}%`, background: gradient, backgroundSize: `${100 / Math.max(power, 0.05)}% 100%` }} />
        </span>
      </button>
      {active.map((s) => {
        const { h } = s;
        const bar = habitBar(s, log, today);
        const keptToday = h.kind === 'avoid' ? !(log[h.id]?.[today] > 0) : h.kind === 'check' ? amountOn(h, log, s.auto, today) > 0 : false;
        return (
          <div key={h.id} className={cls('hb-row', s.met && 'met')} style={{ '--c': h.color } as CSSProperties}>
            {h.kind === 'count' ? (
              <button className="hb-btn plus" title={`Add ${h.unit || 'an amount'} for today`} onClick={() => setAdding(adding === h.id ? null : h.id)}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            ) : (
              <button
                className={cls('hb-btn', keptToday && 'on')}
                role="checkbox"
                aria-checked={keptToday}
                aria-label={h.kind === 'avoid' ? `${h.title}: kept it today` : `${h.title}: done today`}
                title={h.kind === 'avoid' ? (keptToday ? 'Kept it today — tap if you slipped' : 'Slipped today — tap to undo') : keptToday ? 'Done today — tap to undo' : 'Mark done today'}
                onClick={() => st().setHabitAmount(h.id, today, h.kind === 'avoid' ? (keptToday ? 1 : 0) : keptToday ? 0 : 1)}
              >
                {keptToday && <Check size={11} />}
              </button>
            )}
            <div className="hb-main">
              <div className="hb-line">
                <button className="hb-title" onClick={() => st().setPage('habits')}>{h.title}</button>
                <span className="hb-sub">{rowText(s)}</span>
              </div>
              {adding === h.id ? (
                <AddAmount h={h} today={today} log={log} auto={s.auto} onDone={() => setAdding(null)} />
              ) : 'segs' in bar ? (
                <span className="hb-segs">
                  {bar.segs.map((v, i) => <i key={i} className={cls(v === 1 && 'on', v === null && 'later')} />)}
                </span>
              ) : (
                <span className="hb-fill"><i style={{ width: `${bar.value * 100}%` }} /></span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The habits icon: three nested arcs, closing. */
export const HabitGlyph = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
    <path d="M8 1.75A6.25 6.25 0 1 1 1.75 8" />
    <path d="M8 4.25A3.75 3.75 0 1 1 4.6 9.6" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

/** "2/3" — habits on track today (for the card's badge). */
export function HabitsBadge() {
  const { active } = useHabitStats();
  if (!active.length) return null;
  return <span className="side-count">{active.filter((s) => s.met).length}/{active.length}</span>;
}

// ---------------------------------------------------------------- the Habits page
export function HabitsPage() {
  const { stats, active, today, log } = useHabitStats();
  const [editing, setEditing] = useState<string | null>(null); // habit id, 'new', or none
  const [open, setOpen] = useState<string | null>(null); // a habit's own page
  const [showArchived, setShowArchived] = useState(false);
  const archived = stats.filter((s) => s.h.archived);
  const overall = active.length ? active.reduce((a, s) => a + s.strength, 0) / active.length : 0;
  const opened = stats.find((s) => s.h.id === open);
  useEffect(() => {
    document.querySelector('.hp')?.scrollTo(0, 0); // (newer browsers return a promise here — don't hand it to React)
  }, [open]);
  return (
    <div className="hp">
      {opened ? (
        <HabitDetail s={opened} today={today} log={log} onBack={() => setOpen(null)} onEdit={() => setEditing(opened.h.id)} />
      ) : (
        <>
          <div className="hp-head">
            <div>
              <h2 className="hp-title">Habits</h2>
              <div className="hp-sub">
                {active.length ? `${active.filter((s) => s.met).length} of ${active.length} on track · overall strength ${Math.round(overall * 100)}%` : 'Small things, done regularly'}
              </div>
            </div>
            <span className="hp-actions">
              <button className="ce-btn primary" onClick={() => setEditing('new')}>+ New habit</button>
            </span>
          </div>
          {!active.length ? (
            <div className="hp-start">
              <p>Pick one to start, or make your own. A habit with a calendar word (like “gym”) ticks itself when that event happens.</p>
              <div className="hp-templates">
                {HABIT_TEMPLATES.map((t, i) => {
                  const color = CALENDAR_COLORS[i % CALENDAR_COLORS.length];
                  return (
                    <button key={t.title} className="hp-template" style={{ '--c': color } as CSSProperties} onClick={() => useStore.getState().addHabit({ ...t, color })}>
                      <i className="hp-swatch" />
                      <b>{t.title}</b>
                      <small>{describeGoal(t)}</small>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="hp-grid">
              {active.map((s) => <HabitCard key={s.h.id} s={s} today={today} log={log} onEdit={() => setEditing(s.h.id)} onOpen={() => setOpen(s.h.id)} />)}
            </div>
          )}
          {archived.length > 0 && (
            <div className="hp-archived">
              <button className="tk-more" onClick={() => setShowArchived(!showArchived)}>Archived ({archived.length}) {showArchived ? '▴' : '▾'}</button>
              {showArchived && archived.map((s) => (
                <button key={s.h.id} className="hp-arch-row" style={{ '--c': s.h.color } as CSSProperties} onClick={() => setOpen(s.h.id)}>
                  <i className="hp-swatch" />
                  <b>{s.h.title}</b>
                  <span>{describeGoal(s.h)} · since {format(s.h.createdAt, 'MMM yyyy')}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {editing && <HabitEditor id={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** This week, Mon–Sun. Daily check habits cycle done → rest day → empty; count habits pick the day to enter. */
function WeekStrip({ s, today, log, sel, onSel }: { s: HabitStat; today: number; log: HabitLog; sel: number; onSel: (d: number) => void }) {
  const { h, auto } = s;
  const st = useStore.getState;
  const mon = weekStart(today);
  const first = firstDay(h, log, auto);
  const tap = (d: number) => {
    if (h.kind === 'count') return onSel(d);
    const v = log[h.id]?.[d] ?? 0;
    if (h.kind === 'avoid') return st().setHabitAmount(h.id, d, v > 0 ? 0 : 1); // a slip, or not
    // done → rest day (daily habits only) → empty
    st().setHabitAmount(h.id, d, v > 0 ? (h.period === 'day' ? SKIP : 0) : v < 0 ? 0 : 1);
  };
  return (
    <div className="hc-week">
      {Array.from({ length: 7 }, (_, i) => {
        const d = mon + i;
        const out = d > today || d < first; // not yet, or before the habit began: nothing to show
        const v = out ? 0 : dayValue(h, log, auto, d);
        const fromCal = auto.has(d) && !(log[h.id]?.[d] > 0);
        const label = h.kind === 'avoid' ? (v >= 1 ? 'clean — tap if you slipped' : 'slipped') : v === SKIP ? 'rest day' : fromCal ? 'from your calendar' : v >= 1 ? 'done' : v > 0 ? 'partly' : 'not done';
        return (
          <button
            key={d}
            disabled={out}
            className={cls('hc-day', out && 'out', d === today && 'today', h.kind === 'count' && d === sel && 'sel', v >= 1 && 'full', fromCal && 'auto', v === SKIP && 'rest', !out && h.kind === 'avoid' && v === 0 && 'slip')}
            title={`${format(dateOfDay(d), 'EEEE MMM d')} · ${label}`}
            onClick={() => tap(d)}
          >
            <small>{format(dateOfDay(d), 'EEEEE')}</small>
            <span className="hc-dot" style={{ '--v': Math.max(0, v) } as CSSProperties}>
              {!out && v >= 1 && !fromCal && <Check />}
              {v === SKIP && <i className="hc-dash" />}
              {!out && h.kind === 'avoid' && v === 0 && <Cross />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function HabitCard({ s, today, log, onEdit, onOpen }: { s: HabitStat; today: number; log: HabitLog; onEdit: () => void; onOpen: () => void }) {
  const { h, auto } = s;
  const [sel, setSel] = useState(today);
  const grid = useMemo(() => yearGrid(h, log, auto, today, 26), [h, log, auto, today]);
  const mon = weekStart(today);
  const months = grid.map((_, i) => {
    const first = dateOfDay(mon - (25 - i) * 7);
    return i === 0 || first.getDate() <= 7 ? format(first, 'MMM') : '';
  });
  return (
    <div className="hc" style={{ '--c': h.color } as CSSProperties}>
      <div className="hc-top">
        <button className="hc-name" onClick={onOpen} title="See its history">
          <b><i className="hp-swatch" />{h.title}</b>
          <span>{describeGoal(h)}{h.match && canMatch(h) ? ` · counts “${h.match}” events` : ''}</span>
        </button>
        <button className="icon-btn" onClick={onEdit} title="Edit habit" aria-label={`Edit ${h.title}`}>⋯</button>
      </div>

      <div className="hc-mid">
        <Ring value={s.strength} color={h.color} size={84} stroke={8}>
          <span className="hc-pct">{Math.round(s.strength * 100)}<small>%</small></span>
        </Ring>
        <div className="hc-facts">
          <div><small>Strength</small><b>{s.strength >= 0.8 ? 'Solid' : s.strength >= 0.5 ? 'Building' : s.strength >= 0.2 ? 'Getting going' : 'Just starting'}</b></div>
          <div><small>Streak</small><b>{s.streak ? streakText(h, s.streak) : '—'}</b></div>
          <div><small>{h.period === 'day' ? 'Today' : 'This week'}</small><b className={cls(s.met && 'ok')}>{s.rest ? 'Rest day' : h.kind === 'avoid' ? (s.progress.done ? `${s.progress.done} slip${s.progress.done === 1 ? '' : 's'}${h.goal ? ` of ${h.goal}` : ''}` : 'Clean') : `${s.progress.done}/${s.progress.goal}${h.kind === 'count' && h.unit ? ` ${h.unit}` : ''}`}</b></div>
        </div>
      </div>

      <WeekStrip s={s} today={today} log={log} sel={sel} onSel={setSel} />
      {h.kind === 'count' && <AmountRow h={h} day={sel} today={today} log={log} />}

      <button className="hc-year" onClick={onOpen} title="See its whole history">
        <div className="hc-months">{months.map((m, i) => <span key={i}>{m}</span>)}</div>
        <div className="hc-cells">
          {grid.map((w, i) => (
            <div key={i} className="hc-col">
              {w.map((v, j) => <i key={j} className={cls(v === null && 'none', v === 0 && 'zero', v === SKIP && 'rest')} style={{ '--v': Math.max(0, v ?? 0) } as CSSProperties} />)}
            </div>
          ))}
        </div>
        <span className="hc-more">History →</span>
      </button>
    </div>
  );
}

function AmountRow({ h, day, today, log }: { h: Habit; day: number; today: number; log: HabitLog }) {
  const st = useStore.getState;
  const perDay = h.period === 'day' ? h.goal : Math.ceil(h.goal / 7);
  const step = Math.max(1, Math.round(perDay / 4));
  const raw = log[h.id]?.[day] ?? 0;
  const amount = Math.max(0, raw);
  return (
    <div className="hc-amount">
      <span>{day === today ? 'Today' : format(dateOfDay(day), 'EEE MMM d')}</span>
      <button className="hc-step" onClick={() => st().setHabitAmount(h.id, day, Math.max(0, amount - step))} aria-label={`${h.title}: ${step} less`}>−</button>
      <input className="hc-num" type="number" min={0} value={amount || ''} placeholder="0" aria-label={`${h.title}, ${day === today ? 'today' : format(dateOfDay(day), 'EEEE MMMM d')}${h.unit ? ` (${h.unit})` : ''}`} onChange={(e) => st().setHabitAmount(h.id, day, Math.max(0, Number(e.target.value) || 0))} />
      <button className="hc-step" onClick={() => st().setHabitAmount(h.id, day, amount + step)} aria-label={`${h.title}: ${step} more`}>+</button>
      <span className="hc-unit">{h.unit || ''}{h.period === 'day' ? ` / ${h.goal}` : ''}</span>
      {h.period === 'day' && (
        <button className={cls('hc-rest', raw < 0 && 'on')} onClick={() => st().setHabitAmount(h.id, day, raw < 0 ? 0 : SKIP)} title="Sick, travelling…: doesn't break the streak or lower strength">
          Rest day
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one habit's whole history
/** Width of an element, kept up to date (charts draw to it). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** One floating readout for every chart on the page: value first, then what it's for. */
type TipState = { x: number; y: number; value: string; label: string } | null;
function Tip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div className="ht-tip" style={{ left: tip.x, top: tip.y }}>
      <b>{tip.value}</b>
      <span>{tip.label}</span>
    </div>
  );
}

function HabitDetail({ s, today, log, onBack, onEdit }: { s: HabitStat; today: number; log: HabitLog; onBack: () => void; onEdit: () => void }) {
  const { h, auto } = s;
  const st = useStore.getState;
  const [tip, setTip] = useState<TipState>(null);
  const [sel, setSel] = useState(today); // the day being looked at / changed / noted
  const notes = useStore((x) => x.habitNotes[h.id]) ?? EMPTY;
  const series = useMemo(() => strengthSeries(h, log, auto, today), [h, log, auto, today]);
  const best = useMemo(() => bestStreak(h, log, auto, today), [h, log, auto, today]);
  const first = series.first;
  const allTime = useMemo(() => sumBetween(h, log, auto, first, today), [h, log, auto, first, today]);
  // This year so far vs the same stretch last year.
  const t = dateOfDay(today);
  const jan1 = epochDay(t.getFullYear(), 0, 1);
  const lastJan1 = epochDay(t.getFullYear() - 1, 0, 1);
  const thisYear = sumBetween(h, log, auto, Math.max(jan1, first), today);
  const lastYearSame = first <= lastJan1 + (today - jan1) ? sumBetween(h, log, auto, Math.max(lastJan1, first), lastJan1 + (today - jan1)) : null;
  const monthAgo = series.values.length > 30 ? series.values[series.values.length - 30] : null;
  const rates = useMemo(() => weekdayRates(h, log, auto, today), [h, log, auto, today]);
  const years: number[] = [];
  for (let y = t.getFullYear(); y >= dateOfDay(first).getFullYear(); y--) years.push(y);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const DOW = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  const hi = rates.indexOf(Math.max(...rates));
  const lo = rates.indexOf(Math.min(...rates));
  const yoy = lastYearSame ? (thisYear - lastYearSame) / lastYearSame : null;

  return (
    <div className="ht" style={{ '--c': h.color } as CSSProperties} onPointerLeave={() => setTip(null)}>
      <div className="ht-head">
        <button className="ht-back" onClick={onBack}>← Habits</button>
        <div className="ht-title">
          <h2><i className="hp-swatch" />{h.title}</h2>
          <span>{describeGoal(h)} · since {format(dateOfDay(first), 'MMMM d, yyyy')}{h.archived ? ' · archived' : ''}</span>
        </div>
        <button className="ce-btn" onClick={() => st().updateHabit(h.id, { archived: !h.archived })}>{h.archived ? 'Unarchive' : 'Archive'}</button>
        <button className="ce-btn" onClick={onEdit}>Edit</button>
      </div>

      <div className="ht-stats">
        <div className="ht-stat">
          <small>Strength</small>
          <b>{pct(s.strength)}</b>
          {monthAgo !== null && (
            <span className={cls('ht-delta', s.strength >= monthAgo ? 'up' : 'down')}>
              {s.strength >= monthAgo ? '▲' : '▼'} {Math.abs(Math.round((s.strength - monthAgo) * 100))} pts vs a month ago
            </span>
          )}
        </div>
        <div className="ht-stat"><small>Current streak</small><b>{s.streak ? streakText(h, s.streak) : '—'}</b></div>
        <div className="ht-stat">
          <small>Best streak</small>
          <b>{best.n ? streakText(h, best.n) : '—'}</b>
          {best.n > 0 && <span className="ht-note">{best.n === s.streak && s.streak > 0 ? 'happening now' : `ended ${format(dateOfDay(best.end), 'MMM d, yyyy')}`}</span>}
        </div>
        <div className="ht-stat"><small>All time</small><b>{describeAmount(h, allTime)}</b><span className="ht-note">over {Math.round((today - first) / 7)} weeks</span></div>
        <div className="ht-stat">
          <small>{t.getFullYear()} so far</small>
          <b>{describeAmount(h, thisYear)}</b>
          {yoy !== null && <span className={cls('ht-delta', yoy >= 0 ? 'up' : 'down')}>{yoy >= 0 ? '▲' : '▼'} {Math.abs(Math.round(yoy * 100))}% vs this point last year</span>}
        </div>
      </div>

      <section className="ht-sec">
        <h3>Strength over time</h3>
        <StrengthChart series={series} now={s.strength} onTip={setTip} />
      </section>

      <section className="ht-sec">
        <TotalsChart h={h} log={log} auto={auto} today={today} onTip={setTip} />
      </section>

      <section className="ht-sec">
        <div className="ht-sec-head">
          <h3>Every day</h3>
          <span className="ht-note">Click a day to change it or add a note</span>
        </div>
        <DayPanel h={h} day={sel} today={today} log={log} auto={auto} note={notes[sel] ?? ''} />
        {years.map((y) => <YearHeat key={y} year={y} h={h} log={log} auto={auto} today={today} first={first} onTip={setTip} sel={sel} onSel={setSel} notes={notes} />)}
        <div className="ht-legend">
          <span>Less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((v) => <i key={v} className={cls(v === 0 && 'zero')} style={{ '--v': v } as CSSProperties} />)}
          <span>More</span>
          {h.period === 'day' && <><i className="rest" /><span>Rest day</span></>}
        </div>
      </section>

      <section className="ht-sec">
        <h3>By day of the week</h3>
        <p className="ht-sentence">
          {h.kind === 'avoid' ? 'Cleanest' : 'Most often'} on <b>{DOW[hi]}</b> ({pct(rates[hi])}); {h.kind === 'avoid' ? 'slips most' : 'least'} on <b>{DOW[lo]}</b> ({h.kind === 'avoid' ? `${pct(rates[lo])} clean` : pct(rates[lo])}).
        </p>
        <div className="ht-dow">
          {rates.map((r, i) => (
            <div key={i} className="ht-dow-col" onPointerMove={(e) => setTip({ x: e.clientX, y: e.clientY, value: pct(r), label: `of ${DOW[i]}` })} onPointerLeave={() => setTip(null)}>
              <span className="ht-dow-bar"><i style={{ height: `${r * 100}%` }} /></span>
              <small>{DOW[i].slice(0, 3)}</small>
            </div>
          ))}
        </div>
      </section>
      <Tip tip={tip} />
    </div>
  );
}

const EMPTY: Record<number, string> = {};

/** One day of one habit, any day back to the start: what happened, and a note. */
function DayPanel({ h, day, today, log, auto, note }: { h: Habit; day: number; today: number; log: HabitLog; auto: Credit; note: string }) {
  const st = useStore.getState;
  const raw = log[h.id]?.[day];
  const set = (v: number) => st().setHabitAmount(h.id, day, v);
  const fromCal = raw === undefined && auto.has(day);
  const seg = (options: [string, number, boolean][]) => (
    <div className="seg">
      {options.map(([label, v, on]) => <button key={label} className={cls(on && 'on')} onClick={() => set(v)}>{label}</button>)}
    </div>
  );
  return (
    <div className="ht-day">
      <b>{day === today ? 'Today' : format(dateOfDay(day), 'EEE, MMM d, yyyy')}</b>
      {h.kind === 'check' &&
        seg([
          ['Done', 1, (raw ?? 0) > 0 || fromCal],
          ...(h.period === 'day' ? ([['Rest day', SKIP, (raw ?? 0) < 0]] as [string, number, boolean][]) : []),
          ['Not done', 0, !(raw ?? 0) && !fromCal],
        ])}
      {h.kind === 'avoid' && seg([['Clean', 0, !((raw ?? 0) > 0)], ['Slipped', 1, (raw ?? 0) > 0]])}
      {h.kind === 'count' && (
        <span className="ht-day-amt">
          <input
            className="hc-num" type="number" min={0} placeholder="0"
            value={(raw ?? 0) > 0 ? raw : fromCal ? amountOn(h, log, auto, day) : ''}
            onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))}
          />
          <span>{h.unit}</span>
          {h.period === 'day' && <button className={cls('hc-rest', (raw ?? 0) < 0 && 'on')} onClick={() => set((raw ?? 0) < 0 ? 0 : SKIP)}>Rest day</button>}
        </span>
      )}
      {fromCal && <span className="ht-note">from your calendar</span>}
      <input className="ht-note-in" placeholder="Note for this day…" value={note} onChange={(e) => st().setHabitNote(h.id, day, e.target.value)} />
    </div>
  );
}

/** Strength across the habit's whole life: one 2px line, a 10% wash under it, year (or month) ticks, a crosshair. */
function StrengthChart({ series, now, onTip }: { series: { first: number; values: Float64Array }; now: number; onTip: (t: TipState) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 170, L = 38, R = 12, T = 10, B = 24;
  const vals = useMemo(() => [...series.values, now], [series, now]); // + today
  const n = vals.length;
  const plotW = Math.max(10, width - L - R), plotH = H - T - B;
  const x = (i: number) => L + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
  const y = (v: number) => T + (1 - v) * plotH;
  // One point per pixel at most.
  const step = Math.max(1, Math.floor(n / plotW));
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const line = idx.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  // Ticks: each Jan 1 for long histories, else the 1st of every other month.
  const long = n > 400;
  const ticks: { i: number; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const d = dateOfDay(series.first + i);
    if (d.getDate() === 1 && (long ? d.getMonth() === 0 : d.getMonth() % 2 === 0)) ticks.push({ i, label: long ? String(d.getFullYear()) : format(d, 'MMM') });
  }
  const move = (e: React.PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - L) / plotW) * (n - 1));
    if (i < 0 || i >= n) {
      setHover(null);
      return onTip(null);
    }
    setHover(i);
    onTip({ x: r.left + x(i), y: r.top + y(vals[i]), value: `${Math.round(vals[i] * 100)}%`, label: i === n - 1 ? 'today' : format(dateOfDay(series.first + i), 'MMM d, yyyy') });
  };
  return (
    <div ref={ref} className="ht-chart">
      {width > 0 && (
        <svg width={width} height={H} onPointerMove={move} onPointerLeave={() => (setHover(null), onTip(null))} role="img" aria-label={`Habit strength over time, now ${Math.round(now * 100)}%`}>
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line x1={L} x2={L + plotW} y1={y(v)} y2={y(v)} className="ht-grid" />
              <text x={L - 8} y={y(v) + 4} className="ht-axis" textAnchor="end">{v * 100}%</text>
            </g>
          ))}
          {ticks.map((t) => <text key={t.i} x={x(t.i)} y={H - 6} className="ht-axis" textAnchor="middle">{t.label}</text>)}
          <path d={area} fill="var(--c)" opacity={0.1} />
          <path d={line} fill="none" stroke="var(--c)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + plotH} className="ht-cross" />}
          <circle cx={x(hover ?? n - 1)} cy={y(vals[hover ?? n - 1])} r={4.5} fill="var(--c)" stroke="var(--panel)" strokeWidth={2} />
        </svg>
      )}
    </div>
  );
}

/** Totals per week / month / year as columns (≤24px, rounded tops, 2px gaps); the tallest one is labelled. */
function TotalsChart({ h, log, auto, today, onTip }: { h: Habit; log: HabitLog; auto: Credit; today: number; onTip: (t: TipState) => void }) {
  const [bucket, setBucket] = useState<Bucket>('month');
  const [ref, width] = useWidth<HTMLDivElement>();
  const all = useMemo(() => totals(h, log, auto, bucket, today), [h, log, auto, bucket, today]);
  const items = all.slice(bucket === 'week' ? -52 : bucket === 'month' ? -36 : 0);
  const H = 170, L = 38, R = 8, T = 18, B = 24;
  const plotW = Math.max(10, width - L - R), plotH = H - T - B;
  const max = Math.max(1, ...items.map((b) => b.value));
  const niceStep = (() => {
    const raw = max / 3, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  })();
  const top = Math.ceil(max / niceStep) * niceStep;
  const slot = plotW / Math.max(1, items.length);
  const bw = Math.max(2, Math.min(24, slot - 2));
  const y = (v: number) => T + (1 - v / top) * plotH;
  const labelOf = (start: number) => (bucket === 'year' ? format(dateOfDay(start), 'yyyy') : bucket === 'month' ? format(dateOfDay(start), 'MMMM yyyy') : `Week of ${format(dateOfDay(start), 'MMM d, yyyy')}`);
  const maxI = items.findIndex((b) => b.value === max);
  const what = h.kind === 'check' ? 'Days done' : h.kind === 'avoid' ? 'Clean days' : h.unit ? h.unit[0].toUpperCase() + h.unit.slice(1) : 'Amount';
  const tickLabel = (start: number, i: number) => {
    const d = dateOfDay(start);
    if (bucket === 'year') return format(d, 'yyyy');
    if (bucket === 'month') return d.getMonth() === 0 ? format(d, 'yyyy') : i === 0 ? format(d, 'MMM') : d.getMonth() % 3 === 0 && slot > 14 ? format(d, 'MMM') : '';
    return d.getDate() <= 7 && d.getMonth() % 3 === 0 ? format(d, 'MMM') : '';
  };
  return (
    <>
      <div className="ht-sec-head">
        <h3>{what} per {bucket}</h3>
        <div className="seg">
          {(['week', 'month', 'year'] as Bucket[]).map((b) => (
            <button key={b} className={cls(bucket === b && 'on')} onClick={() => setBucket(b)}>{b[0].toUpperCase() + b.slice(1)}</button>
          ))}
        </div>
      </div>
      <div ref={ref} className="ht-chart">
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`${what} per ${bucket}`}>
            {Array.from({ length: Math.round(top / niceStep) + 1 }, (_, k) => k * niceStep).map((v) => (
              <g key={v}>
                <line x1={L} x2={L + plotW} y1={y(v)} y2={y(v)} className="ht-grid" />
                <text x={L - 8} y={y(v) + 4} className="ht-axis" textAnchor="end">{v.toLocaleString()}</text>
              </g>
            ))}
            {items.map((b, i) => {
              const cx = L + slot * (i + 0.5);
              const y0 = y(b.value), yb = y(0);
              const hgt = Math.max(0, yb - y0);
              const r = Math.min(4, bw / 2, hgt);
              const x0 = cx - bw / 2;
              // rounded data-end, square at the baseline
              const d = hgt <= 0 ? '' : `M${x0},${yb}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${yb}Z`;
              const tick = tickLabel(b.start, i);
              return (
                <g key={b.start}>
                  <rect
                    x={cx - slot / 2} y={T} width={slot} height={plotH} fill="transparent"
                    onPointerMove={(e) => {
                      const r0 = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      onTip({ x: r0.left + cx, y: r0.top + y0, value: describeAmount(h, b.value), label: labelOf(b.start) });
                    }}
                    onPointerLeave={() => onTip(null)}
                  />
                  {d && <path d={d} fill="var(--c)" pointerEvents="none" />}
                  {i === maxI && b.value > 0 && <text x={cx} y={y0 - 5} className="ht-val" textAnchor="middle">{Math.round(b.value).toLocaleString()}</text>}
                  {tick && <text x={cx} y={H - 6} className="ht-axis" textAnchor="middle">{tick}</text>}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </>
  );
}

/** One calendar year, Monday-first weeks, Jan–Dec; the year's total beside it. */
function YearHeat({ year, h, log, auto, today, first, onTip, sel, onSel, notes }: { year: number; h: Habit; log: HabitLog; auto: Credit; today: number; first: number; onTip: (t: TipState) => void; sel: number; onSel: (d: number) => void; notes: Record<number, string> }) {
  const weeks = useMemo(() => yearWeeks(year), [year]);
  const total = useMemo(() => sumBetween(h, log, auto, Math.max(first, epochDay(year, 0, 1)), Math.min(today, epochDay(year, 11, 31))), [h, log, auto, first, today, year]);
  // A month's label sits over the first week that starts in it.
  const months = weeks.map((w, i) => {
    const d = w.find((x) => x !== null)!;
    const date = dateOfDay(d);
    const prev = i > 0 ? dateOfDay(weeks[i - 1].find((x) => x !== null)!) : null;
    return !prev || prev.getMonth() !== date.getMonth() ? format(date, 'MMM') : '';
  });
  return (
    <div className="ht-year">
      <div className="ht-year-label"><b>{year}</b><span>{describeAmount(h, total)}</span></div>
      <div className="ht-year-grid" style={{ '--weeks': weeks.length } as CSSProperties}>
        <div className="ht-year-months">{months.map((m, i) => <span key={i}>{m}</span>)}</div>
        <div
          className="ht-year-cells"
          onPointerMove={(e) => {
            const el = e.target as HTMLElement;
            const d = el.dataset.day;
            if (!d) return onTip(null);
            const day = Number(d);
            const v = dayValue(h, log, auto, day);
            const amt = Math.max(0, log[h.id]?.[day] ?? 0);
            const value =
              v === SKIP ? 'Rest day'
              : h.kind === 'avoid' ? (v >= 1 ? 'Clean' : `Slipped${amt > 1 ? ` ×${amt}` : ''}`)
              : h.kind === 'check' ? (v >= 1 ? (auto.has(day) && !(amt > 0) ? 'Done · from calendar' : 'Done') : 'Not done')
              : describeAmount(h, amountOn(h, log, auto, day));
            const r = el.getBoundingClientRect();
            const note = notes[day];
            onTip({ x: r.left + r.width / 2, y: r.top, value, label: `${format(dateOfDay(day), 'EEE MMM d, yyyy')}${note ? ` · “${note.length > 40 ? note.slice(0, 40) + '…' : note}”` : ''}` });
          }}
          onPointerLeave={() => onTip(null)}
          onClick={(e) => {
            const d = (e.target as HTMLElement).dataset.day;
            if (d) onSel(Number(d));
          }}
        >
          {weeks.map((w, i) => (
            <div key={i} className="ht-col">
              {w.map((d, j) => {
                if (d === null || d > today || d < first) return <i key={j} className="none" />;
                const v = dayValue(h, log, auto, d);
                return <i key={j} data-day={d} className={cls(v === 0 && 'zero', v === SKIP && 'rest', d === today && 'today', d === sel && 'sel', notes[d] && 'noted')} style={{ '--v': Math.max(0, v) } as CSSProperties} />;
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editor (new or existing)
export function HabitEditor({ id, onClose }: { id: string | 'new'; onClose: () => void }) {
  const habits = useStore((s) => s.habits);
  const { addHabit, updateHabit, deleteHabit } = useStore.getState();
  const existing = id === 'new' ? undefined : habits.find((h) => h.id === id);
  const unused = CALENDAR_COLORS.find((c) => !habits.some((h) => h.color === c)) ?? CALENDAR_COLORS[0];
  const [draft, setDraft] = useState<Omit<Habit, 'id' | 'createdAt'>>(existing ?? { title: '', color: unused, kind: 'check', goal: 1, period: 'day' });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Existing habits update as you go; a new one is made on "Create".
  const up = (patch: Partial<Habit>) => {
    const next = { ...draft, ...patch };
    if (patch.kind === 'check' && next.period === 'day') next.goal = 1;
    if (patch.kind === 'count' && next.goal <= 1) next.goal = 20;
    if (patch.kind === 'avoid') next.goal = 0;
    if (patch.kind && patch.kind !== 'avoid' && next.goal < 1) next.goal = 1;
    setDraft(next);
    if (existing && next.title.trim()) updateHabit(existing.id, next);
  };
  const create = () => {
    if (!draft.title.trim()) return;
    addHabit({ ...draft, title: draft.title.trim() });
    onClose();
  };
  return (
    <div className="ce-scrim" onMouseDown={onClose}>
      <div className="ce he" onMouseDown={(e) => e.stopPropagation()} style={{ '--c': draft.color } as CSSProperties}>
        <div className="ce-head">
          <span className="ce-dot" />
          <span className="ce-title">{existing ? 'Edit habit' : 'New habit'}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        {!existing && (
          <div className="he-templates">
            {HABIT_TEMPLATES.map((t) => <button key={t.title} onClick={() => setDraft({ ...t, color: draft.color })}>{t.title}</button>)}
          </div>
        )}
        <input
          autoFocus
          className="ce-name"
          placeholder="Habit name"
          value={draft.title}
          onChange={(e) => up({ title: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && (existing ? onClose() : create())}
        />
        <div className="ce-colors" role="radiogroup" aria-label="Colour">
          {CALENDAR_COLORS.map((c) => (
            <button key={c} className={cls('ce-swatch', c === draft.color && 'on')} style={{ '--s': c } as CSSProperties} onClick={() => up({ color: c })} aria-label={c} />
          ))}
        </div>

        <div className="he-rows">
          <div className="ce-row">
            <span>Track</span>
            <div className="seg">
              <button className={cls(draft.kind === 'check' && 'on')} onClick={() => up({ kind: 'check' })}>Done / not done</button>
              <button className={cls(draft.kind === 'count' && 'on')} onClick={() => up({ kind: 'count' })}>An amount</button>
              <button className={cls(draft.kind === 'avoid' && 'on')} onClick={() => up({ kind: 'avoid' })} title="Something to cut down on: tap the days you slip">Avoid</button>
            </div>
          </div>
          <div className="ce-row">
            <span>Goal</span>
            <span className="he-goal">
              {draft.kind === 'avoid' && <span>at most</span>}
              {(draft.kind === 'avoid' || !(draft.kind === 'check' && draft.period === 'day')) && (
                <input className="sl-in he-num" type="number" min={draft.kind === 'avoid' ? 0 : 1} value={draft.goal} onChange={(e) => up({ goal: Math.max(draft.kind === 'avoid' ? 0 : 1, Number(e.target.value) || 0) })} />
              )}
              {draft.kind === 'count' ? (
                <input className="sl-in he-unit" placeholder="pages, min, km…" value={draft.unit ?? ''} onChange={(e) => up({ unit: e.target.value })} />
              ) : draft.period === 'week' || draft.kind === 'avoid' ? <span>times</span> : null}
              <div className="seg">
                <button className={cls(draft.period === 'day' && 'on')} onClick={() => up({ period: 'day' })}>{draft.kind === 'check' ? 'Every day' : 'a day'}</button>
                <button className={cls(draft.period === 'week' && 'on')} onClick={() => up({ period: 'week', goal: draft.kind === 'check' && draft.goal === 1 ? 3 : draft.goal })}>a week</button>
              </div>
            </span>
          </div>
          {canMatch(draft) && (
            <div className="ce-row">
              <span>Calendar events named</span>
              <input className="sl-in he-match" placeholder="e.g. gym (optional)" value={draft.match ?? ''} onChange={(e) => up({ match: e.target.value })} />
            </div>
          )}
          {canMatch(draft) && (
            <p className="set-note">
              {draft.kind === 'check' ? '…count as done when they happen, so you don’t have to tick them.' : '…count by their length when they happen (what you log yourself wins).'}
            </p>
          )}
          {draft.kind === 'count' && !canMatch(draft) && <p className="set-note">Measure it in min or hours and your calendar blocks can count toward it.</p>}
          {draft.kind === 'avoid' && <p className="set-note">Every day counts as clean until you tap that you slipped.</p>}
        </div>

        <div className="ce-actions">
          {existing ? <button className="ce-btn subtle-danger" onClick={() => { deleteHabit(existing.id); onClose(); }}><Trash /> Delete</button> : <span />}
          {existing ? <button className="ce-btn primary" onClick={onClose}>Done</button> : <button className="ce-btn primary" disabled={!draft.title.trim()} onClick={create}>Create</button>}
        </div>
      </div>
    </div>
  );
}
