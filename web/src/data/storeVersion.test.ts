// Data saved by a newer Worldline, opened by an older copy (someone reinstalled an old .dmg): it isn't loaded,
// and nothing is written over it — the recovery screen asks to update instead.
import { expect, it } from 'vitest';
import { STORE_VERSION } from './storeVersion';

const saved = JSON.stringify({ state: { myName: 'From the future', events: [], calendars: [] }, version: STORE_VERSION + 1 });
const mem = new Map<string, string>([['calendar-v1', saved]]);
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const noop = () => {};
Object.assign(globalThis, {
  localStorage,
  window: { innerWidth: 1200, localStorage, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false }) },
  document: { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible' },
});

it('data from a newer version: not loaded, never overwritten, the app is told to update', async () => {
  const { useStore } = await import('./store');
  const persist = await import('./persist');
  await new Promise((r) => setTimeout(r, 20));
  expect(persist.loadProblem).toMatch(/newer version/);
  expect(useStore.getState().myName).not.toBe('From the future');
  useStore.getState().setSettings({ hour24: true });
  await persist.flush();
  expect(mem.get('calendar-v1')).toBe(saved);
});
