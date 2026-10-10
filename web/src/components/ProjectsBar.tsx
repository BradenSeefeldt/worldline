// The toolbar on the Projects tab: a wide search (everything, or one project) and "Waiting on others".
// It lives in the toolbar, not on the page, so the board gets the full height.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type PaneView } from '../data/store';
import { openItems } from '../lib/projects';
import { cls } from '../lib/format';

export function ProjectsBar() {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const projectLog = useStore((s) => s.projectLog);
  const nav = useStore((s) => s.projectNav);
  const view: PaneView | null = nav.hist[nav.i] ?? null;
  const search = view?.k === 'search' ? view : null;
  const input = useRef<HTMLInputElement>(null);
  // which project to search: the open search's, or the one picked before typing
  const [picked, setPicked] = useState('');
  const scope = search ? search.pid ?? '' : picked;
  const owed = useMemo(() => {
    const w = { projects, threads, projectLog };
    const ids = [...projects.filter((p) => !p.archived).map((p) => p.id), ...threads.filter((t) => t.status === 'active').map((t) => t.id)];
    return ids.flatMap((id) => openItems(w, id)).filter((x) => x.who).length;
  }, [projects, threads, projectLog]);

  // "/" jumps to the search box (when you're not typing somewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Typing refines the open search rather than piling up history. */
  const setSearch = (q: string, pid: string) => {
    const st = useStore.getState();
    const { hist, i } = st.projectNav;
    const v: PaneView = { k: 'search', q, ...(pid ? { pid } : {}) };
    if (!q) return void (hist[i]?.k === 'search' && st.stepPane(-1));
    if (hist[i]?.k === 'search') useStore.setState({ projectNav: { hist: hist.map((x, k) => (k === i ? v : x)), i } });
    else st.openPane(v);
  };
  const live = projects.filter((p) => !p.archived);
  return (
    <>
      <div className="pjb-search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
        <span className="pjb-scope-wrap">
        <select
          className={cls('pjb-scope', scope && 'on')} aria-label="Search in" value={scope}
          onChange={(e) => {
            setPicked(e.target.value);
            if (search) setSearch(search.q ?? '', e.target.value);
            input.current?.focus();
          }}
        >
          <option value="">All projects</option>
          {live.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 3.5 5 6.5 8 3.5" /></svg>
        </span>
        <input
          ref={input} placeholder="Search notes, pages, ideas and pins" value={search?.q ?? ''}
          onChange={(e) => setSearch(e.target.value, scope)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              e.currentTarget.blur();
              if (search) useStore.getState().closePane();
            }
          }}
        />
        <kbd>/</kbd>
      </div>
      <button className={cls('pjb-wait', view?.k === 'waiting' && 'on')} onClick={() => useStore.getState().openPane({ k: 'waiting' })}>
        Waiting on others <span className={cls('pj-badge', owed === 0 && 'clear')}>{owed}</span>
      </button>
    </>
  );
}
