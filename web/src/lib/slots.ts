// The calendar grid's columns ("slots") and the days they show. With weekends shown, slot i is simply day i (days
// counted from ORIGIN, lib/dates.ts). With weekends hidden, only Monday–Friday get a column: slot i is the i-th
// weekday, and a weekend day falls between two columns. Pure, so the mapping is tested on its own.

export interface Slots {
  hidden: boolean;
  total: number; // how many columns there are
  /** The column for a day. A hidden day: 'ceil' → the next column, 'floor' → the previous one, 'exact' → -1. */
  toSlot: (day: number, mode?: 'ceil' | 'floor' | 'exact') => number;
  toDay: (slot: number) => number;
}

export const allDays = (totalDays: number): Slots => ({ hidden: false, total: totalDays, toSlot: (d) => d, toDay: (s) => s });

/** Columns for Monday–Friday only. `originDow`: the weekday of day 0 (0 = Sunday … 6 = Saturday). */
export function weekdaysOnly(totalDays: number, originDow: number): Slots {
  const shown = Array.from({ length: 7 }, (_, k) => { const dow = (originDow + k) % 7; return dow !== 0 && dow !== 6; });
  const before = shown.map((_, k) => shown.slice(0, k).filter(Boolean).length); // shown days earlier in the week
  const nth = shown.flatMap((on, k) => (on ? [k] : [])); // offset within the week of the n-th shown day
  const toSlot = (day: number, mode: 'ceil' | 'floor' | 'exact' = 'ceil') => {
    const w = Math.floor(day / 7), r = ((day % 7) + 7) % 7;
    const s = w * 5 + before[r];
    if (shown[r]) return s;
    return mode === 'exact' ? -1 : mode === 'ceil' ? s : s - 1;
  };
  const toDay = (slot: number) => Math.floor(slot / 5) * 7 + nth[((slot % 5) + 5) % 5];
  return { hidden: true, total: toSlot(totalDays, 'ceil'), toSlot, toDay };
}
