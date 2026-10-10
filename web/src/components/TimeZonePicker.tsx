// Type a city, province/state, country or zone name ("calgary", "alberta", "mountain") and pick
// from the matches. Each match shows the zone and the time there right now, as a sanity check.
import { useEffect, useMemo, useState } from 'react';
import { buildIndex, describeZone, searchZones, timeIn, type ZoneIndex } from '../lib/zoneSearch';
import { zoneCity } from '../lib/zone';
import { cls } from '../lib/format';

let cached: ZoneIndex | null = null; // the city list is big: load it once, only when needed

export function TimeZonePicker({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState<ZoneIndex | null>(cached);
  const [hi, setHi] = useState(0);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    import('city-timezones').then((m) => {
      const zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
      cached = buildIndex((m.default ?? m).cityMapping, zones);
      if (alive) setIndex(cached);
    });
    return () => {
      alive = false;
    };
  }, []);

  const hits = useMemo(() => (index && q.trim() ? searchZones(index, q) : []), [index, q]);
  const pick = (zone: string) => {
    onChange(zone);
    setQ('');
  };

  return (
    <div className="tzp">
      <div className="tzp-current">
        <b>{zoneCity(value)}</b> · {describeZone(value)}
      </div>
      <input
        className="tzp-input"
        placeholder="Search a city, province, country or zone…"
        value={q}
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (hits.length) setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length);
          }
          if (e.key === 'Enter' && hits[hi]) pick(hits[hi].zone);
          if (e.key === 'Escape' && q) {
            e.stopPropagation();
            setQ('');
          }
        }}
      />
      {q.trim() && !index && <div className="tzp-note">Loading cities…</div>}
      {hits.length > 0 && (
        <div className="tzp-list" role="listbox">
          {hits.map((h, i) => (
            <button
              key={`${h.label}|${h.sub}|${h.zone}`}
              role="option"
              aria-selected={i === hi}
              className={cls('tzp-hit', i === hi && 'hi', h.zone === value && 'current', h.isZone && 'zone')}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(h.zone)}
            >
              <span className="tzp-place">
                <b>{h.label}</b>
                {h.sub && <span>{h.sub}</span>}
              </span>
              <span className="tzp-zone">
                {describeZone(h.zone)} · <b>{timeIn(h.zone)}</b> now
              </span>
            </button>
          ))}
        </div>
      )}
      {q.trim() && index && !hits.length && (
        <div className="tzp-note">No match — try the nearest big city, the province/state, or the country.</div>
      )}
    </div>
  );
}
