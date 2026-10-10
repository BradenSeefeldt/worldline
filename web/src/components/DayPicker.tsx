// Pick the days a link offers by dragging across a calendar (click toggles one day).
import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { epochDay, fromEpochDay, wallClock } from '../lib/zone';
import { cls } from '../lib/format';
import { Chevron } from './Icons';

const weekdayOf = (e: number) => {
  const { y, m, d } = fromEpochDay(e);
  return new Date(Date.UTC(y, m, d)).getUTCDay();
};

function Month({ y, m, today, selected, onDown }: {
  y: number;
  m: number;
  today: number;
  selected: Set<number>;
  onDown: (day: number) => void;
}) {
  const first = epochDay(y, m, 1);
  const lead = (weekdayOf(first) + 6) % 7; // Monday first
  const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return (
    <div className="dp-month">
      <div className="dp-title">{format(new Date(y, m, 1), 'MMMM yyyy')}</div>
      <div className="dp-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, k) => <span key={k} className="dp-dow">{d}</span>)}
        {Array.from({ length: lead }, (_, k) => <span key={'x' + k} />)}
        {Array.from({ length: count }, (_, k) => {
          const day = first + k;
          const past = day < today;
          return (
            <button
              key={day}
              data-day={past ? undefined : day}
              disabled={past}
              className={cls('dp-day', selected.has(day) && 'on', day === today && 'today', weekdayOf(day) % 6 === 0 && 'weekend')}
              onPointerDown={(e) => {
                e.preventDefault();
                try {
                  (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); // touch: let moves reach other days
                } catch {
                  /* no capture to release */
                }
                onDown(day);
              }}
            >
              {k + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DayPicker({ value, onChange, timeZone }: { value: number[]; onChange: (days: number[]) => void; timeZone: string }) {
  const w = wallClock(Date.now(), timeZone);
  const today = epochDay(w.y, w.m, w.d);
  const [offset, setOffset] = useState(0);
  const selected = useMemo(() => new Set(value), [value]);
  // A drag selects (or clears) every day from where it started to where the pointer is now,
  // like selecting a date range — not just the days the pointer happened to pass over.
  const paint = useRef<{ add: boolean; anchor: number; base: Set<number> } | null>(null);
  const cur = useRef(selected);
  cur.current = selected;

  useEffect(() => {
    const up = () => (paint.current = null);
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);
  const apply = (day: number) => {
    const p = paint.current;
    if (!p) return;
    const next = new Set(p.base);
    for (let d = Math.min(p.anchor, day); d <= Math.max(p.anchor, day); d++) {
      if (d < today) continue;
      if (p.add) next.add(d);
      else next.delete(d);
    }
    cur.current = next;
    onChange([...next].sort((a, b) => a - b));
  };
  const nextWeekdays = (n: number) => {
    const out: number[] = [];
    for (let d = today + 1; out.length < n; d++) if (weekdayOf(d) % 6 !== 0) out.push(d);
    onChange(out);
  };
  const months = [0, 1].map((k) => {
    const mm = w.m + offset + k;
    return { y: w.y + Math.floor(mm / 12), m: ((mm % 12) + 12) % 12 };
  });

  return (
    <div className="dp">
      <div className="dp-bar">
        <span className="dp-count">{value.length ? `${value.length} day${value.length === 1 ? '' : 's'} offered` : 'Drag across the days to offer'}</span>
        <button className="icon-btn sm" disabled={offset === 0} onClick={() => setOffset(offset - 1)} aria-label="Earlier months"><Chevron dir="left" /></button>
        <button className="icon-btn sm" onClick={() => setOffset(offset + 1)} aria-label="Later months"><Chevron dir="right" /></button>
      </div>
      <div
        className="dp-months"
        onPointerMove={(e) => {
          if (!paint.current) return;
          const d = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.dataset.day;
          if (d) apply(+d);
        }}
      >
        {months.map(({ y, m }) => (
          <Month
            key={`${y}-${m}`}
            y={y}
            m={m}
            today={today}
            selected={selected}
            onDown={(day) => {
              paint.current = { add: !cur.current.has(day), anchor: day, base: new Set(cur.current) };
              apply(day);
            }}
          />
        ))}
      </div>
      <div className="dp-quick">
        <button onClick={() => nextWeekdays(5)}>Next 5 weekdays</button>
        <button onClick={() => nextWeekdays(10)}>Next 2 weeks</button>
        <button onClick={() => onChange([])}>Clear</button>
      </div>
    </div>
  );
}
