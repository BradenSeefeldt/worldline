const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg {...base}>{dir === 'left' ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}</svg>
);
export const Plus = () => (
  <svg {...base}><path d="M12 5v14M5 12h14" /></svg>
);
export const SidebarIcon = () => (
  <svg {...base}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
);
export const Close = () => (
  <svg {...base}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const Trash = () => (
  <svg {...base} width={16} height={16}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" /></svg>
);
export const Sparkle = () => (
  <svg {...base} width={20} height={20}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z" /></svg>
);

/** The projects icon: three columns. */
export const ProjectGlyph = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
    <rect x="2" y="2.5" width="3.2" height="11" rx="1" />
    <rect x="6.4" y="2.5" width="3.2" height="7.5" rx="1" />
    <rect x="10.8" y="2.5" width="3.2" height="9.5" rx="1" />
  </svg>
);
