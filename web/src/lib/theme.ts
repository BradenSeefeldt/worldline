// App themes (Settings → Appearance). The colours themselves live in styles.css under
// :root[data-theme='…']; this file names them, says which are dark, and applies the choice.
export type ThemeId =
  | 'system'
  | 'light' | 'paper' | 'gilt' | 'ice' | 'sand' | 'peach' | 'rose' | 'butter' | 'sage' | 'mint' | 'sky' | 'lavender'
  | 'dark' | 'midnight' | 'obsidian' | 'bumblebee' | 'graphite' | 'navy' | 'abyss' | 'cobalt' | 'fjord' | 'lagoon' | 'evergreen' | 'espresso' | 'bordeaux' | 'aubergine';
type Concrete = Exclude<ThemeId, 'system'>;

export const THEMES: { id: ThemeId; name: string; note: string; dark: boolean | null; preview: { bg: string; panel: string; line: string; text: string; accent: string } }[] = [
  // (previews are generated from the colours in styles.css)
  { id: 'system', name: 'System', note: 'Follows your computer', dark: null, preview: { bg: '#ffffff', panel: '#1c1c1e', line: '#e6e6ea', text: '#1d1d1f', accent: '#2f7cf6' } },
  // light
  { id: 'light', name: 'Light', note: 'Clean white, blue and red', dark: false, preview: { bg: '#f6f6f8', panel: '#ffffff', line: '#e6e6ea', text: '#1d1d1f', accent: '#ec0d00' } },
  { id: 'paper', name: 'Paper', note: 'Off-white with ink cobalt', dark: false, preview: { bg: '#f3f3ee', panel: '#ffffff', line: '#e6e6e0', text: '#16181d', accent: '#1f3fbf' } },
  { id: 'gilt', name: 'Gilt', note: 'White with antique gold', dark: false, preview: { bg: '#f8f6f1', panel: '#ffffff', line: '#ebe7dd', text: '#1a1814', accent: '#8d6708' } },
  { id: 'ice', name: 'Ice', note: 'Steel grey with crimson', dark: false, preview: { bg: '#dde3ea', panel: '#f5f7fa', line: '#d3dae3', text: '#15181d', accent: '#b3123c' } },
  { id: 'sand', name: 'Sand', note: 'Warm beige with red', dark: false, preview: { bg: '#efe8db', panel: '#fcf9f3', line: '#ded8cf', text: '#201d1b', accent: '#bc372c' } },
  { id: 'peach', name: 'Peach', note: 'Apricot with deep teal', dark: false, preview: { bg: '#f6ddcd', panel: '#fdf4ee', line: '#e2d9d3', text: '#1a1715', accent: '#0b6b6b' } },
  { id: 'rose', name: 'Rosé', note: 'Soft blush with plum', dark: false, preview: { bg: '#f5ebe8', panel: '#fffaf9', line: '#e9dedb', text: '#251e20', accent: '#b0416e' } },
  { id: 'butter', name: 'Butter', note: 'Pale yellow with royal blue', dark: false, preview: { bg: '#f5eac2', panel: '#fdf8e6', line: '#d7d4c8', text: '#1f1d18', accent: '#2848a8' } },
  { id: 'sage', name: 'Sage', note: 'Green-grey with forest', dark: false, preview: { bg: '#e8ebe1', panel: '#f9faf6', line: '#dde2d3', text: '#191e19', accent: '#3f6b4a' } },
  { id: 'mint', name: 'Mint', note: 'Seafoam with tomato red', dark: false, preview: { bg: '#d8ede4', panel: '#f2faf6', line: '#cfddd7', text: '#171c1b', accent: '#bb3622' } },
  { id: 'sky', name: 'Sky', note: 'Powder blue with terracotta', dark: false, preview: { bg: '#d9e6f3', panel: '#f2f7fc', line: '#d5dce4', text: '#181a1d', accent: '#a64728' } },
  { id: 'lavender', name: 'Lavender', note: 'Pale lilac with jade', dark: false, preview: { bg: '#e5ddf3', panel: '#f7f4fc', line: '#ded9e7', text: '#19171c', accent: '#0d6e5f' } },
  // dark
  { id: 'dark', name: 'Dark', note: 'Graphite grey', dark: true, preview: { bg: '#161618', panel: '#26262a', line: '#2d2d30', text: '#ffffff', accent: '#ff493e' } },
  { id: 'midnight', name: 'Midnight', note: 'Black with cyan', dark: true, preview: { bg: '#050506', panel: '#131316', line: '#222227', text: '#ececef', accent: '#22d3ee' } },
  { id: 'obsidian', name: 'Obsidian', note: 'Black with hot magenta', dark: true, preview: { bg: '#060608', panel: '#15151a', line: '#24242a', text: '#f0f0f3', accent: '#ff4fa3' } },
  { id: 'bumblebee', name: 'Bumblebee', note: 'Black with gold', dark: true, preview: { bg: '#070605', panel: '#171512', line: '#26231f', text: '#f3f1ec', accent: '#ffc21a' } },
  { id: 'graphite', name: 'Graphite', note: 'Charcoal with electric lime', dark: true, preview: { bg: '#0f1011', panel: '#1c1d1f', line: '#28292c', text: '#f2f2f2', accent: '#c6f432' } },
  { id: 'navy', name: 'Navy', note: 'Deep navy with gold', dark: true, preview: { bg: '#0a1120', panel: '#141e35', line: '#2d313b', text: '#f2f4f7', accent: '#e4b44c' } },
  { id: 'abyss', name: 'Abyss', note: 'Blue-black with lemon', dark: true, preview: { bg: '#050f13', panel: '#0e2028', line: '#212c31', text: '#eef4f6', accent: '#ffd23f' } },
  { id: 'cobalt', name: 'Cobalt', note: 'Electric blue with tangerine', dark: true, preview: { bg: '#090e2a', panel: '#131a45', line: '#393b47', text: '#f2f4f9', accent: '#ff9f43' } },
  { id: 'fjord', name: 'Fjord', note: 'Nordic slate with ice blue', dark: true, preview: { bg: '#171a22', panel: '#1f242e', line: '#30353e', text: '#ffffff', accent: '#88c0d0' } },
  { id: 'lagoon', name: 'Lagoon', note: 'Deep teal with coral', dark: true, preview: { bg: '#081517', panel: '#112629', line: '#222f31', text: '#f8fafa', accent: '#ff7a59' } },
  { id: 'evergreen', name: 'Evergreen', note: 'Forest with copper', dark: true, preview: { bg: '#0b120f', panel: '#16211c', line: '#22302a', text: '#f1f5f2', accent: '#e0915a' } },
  { id: 'espresso', name: 'Espresso', note: 'Dark coffee with sky blue', dark: true, preview: { bg: '#140f0d', panel: '#241c18', line: '#342a25', text: '#f5f3f1', accent: '#7cc4ff' } },
  { id: 'bordeaux', name: 'Bordeaux', note: 'Dark wine with mint', dark: true, preview: { bg: '#150a0e', panel: '#26141a', line: '#34252a', text: '#f3ecee', accent: '#7fdcc0' } },
  { id: 'aubergine', name: 'Aubergine', note: 'Dark plum with lilac', dark: true, preview: { bg: '#120e19', panel: '#1f1829', line: '#2d2735', text: '#f1eff4', accent: '#b79cff' } },
];

const BAR_COLOR: Record<Concrete, string> = {
  light: '#ffffff',
  gilt: '#ffffff',
  paper: '#fbfbf8',
  ice: '#e9edf2',
  sand: '#f7f2e9',
  peach: '#fbe9de',
  rose: '#fbf4f2',
  butter: '#fbf3d6',
  sage: '#f1f3ec',
  mint: '#e6f4ee',
  sky: '#e6eff8',
  lavender: '#efeaf8',
  dark: '#1c1c1e',
  midnight: '#0a0a0c',
  bumblebee: '#0c0b09',
  obsidian: '#0b0b0e',
  graphite: '#141516',
  navy: '#0e1628',
  abyss: '#071419',
  cobalt: '#0c1236',
  fjord: '#1a1e26',
  lagoon: '#0b1c1e',
  evergreen: '#0f1714',
  espresso: '#1a1411',
  bordeaux: '#1c0e13',
  aubergine: '#17121f',
};
/** The dark ones (index.html repeats this list to paint the first frame). */
export const DARK_THEMES = THEMES.filter((t) => t.dark).map((t) => t.id);

/** The theme actually shown and whether it's dark. System (follow the Mac) → your light theme or your dark theme
 *  (Settings → Appearance; plain Light / Dark unless you picked others). */
export function resolveTheme(id: ThemeId, prefersDark: boolean, pair: { light: ThemeId; dark: ThemeId } = { light: 'light', dark: 'dark' }): { theme: Concrete; dark: boolean } {
  const pick = id === 'system' ? (prefersDark ? pair.dark : pair.light) : id;
  const theme: Concrete = pick === 'system' ? (prefersDark ? 'dark' : 'light') : pick;
  return { theme, dark: DARK_THEMES.includes(theme) };
}

/** Put the theme on <html> (styles.css does the rest) and colour the phone's status bar to match. */
export function applyTheme(id: ThemeId, pair?: { light: ThemeId; dark: ThemeId }) {
  const { theme, dark } = resolveTheme(id, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false, pair);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.mode = dark ? 'dark' : 'light';
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = BAR_COLOR[theme];
}
