// The Mac app's web view has no confirm() / alert() / prompt(): they silently return nothing, so a "Delete?" built
// on them never deletes. Everything must use the in-app dialog (components/Confirm.tsx → ask()).
import { expect, it } from 'vitest';

const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

it('no browser popups (confirm / alert / prompt) anywhere in the app', () => {
  const bad = Object.entries(sources).flatMap(([file, text]) =>
    text.split('\n').map((line, i) => ({ file, n: i + 1, line })).filter(({ line }) => /(^|[^\w.]|window\.)(confirm|alert|prompt)\(/.test(line.replace(/\/\/.*$/, '')) && !/function confirm|const confirm|void confirm\(\)/.test(line)),
  );
  expect(bad.map((b) => `${b.file}:${b.n}`)).toEqual([]);
  expect(Object.keys(sources).length).toBeGreaterThan(30);
});
