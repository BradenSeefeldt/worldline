import { describe, expect, it } from 'vitest';
import ct from 'city-timezones';
import { buildIndex, describeZone, searchZones } from './zoneSearch';

const zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
const index = buildIndex(ct.cityMapping as never, zones);
const top = (q: string) => searchZones(index, q)[0];
const labels = (q: string) => searchZones(index, q).map((h) => `${h.label}|${h.zone}`);

describe('time zone search', () => {
  it('finds a city that is not a zone name: Calgary → Edmonton’s zone', () => {
    expect(top('calgary')).toMatchObject({ label: 'Calgary', zone: 'America/Edmonton' });
    expect(top('calg')?.label).toBe('Calgary'); // while typing
    expect(labels('cal').slice(0, 3)).toContain('Calgary|America/Edmonton');
    expect(top('calagry')?.label).toBe('Calgary'); // typo
    expect(labels('calg')).toEqual(['Calgary|America/Edmonton']); // no typo noise when there's a real match
  });
  it('a province, state or country lists its cities', () => {
    expect(searchZones(index, 'alberta').every((h) => h.zone === 'America/Edmonton')).toBe(true);
    expect(top('ontario')?.zone).toBe('America/Toronto');
  });
  it('more words narrow it down', () => {
    expect(top('london ontario')).toMatchObject({ label: 'London', zone: 'America/Toronto' });
    expect(top('london')).toMatchObject({ zone: 'Europe/London' }); // the big one first
    expect(top('paris france')?.zone).toBe('Europe/Paris');
  });
  it('time zone names and abbreviations', () => {
    const m = searchZones(index, 'mountain');
    expect(m[0]).toMatchObject({ label: 'Mountain Time', isZone: true });
    expect(m.slice(0, 3).some((h) => h.zone === 'America/Denver' || h.zone === 'America/Edmonton')).toBe(true);
    expect(labels('mst').some((x) => x.endsWith('America/Edmonton') || x.endsWith('America/Denver'))).toBe(true);
    expect(top('kathmandu')?.zone).toMatch(/Asia\/Kat(h)?mandu/);
  });
  it('accents do not matter', () => {
    expect(top('montreal')?.label).toMatch(/Montr[eé]al/);
    expect(top('zurich')?.zone).toBe('Europe/Zurich');
  });
  it('no duplicate rows for a city that is also a zone name', () => {
    expect(labels('toronto').filter((x) => x === 'Toronto|America/Toronto')).toHaveLength(1);
  });
  it('describes a zone', () => {
    expect(describeZone('America/Edmonton', new Date(2026, 6, 1).getTime())).toBe('Mountain · MDT · UTC−6');
    expect(describeZone('America/Bogota', new Date(2026, 6, 1).getTime())).toBe('Colombia · UTC−5');
  });
});
