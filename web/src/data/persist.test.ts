// The safeguards around saved data (the browser path: localStorage; the Mac app's database works the same way).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
let failWrites = false;
const localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error('disk full');
    mem.set(k, v);
  },
  removeItem: (k: string) => void mem.delete(k),
};
Object.assign(globalThis, { localStorage, window: { setTimeout, clearTimeout, addEventListener() {} }, document: { addEventListener() {} } });

const good = (name: string) => JSON.stringify({ state: { myName: name, events: [], calendars: [] }, version: 2 });
const load = async () => {
  vi.resetModules();
  return import('./persist');
};

beforeEach(() => {
  mem.clear();
  failWrites = false;
});

describe('saved data that can’t be read', () => {
  it('is kept aside, never written over, and the app is told why', async () => {
    mem.set('calendar-v1', '{"state": {broken');
    const p = await load();
    const s = p.appStorage();
    expect(await s.getItem('calendar-v1')).toBeNull();
    expect(p.loadProblem).toMatch(/couldn’t be read/);
    expect(mem.get('calendar-v1-unreadable')).toBe('{"state": {broken');
    s.setItem('calendar-v1', good('Defaults'));
    await new Promise((r) => setTimeout(r, 10));
    expect(mem.get('calendar-v1')).toBe('{"state": {broken'); // untouched
  });
  it('readable data loads normally; nothing saved means a first run', async () => {
    mem.set('calendar-v1', good('Sam'));
    let p = await load();
    expect(await p.appStorage().getItem('calendar-v1')).toBe(good('Sam'));
    expect(p.loadProblem).toBeNull();
    mem.clear();
    p = await load();
    expect(await p.appStorage().getItem('calendar-v1')).toBeNull();
    expect(p.firstRun).toBe(true);
    expect(p.loadProblem).toBeNull();
  });
});

describe('a save that fails', () => {
  it('is kept and tried again; the app hears once that it failed and once that it works again', async () => {
    const p = await load();
    const heard: boolean[] = [];
    p.onSaveTrouble((ok) => heard.push(ok));
    failWrites = true;
    p.appStorage().setItem('calendar-v1', good('First'));
    await new Promise((r) => setTimeout(r, 10));
    expect(heard).toEqual([false]);
    failWrites = false;
    await p.flush(); // (the retry would also do this, five seconds later)
    expect(mem.get('calendar-v1')).toBe(good('First'));
    expect(heard).toEqual([false, true]);
  });
});

describe('restoring', () => {
  it('keeps what it replaced, so it can be undone; refuses something that isn’t saved data', async () => {
    mem.set('calendar-v1', good('Before'));
    const p = await load();
    await p.replaceSaved('calendar-v1', good('Restored'));
    expect(mem.get('calendar-v1')).toBe(good('Restored'));
    expect(await p.beforeRestore('calendar-v1')).toBe(good('Before'));
    await expect(p.replaceSaved('calendar-v1', 'garbage')).rejects.toThrow();
    expect(mem.get('calendar-v1')).toBe(good('Restored'));
  });
  it('starting over from the recovery screen keeps the unreadable copy aside', async () => {
    mem.set('calendar-v1', 'garbage');
    const p = await load();
    await p.appStorage().getItem('calendar-v1');
    await p.startOverKeepingUnreadable('calendar-v1');
    expect(mem.has('calendar-v1')).toBe(false);
    expect(mem.get('calendar-v1-unreadable')).toBe('garbage');
    expect(p.loadProblem).toBeNull();
  });
});
