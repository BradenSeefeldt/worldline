import { describe, expect, it } from 'vitest';
import { DARK_THEMES, THEMES, resolveTheme } from './theme';
import indexHtml from '../../index.html?raw';
import css from '../styles.css?raw';

describe('themes', () => {
  it('System follows the computer; the named themes are fixed', () => {
    expect(resolveTheme('system', true)).toEqual({ theme: 'dark', dark: true });
    expect(resolveTheme('system', false)).toEqual({ theme: 'light', dark: false });
    expect(resolveTheme('midnight', false)).toEqual({ theme: 'midnight', dark: true });
    expect(resolveTheme('navy', false)).toEqual({ theme: 'navy', dark: true });
    expect(resolveTheme('sand', true)).toEqual({ theme: 'sand', dark: false });
  });
  it('every theme in the picker defines every colour the app uses', () => {
    const block = (id: string) => css.match(new RegExp(`:root\\[data-theme='${id}'\\][^{]*\\{([^}]*)\\}`))?.[1] ?? '';
    const vars = [...block('light').matchAll(/(--[\w-]+):/g)].map((m) => m[1]);
    expect(vars.length).toBeGreaterThan(20);
    for (const t of THEMES.filter((x) => x.id !== 'system')) {
      const have = new Set([...block(t.id).matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
      expect(vars.filter((v) => !have.has(v)), t.id).toEqual([]);
    }
  });
  it('index.html paints the first frame with the same list of dark themes', () => {
    const list = indexHtml.match(/\[('[a-z]+'(?:, '[a-z]+')*)\]\.indexOf\(theme\)/)?.[1];
    expect(list?.split(', ').map((x) => x.slice(1, -1)).sort()).toEqual([...DARK_THEMES].sort());
  });

  // Why some themes once felt like "a coloured filter" and others sharp: the accent was close in lightness to
  // the background (saffron on lilac: 2.3:1), and the greys were tinted with the background's hue, so the whole UI
  // was one colour. Every theme now has to pass the same bar.
  it('every theme is crisp: strong text, an accent that pops, neutral greys', () => {
    const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const lum = (h: string) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const chroma = (h: string) => { const c = rgb(h); return Math.max(...c) - Math.min(...c); };
    const block = (id: string) =>
      Object.fromEntries([...(css.match(new RegExp(`:root(?:, :root)?\\[data-theme='${id}'\\][^{]*\\{([^}]*)\\}`))?.[1] ?? '').matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
    const problems: string[] = [];
    for (const t of THEMES.filter((x) => x.id !== 'system')) {
      const v = block(t.id);
      const check = (what: string, value: number, min: number) => value < min && problems.push(`${t.id}: ${what} ${value.toFixed(2)} < ${min}`);
      check('text', Math.min(ratio(v.text, v.bg), ratio(v.text, v.panel)), 15);
      check('text-2', Math.min(ratio(v['text-2'], v.bg), ratio(v['text-2'], v.panel)), 6);
      check('text-3', ratio(v['text-3'], v.bg), 2.9);
      const accentMin = t.id === 'light' || t.id === 'dark' ? 4.5 : 5; // the classic two keep their system blue/red
      check('accent', Math.min(ratio(v.accent, v.bg), ratio(v.accent, v.panel)), accentMin);
      check('focus', Math.min(ratio(v.focus, v.bg), ratio(v.focus, v.panel)), 4.5);
      check('text on accent', ratio(v['on-accent'], v.accent), 4.5);
      check('text on focus', ratio(v['on-focus'], v.focus), 4.5);
      if (chroma(v['text-2']) > 0.1) problems.push(`${t.id}: text-2 is tinted (${chroma(v['text-2']).toFixed(2)})`);
    }
    expect(problems).toEqual([]);
  });
});
