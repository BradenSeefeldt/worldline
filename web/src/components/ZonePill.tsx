// Which time zone the calendar is drawn in, shown in the toolbar while you're away from home (amber, with ✈).
// At home the time grid's corner already names the zone, so the toolbar leaves it out.
import { useEffect, useRef, useState } from 'react';
import { TimeZonePicker } from './TimeZonePicker';
import { useStore } from '../data/store';
import { fmtOffset, localZone, zoneAbbr, zoneCity, zoneOffset } from '../lib/zone';
import { cls } from '../lib/format';

function diffText(minutes: number) {
  if (!minutes) return 'same time';
  const h = Math.abs(minutes) / 60;
  const n = Number.isInteger(h) ? `${h} h` : `${Math.floor(h)} h ${Math.abs(minutes) % 60} min`;
  return `${n} ${minutes > 0 ? 'ahead of' : 'behind'}`;
}

export function ZonePill() {
  const zone = useStore((s) => s.zone);
  const home = useStore((s) => s.homeZone);
  const showHomeHours = useStore((s) => s.showHomeHours);
  const { setHomeZone, setShowHomeHours } = useStore.getState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const away = zone !== home;
  const now = Date.now();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const here = { city: zoneCity(zone), abbr: zoneAbbr(zone, now), off: zoneOffset(zone, now) };
  const there = { city: zoneCity(home), abbr: zoneAbbr(home, now), off: zoneOffset(home, now) };

  return (
    <div className="zone" ref={ref}>
      <button
        className={cls('zone-pill', away && 'away')}
        onClick={() => setOpen(!open)}
        title={`Times are shown in ${zone} (${here.abbr})`}
      >
        {away && <span className="zone-plane">✈</span>}
        <span className="zone-city">{here.city}</span>
        <span className="zone-abbr">{here.abbr}</span>
      </button>
      {open && (
        <div className="zone-pop">
          <div className="zone-label">Times are shown in</div>
          <div className="zone-big">
            {here.city} <span>{here.abbr} · {fmtOffset(here.off)}</span>
          </div>
          <div className="zone-note">This computer’s time zone. It switches automatically when you travel.</div>

          {away ? (
            <div className="zone-away">
              ✈ You’re away from home. {here.city} is {diffText(here.off - there.off)} {there.city} ({there.abbr}).
            </div>
          ) : (
            <div className="zone-note">You’re in your home time zone.</div>
          )}

          <div className="zone-label">Home time zone</div>
          <TimeZonePicker value={home} onChange={setHomeZone} />
          {away && (
            <button className="zone-btn" onClick={() => setHomeZone(localZone())}>
              Make {here.city} my home
            </button>
          )}
          <label className="zone-row">
            <span>Show home hours beside the calendar when away</span>
            <input type="checkbox" className="switch" checked={showHomeHours} onChange={(e) => setShowHomeHours(e.target.checked)} />
          </label>
        </div>
      )}
    </div>
  );
}
