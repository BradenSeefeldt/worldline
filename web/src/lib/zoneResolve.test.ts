// A wall-clock time that happens twice (clocks go back) or never (clocks go forward) must mean the same instant on
// every device, whatever zone the device itself is in (an exception saved on one must match its occurrence on
// another). Not pinned to a zone: the suite runs in many, and this must hold in all of them.
import { describe, expect, it } from 'vitest';
import { instantOf, wallClock, zoneOffset } from './zone';

const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
const at = (tz: string, y: number, m: number, d: number, h: number, min: number) => iso(instantOf(y, m, d, h * 60 + min, tz));

describe('ambiguous and skipped wall-clock times (L8)', () => {
  it('a repeated time is the first of the two', () => {
    expect(at('America/Toronto', 2026, 10, 1, 1, 30)).toBe('2026-11-01T05:30'); // 1:30 EDT, not EST
    expect(at('Europe/London', 2026, 9, 25, 1, 30)).toBe('2026-10-25T00:30'); // BST
    expect(at('Pacific/Auckland', 2026, 3, 5, 2, 30)).toBe('2026-04-04T13:30'); // NZDT
    expect(at('Australia/Lord_Howe', 2026, 3, 5, 1, 45)).toBe('2026-04-04T14:45'); // a half-hour change
    expect(at('America/St_Johns', 2026, 10, 1, 1, 30)).toBe('2026-11-01T04:00');
  });
  it('a skipped time moves forward by the gap', () => {
    expect(at('America/Toronto', 2026, 2, 8, 2, 30)).toBe('2026-03-08T07:30'); // 3:30 EDT
    expect(at('Europe/London', 2026, 2, 29, 1, 30)).toBe('2026-03-29T01:30'); // 2:30 BST
    expect(at('Pacific/Auckland', 2026, 8, 27, 2, 30)).toBe('2026-09-26T14:30'); // 3:30 NZDT
    expect(at('Australia/Lord_Howe', 2026, 9, 4, 2, 15)).toBe('2026-10-03T15:45'); // 2:45 +11
  });
  it('ordinary times, offsets and wall clocks agree', () => {
    expect(at('Asia/Kolkata', 2026, 9, 12, 9, 0)).toBe('2026-10-12T03:30');
    expect(zoneOffset('Asia/Kolkata', Date.UTC(2026, 0, 1))).toBe(330);
    expect(zoneOffset('America/Toronto', Date.UTC(2026, 6, 1))).toBe(-240);
    expect(wallClock(Date.UTC(2026, 9, 31, 20), 'Pacific/Kiritimati')).toMatchObject({ y: 2026, m: 10, d: 1, h: 10, min: 0, wd: 0 });
  });
});
