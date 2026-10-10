// Typo tolerance shared by the quick-add parser and the event-name matcher.

/** Edit distance where swapping two neighbouring letters counts as one typo ("thrusday"). */
export function typoDistance(a: string, b: string) {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** How many typos a word of this length may contain and still count: short words none. */
export const typoBudget = (len: number) => (len >= 8 ? 2 : len >= 6 ? 1 : 0);

// Date words worth correcting. Short ones (noon, may, june, mon…) are left out on purpose:
// a one-letter slip there usually makes another real word ("moon", a name).
const DATE_WORDS = [
  'tomorrow', 'tonight', 'yesterday', 'today',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'august', 'september', 'october', 'november', 'december',
  'morning', 'afternoon', 'evening', 'midnight', 'weekend',
];
// Real words that sit one typo away from a date word.
const KEEP = new Set(['sundae', 'mourning', 'mondale', 'augusta', 'eventing']);

/** Is `a` what you get from `b` by dropping letters? ("tursday" from "thursday") */
const isSubsequence = (a: string, b: string) => {
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length;
};

/** Correct misspelled date words: "tommorrow" → "tomorrow", "wendesday" → "wednesday". */
export function fixDateTypos(text: string) {
  return text.replace(/[A-Za-z]{5,}/g, (w) => {
    const lw = w.toLowerCase();
    if (KEEP.has(lw) || DATE_WORDS.includes(lw)) return w;
    if (lw.endsWith('s') && DATE_WORDS.includes(lw.slice(0, -1))) return w; // "Fridays" means a repeat; keep it
    const plural = lw.endsWith('s') ? lw.slice(0, -1) : lw; // "mondays"
    let best: string | null = null;
    let bestD = Infinity;
    for (const k of DATE_WORDS) {
      const budget = typoBudget(k.length);
      if (!budget || Math.abs(k.length - lw.length) > budget) continue;
      const dist = Math.min(typoDistance(lw, k), typoDistance(plural, k));
      if (dist > budget) continue;
      // On a tie, a missed or doubled key beats a wrong key: "tursday" is Thursday, not Tuesday.
      const score = dist * 2 - (isSubsequence(lw, k) || isSubsequence(k, lw) ? 1 : 0);
      if (score < bestD) {
        best = k;
        bestD = score;
      }
    }
    return best ?? w;
  });
}
