// Projects. Home is a board: one column per project, showing what needs doing — each thread with its next to-do or
// two (tick them right there), who you're waiting on, loose to-dos, pinned links, ideas. Click anything and its full
// page opens in a wide pane beside the board (one page at a time, with back / forward), so the board stays put.
// A page is a document you write in, plus dated notes. Everything on the board is read from what's written
// (lib/projects.ts), so there's nothing to keep up to date by hand.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { format, isSameDay, isSameYear } from 'date-fns';
import { CALENDAR_COLORS, useStore, type PaneView } from '../data/store';
import {
  ago, bestThreads, columnOf, familyOf, ideasOf, isEmptyDoc, isReady, isStale, latestLine, logOf, marksOf, openItems, search, span, statusOf,
  type LogEntry, type OpenItem, type Pin, type Project, type Thread, type World,
} from '../lib/projects';
import { cls } from '../lib/format';
import { useNow } from '../lib/hooks';
import { isApp, isLocalPath, openPath } from '../lib/platform';
import { DocEditor } from './ProjectEditor';

const newPinId = () => Math.random().toString(36).slice(2, 10);
const inField = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]');
const st = useStore.getState;
const open = (v: PaneView) => st().openPane(v);
const isUrl = (href: string) => /^https?:\/\//i.test(href);
const pageKind = (w: World, id: string): PaneView['k'] => (w.threads.some((t) => t.id === id) ? 'thread' : 'project');

// ---------------------------------------------------------------- small pieces
const svg = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);
const Ico = {
  link: svg(<path d="M6 3.5h6.5V10M12.2 3.8 4 12" />, 13),
  folder: svg(<path d="M2 4.5c0-.8.6-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.9 0-1.5-.7-1.5-1.5z" />, 13),
  back: svg(<path d="M10 3.5 5.5 8l4.5 4.5" />),
  fwd: svg(<path d="M6 3.5 10.5 8 6 12.5" />),
  crumb: svg(<path d="M6 3.5 10.5 8 6 12.5" />, 12),
  expand: svg(<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />, 14),
  shrink: svg(<path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" />, 14),
  close: svg(<path d="M4 4l8 8M12 4l-8 8" />),
  search: svg(<><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>, 15),
  spark: <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M8 2.5c.4 2.7 1.4 3.9 4.5 4.5-3.1.6-4.1 1.8-4.5 4.5-.4-2.7-1.4-3.9-4.5-4.5 3.1-.6 4.1-1.8 4.5-4.5z" fill="currentColor" /></svg>,
  chev: svg(<path d="M6 4l4 4-4 4" />, 12),
  plus: svg(<path d="M8 3.5v9M3.5 8h9" />, 13),
  arrow: svg(<path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" />, 13),
  trash: svg(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />, 13),
};

/** A textarea that grows with what's in it (titles, one-liners). */
function AutoText({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => el.clientWidth !== width && ((width = el.clientWidth), fit()));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      ref={ref} rows={1} className={cls('pj-auto', className)} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
    />
  );
}

/** A to-do shown away from where it was written: ticking it ticks it there. */
function Check({ x, note }: { x: OpenItem; note?: ReactNode }) {
  return (
    <label className={cls('pj-ck', x.who && 'wait', x.blockedBy && 'blocked')}>
      <input type="checkbox" className="pj-cb" checked={x.done} onChange={() => { st().setChecked(x.s, x.path, !x.done); st().showToast(`Done: ${x.text}`); }} />
      <span>{x.text}{x.who && <b className="pj-who"> @{x.who}</b>}{note && <small> {note}</small>}</span>
    </label>
  );
}

function PinLink({ pin, onRemove }: { pin: Pin; onRemove?: () => void }) {
  const remove = onRemove && (
    <span className="pj-pin-x" role="button" title="Unpin" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}>×</span>
  );
  if (isUrl(pin.href))
    return <a className="pj-pin" href={pin.href} target="_blank" rel="noopener noreferrer" title={pin.href}>{Ico.link}<span>{pin.label}</span>{remove}</a>;
  // a folder on this Mac opens in Finder (in the app); anything else (cluster:~/runs, or in a browser) is copied
  const local = isApp() && isLocalPath(pin.href);
  return (
    <button
      className="pj-pin" title={local ? `Open ${pin.href} in Finder` : `Copy ${pin.href}`}
      onClick={() => void openPath(pin.href).then((how) => how === 'copied' && st().showToast(`Copied ${pin.href}`, false), () => st().showToast(`Couldn't open ${pin.href}`, false))}
    >
      {Ico.folder}<span>{pin.label}</span>{remove}
    </button>
  );
}

const noteDate = (t: number, now: number) => (isSameDay(t, now) ? 'Today' : isSameDay(t, now - 86_400_000) ? 'Yesterday' : format(t, isSameYear(t, now) ? 'MMM d' : 'MMM d, yyyy'));
const dots = (...xs: (string | number | false | undefined)[]) => xs.filter(Boolean).map((z) => `· ${z}`).join(' ');

// ---------------------------------------------------------------- the page
export function ProjectsPage() {
  const projects = useStore((s) => s.projects);
  const threads = useStore((s) => s.threads);
  const projectLog = useStore((s) => s.projectLog);
  const nav = useStore((s) => s.projectNav);
  const w: World = useMemo(() => ({ projects, threads, projectLog }), [projects, threads, projectLog]);
  const view = nav.hist[nav.i] ?? null;
  const now = useNow(60_000);
  const [full, setFull] = useState(false);
  const [newProject, setNewProject] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const live = projects.filter((p) => !p.archived);
  // Dragging a column by its head: the board reorders live as you move, and the drop is one undo step.
  // (Pointer events rather than the browser's drag-and-drop, which is unreliable when the drag starts on a button.)
  const [drag, setDrag] = useState<{ id: string; order: string[] } | null>(null);
  const justDragged = useRef(false);
  const shown = drag ? drag.order.map((id) => live.find((p) => p.id === id)!).filter(Boolean) : live;
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('a, input')) return;
    const x0 = e.clientX, y0 = e.clientY, board = boardRef.current!;
    let order: string[] | null = null;
    let tick = 0;
    const move = (ev: PointerEvent) => {
      if (!order) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        order = live.map((p) => p.id);
        document.body.classList.add('pj-dragging');
      }
      // where it would land: before the first other column whose middle is right of the pointer
      const others = [...board.querySelectorAll<HTMLElement>('[data-col]')].filter((c) => c.dataset.col !== id);
      const before = others.find((c) => { const r = c.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; });
      const rest = order.filter((x) => x !== id);
      const at = before ? rest.indexOf(before.dataset.col!) : rest.length;
      const next = [...rest.slice(0, at), id, ...rest.slice(at)];
      if (next.join() !== order.join() || !tick) setDrag({ id, order: next });
      order = next;
      tick++;
      // near the board's edges: scroll it
      const r = board.getBoundingClientRect();
      if (ev.clientX < r.left + 50) board.scrollLeft -= 18;
      else if (ev.clientX > r.right - 50) board.scrollLeft += 18;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('pj-dragging');
      if (order) {
        st().reorderProjects(order);
        justDragged.current = true; // the click that ends a drag isn't a click on the name
        setTimeout(() => (justDragged.current = false), 0);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const archived = projects.filter((p) => p.archived);
  // a page that no longer exists (deleted, undone): back to the board
  const gone = !!view && (view.k === 'thread' ? !threads.some((t) => t.id === view.id) : view.k === 'project' ? !projects.some((p) => p.id === view.id) : false);
  useEffect(() => { if (gone) st().closePane(); }, [gone]);
  useEffect(() => { if (!view) setFull(false); }, [view]);
  // The board wants the width: tuck the calendar's sidebar away here, and bring it back on leaving.
  useEffect(() => {
    const was = st().sidebarOpen;
    if (was) st().setSidebarOpen(false);
    return () => { if (was) st().setSidebarOpen(true); };
  }, []);

  // keep the open page's project in view beside the pane
  const pid = view?.k === 'project' ? view.id : view?.k === 'thread' ? threads.find((t) => t.id === view.id)?.projectId : undefined;
  useEffect(() => {
    const board = boardRef.current, col = pid && board?.querySelector<HTMLElement>(`[data-col="${pid}"]`);
    if (!board || !col) return;
    const b = board.getBoundingClientRect(), c = col.getBoundingClientRect();
    // already fully in view: leave the board alone; otherwise bring the column's left edge in (never cut it off)
    if (c.left < b.left || c.right > b.right) board.scrollTo({ left: board.scrollLeft + c.left - b.left - 22, behavior: 'smooth' });
  }, [pid, nav.i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === '[') { e.preventDefault(); st().stepPane(-1); }
      else if (mod && e.key === ']') { e.preventDefault(); st().stepPane(1); }
      else if (mod && e.key === '.') { e.preventDefault(); setFull((f) => !f); }
      else if (inField(e.target)) return;
      else if (e.key === 'Escape') st().closePane();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const createProject = () => {
    const title = (newProject ?? '').trim();
    setNewProject(null);
    if (!title) return;
    const color = CALENDAR_COLORS.find((c) => !projects.some((p) => p.color === c)) ?? CALENDAR_COLORS[projects.length % CALENDAR_COLORS.length];
    open({ k: 'project', id: st().addProject(title, color) });
  };

  return (
    <div
      className={cls('pj', view && full && 'full')}
      onClick={(e) => view && !(e.target as HTMLElement).closest('.pj-pane, button, a, input, textarea, select, label, .pj-tile, .pj-idea') && st().closePane()}
    >
      <div className="pj-body">
        <div className="pj-board" ref={boardRef}>
          {shown.map((p) => (
            <Column
              key={p.id} p={p} w={w} view={view} now={now} dragging={drag?.id === p.id}
              onHeadDown={(e) => startDrag(e, p.id)}
              onHeadClickCapture={(e) => { if (justDragged.current) { e.stopPropagation(); e.preventDefault(); } }}
            />
          ))}
          <div className="pj-newcol">
            {newProject === null ? (
              <button className="pj-newcol-btn" onClick={() => setNewProject('')}>{Ico.plus} New project</button>
            ) : (
              <input
                autoFocus className="pj-input" placeholder="Project name" value={newProject} onChange={(e) => setNewProject(e.target.value)}
                onKeyDown={(e) => (e.key === 'Enter' ? createProject() : e.key === 'Escape' ? (e.stopPropagation(), setNewProject(null)) : undefined)}
                onBlur={createProject}
              />
            )}
            {archived.length > 0 && (
              <>
                <button className={cls('pj-fold', showArchived && 'open')} onClick={() => setShowArchived(!showArchived)}>{Ico.chev} Archived · {archived.length}</button>
                {showArchived && archived.map((p) => (
                  <button key={p.id} className="pj-arch" style={{ '--c': p.color } as CSSProperties} onClick={() => open({ k: 'project', id: p.id })}><i className="pj-dot" />{p.title}</button>
                ))}
              </>
            )}
          </div>
        </div>
        {view && !gone && <Pane view={view} w={w} now={now} full={full} setFull={setFull} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a project's column
const IDEAS_SHOWN = 5;

/** A one-line box at the top of a list: type, Enter adds (and it stays ready for the next one). */
function AddRow({ icon, placeholder, onAdd, spark }: { icon: ReactNode; placeholder: string; onAdd: (text: string) => void; spark?: boolean }) {
  const [v, setV] = useState('');
  return (
    <label className="pj-jot">
      <span className={spark ? 'pj-spark' : 'pj-jot-ic'}>{icon}</span>
      <input
        placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && v.trim()) {
            onAdd(v.trim());
            setV('');
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setV('');
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
function Column({ p, w, view, now, dragging, onHeadDown, onHeadClickCapture }: {
  p: Project; w: World; view: PaneView | null; now: number; dragging: boolean;
  onHeadDown: (e: React.PointerEvent) => void; onHeadClickCapture: (e: React.MouseEvent) => void;
}) {
  const col = useMemo(() => columnOf(w, p.id, now), [w, p.id, now]);
  const loose = useMemo(() => openItems(w, p.id).filter((x) => !x.blockedBy), [w, p.id]);
  const ideas = useMemo(() => ideasOf(w, p.id), [w, p.id]);
  const [showIdeas, setShowIdeas] = useState(true);
  const [allIdeas, setAllIdeas] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const openThread = view?.k === 'thread' ? view.id : null;
  const onCol = view?.k === 'project' ? view.id === p.id : !!openThread && w.threads.some((t) => t.id === openThread && t.projectId === p.id);
  return (
    <section className={cls('pj-col', onCol && 'on', dragging && 'dragging')} data-col={p.id} style={{ '--c': p.color } as CSSProperties}>
      <div className="pj-col-head" onPointerDown={onHeadDown} onClickCapture={onHeadClickCapture} title="Drag to reorder">
        <button className="pj-col-title" onClick={() => open({ k: 'project', id: p.id })}>{p.title}</button>
        {p.about && <p className="pj-col-about">{p.about}</p>}
      </div>
      <div className="pj-col-rule" />
      {!!p.pins?.length && <div className="pj-pins">{p.pins.map((x) => <PinLink key={x.id} pin={x} />)}</div>}
      <div className="pj-label">To do</div>
      <AddRow icon={Ico.plus} placeholder="Add a to-do…" onAdd={(text) => st().addTodo(p.id, text)} />
      {loose.length > 0 && <div className="pj-loose">{loose.map((x) => <LooseItem key={`${x.s.entry ?? 'body'}:${x.path.join('.')}`} x={x} w={w} projectId={p.id} now={now} />)}</div>}
      <div className="pj-label">Threads</div>
      <AddRow icon={Ico.plus} placeholder="Add a thread…" onAdd={(title) => open({ k: 'thread', id: st().addThread(p.id, title) })} />
      {col.live.map((t) => <Tile key={t.id} t={t} w={w} now={now} on={t.id === openThread} />)}
      {!col.live.length && <p className="pj-empty">Nothing on the go.</p>}
      <button className={cls('pj-label pj-label-fold', showIdeas && 'open')} onClick={() => setShowIdeas(!showIdeas)}>Ideas · {ideas.length} {Ico.chev}</button>
      {showIdeas && (
        <>
          <AddRow icon={Ico.spark} spark placeholder="Jot an idea…" onAdd={(text) => st().addIdea(p.id, text)} />
          {(allIdeas ? ideas : ideas.slice(0, IDEAS_SHOWN)).map((x, i) => (
            <div key={x.idea?.id ?? `m${i}`} className="pj-idea">
              <span className="pj-spark">{Ico.spark}</span>
              <span className="pj-idea-text">{x.text}</span>
              <button className="pj-idea-go" onClick={() => { open({ k: 'thread', id: st().startIdea(p.id, x) }); st().showToast('Started — it’s a thread now'); }}>Start →</button>
              {x.idea && <button className="pj-x" onClick={() => st().removeIdea(p.id, x.idea!.id)} title="Remove" aria-label="Remove idea">×</button>}
            </div>
          ))}
          {ideas.length > IDEAS_SHOWN && <button className="pj-more pj-more-btn" onClick={() => setAllIdeas(!allIdeas)}>{allIdeas ? 'Show fewer' : `+${ideas.length - IDEAS_SHOWN} more`}</button>}
        </>
      )}
      {col.done.length > 0 && (
        <>
          <button className={cls('pj-fold', showDone && 'open')} onClick={() => setShowDone(!showDone)}>{Ico.chev} Done · {col.done.length}</button>
          {showDone && col.done.map((t) => (
            <button key={t.id} className="pj-done" onClick={() => open({ k: 'thread', id: t.id })}><i className="pj-st done" />{t.title}</button>
          ))}
        </>
      )}
      <div className="pj-col-foot">
        <span />
        <button onClick={() => open({ k: 'project', id: p.id })}>Project page {Ico.arrow}</button>
      </div>
    </section>
  );
}

/** A to-do on the project itself: tick it, or file it into a thread — drag it onto one, or pick from the menu
 *  (likeliest thread first: the one whose title shares the most words with it). */
function LooseItem({ x, w, projectId, now }: { x: OpenItem; w: World; projectId: string; now: number }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ranked = useMemo(() => (menu ? bestThreads(w, projectId, x.text) : []), [menu, w, projectId, x.text]);
  useEffect(() => {
    if (!menu) return;
    const off = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, [menu]);
  const file = (id: string, title: string) => {
    setMenu(false);
    st().moveItem(x.s, x.path, id);
    st().showToast(`Moved to “${title}”`);
  };
  return (
    <div ref={ref} className={cls('pj-loose-item', menu && 'menu-open')} onPointerDown={(e) => startItemDrag(e, x)} onClickCapture={swallowClickAfterDrag}>
      <Check x={x} note={x.who && x.s.at ? dots(span(x.s.at, now)) : undefined} />
      <button className="pj-file-btn" onClick={() => setMenu(!menu)} title="File into a thread (or drag it onto one)" aria-label="File into a thread">{Ico.arrow}</button>
      {menu && (
        <div className="pj-file-menu" role="menu">
          <div className="pj-file-k">Move to thread</div>
          {ranked.map(({ t, score }, i) => (
            <button key={t.id} role="menuitem" className={cls(i === 0 && score > 0 && 'best')} onClick={() => file(t.id, t.title)}>
              <span>{t.title}</span>{i === 0 && score > 0 && <small>likely</small>}
            </button>
          ))}
          {!ranked.length && <div className="pj-none">No active threads here yet.</div>}
        </div>
      )}
    </div>
  );
}

// Dragging a to-do onto a thread tile (pointer events: a little card follows the pointer; the tile under it lights up).
let draggedJust = false;
const swallowClickAfterDrag = (e: React.MouseEvent) => {
  if (draggedJust) {
    e.preventDefault();
    e.stopPropagation();
  }
};
function startItemDrag(e: React.PointerEvent, x: OpenItem) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('input, button')) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let over: HTMLElement | null = null;
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      ghost = document.createElement('div');
      ghost.className = 'pj-drag-ghost';
      ghost.textContent = x.text;
      document.body.appendChild(ghost);
      document.body.classList.add('pj-dragging');
    }
    ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
    const tile = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-thread]') ?? null;
    if (tile !== over) {
      over?.classList.remove('drop');
      tile?.classList.add('drop');
      over = tile;
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('pj-dragging');
    ghost?.remove();
    over?.classList.remove('drop');
    if (!ghost) return;
    draggedJust = true;
    setTimeout(() => (draggedJust = false), 0);
    const id = over?.dataset.thread;
    const t = id && st().threads.find((y) => y.id === id);
    if (t) {
      st().moveItem(x.s, x.path, t.id);
      st().showToast(`Moved to “${t.title}”`);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** A thread on the board: its name, then the next thing or two to do — or who it's waiting on. */
function Tile({ t, w, now, on }: { t: Thread; w: World; now: number; on: boolean }) {
  const s = statusOf(w, t);
  const items = openItems(w, t.id);
  // newest action items first (a meeting's, filed today), then the plan in the page itself
  const ready = items.filter(isReady).sort((a, b) => (b.s.at ?? -1) - (a.s.at ?? -1));
  const theirs = items.filter((x) => x.who);
  const quiet = isStale(t, now);
  const shown = ready.slice(0, 2);
  const line = !ready.length && !theirs.length ? latestLine(w, t.id) : '';
  return (
    <div className={cls('pj-tile', quiet && 'quiet', on && 'on')} data-thread={t.id} onClick={(e) => !(e.target as HTMLElement).closest('label, button, a') && open({ k: 'thread', id: t.id })}>
      <button className="pj-tile-title" onClick={() => open({ k: 'thread', id: t.id })}>
        <i className={cls('pj-st', s.kind)} />
        <span>{t.title}</span>
        <span className="pj-ago">{quiet ? 'quiet' : ago(t.updatedAt, now)}</span>
      </button>
      {(shown.length > 0 || theirs.length > 0) && (
        <div className="pj-tile-items">
          {shown.map((x, i) => <Check key={`r${i}`} x={x} />)}
          {theirs.slice(0, ready.length ? 1 : 2).map((x, i) => {
            const after = items.filter((b) => b.blockedBy === x.text).length;
            return <Check key={`w${i}`} x={x} note={dots(x.s.at && span(x.s.at, now), after > 0 && `then ${after} more`)} />;
          })}
        </div>
      )}
      {ready.length > shown.length && <div className="pj-more">+{ready.length - shown.length} more</div>}
      {line && <div className="pj-last">{line}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- the pane beside the board
function Pane({ view, w, now, full, setFull }: { view: PaneView; w: World; now: number; full: boolean; setFull: (f: boolean) => void }) {
  const nav = useStore((s) => s.projectNav);
  const scroller = useRef<HTMLDivElement>(null);
  const key = `${view.k}:${view.id ?? ''}`;
  useEffect(() => { scroller.current?.scrollTo(0, 0); }, [key]);
  const thread = view.k === 'thread' ? w.threads.find((t) => t.id === view.id) : undefined;
  const project = view.k === 'project' ? w.projects.find((p) => p.id === view.id) : undefined;
  const parent = thread && w.projects.find((p) => p.id === thread.projectId);
  return (
    <aside className="pj-pane">
      <div className="pj-pbar">
        <button className="pj-ibtn" disabled={nav.i <= 0} onClick={() => st().stepPane(-1)} title="Back (⌘[)" aria-label="Back">{Ico.back}</button>
        <button className="pj-ibtn" disabled={nav.i >= nav.hist.length - 1} onClick={() => st().stepPane(1)} title="Forward (⌘])" aria-label="Forward">{Ico.fwd}</button>
        <div className="pj-crumbs">
          {thread && parent ? (
            <>
              <button onClick={() => open({ k: 'project', id: parent.id })}>{parent.title}</button>
              {Ico.crumb}
              <b>{thread.title}</b>
            </>
          ) : (
            <b>{project?.title ?? (view.k === 'waiting' ? 'Waiting on others' : 'Search')}</b>
          )}
        </div>
        <button className="pj-ibtn" onClick={() => setFull(!full)} title={full ? 'Show the board (⌘.)' : 'Full width, for long writing (⌘.)'} aria-label="Toggle full width">{full ? Ico.shrink : Ico.expand}</button>
        <button className="pj-ibtn" onClick={() => st().closePane()} title="Close (Esc)" aria-label="Close">{Ico.close}</button>
      </div>
      <div className="pj-pscroll" ref={scroller}>
        {thread ? <ThreadPage key={thread.id} t={thread} w={w} now={now} />
          : project ? <ProjectPage key={project.id} p={project} w={w} now={now} />
          : view.k === 'waiting' ? <WaitingPage w={w} now={now} />
          : <SearchPage w={w} q={view.q ?? ''} pid={view.pid} now={now} />}
      </div>
    </aside>
  );
}

/** A page's dated notes: a roomy box for today's (start typing and it's saved), then earlier ones, newest first. */
function Notebook({ parentId, log, now, placeholder }: { parentId: string; log: LogEntry[]; now: number; placeholder: string }) {
  const entries = useMemo(() => logOf(log, parentId), [log, parentId]);
  const today = entries.find((e) => isSameDay(e.at, now));
  return (
    <>
      <div className="pj-h">Notes</div>
      <TodayNote key={parentId} parentId={parentId} entry={today} placeholder={placeholder} />
      {entries.filter((e) => e !== today).map((e) => (
        <div key={e.id} className="pj-note">
          <div className="pj-when">{noteDate(e.at, now)}</div>
          <DocEditor doc={e.doc} onChange={(d) => st().updateLog(e.id, d)} className="pj-doc-note" />
          <button className="pj-x pj-note-x" onClick={() => st().deleteLog(e.id)} title="Delete note" aria-label="Delete note">×</button>
        </div>
      ))}
    </>
  );
}
function TodayNote({ parentId, entry, placeholder }: { parentId: string; entry?: LogEntry; placeholder: string }) {
  const made = useRef<string | null>(entry?.id ?? null);
  if (entry) made.current = entry.id;
  return (
    <div className="pj-compose">
      <div className="pj-compose-k">Today</div>
      <DocEditor
        doc={entry?.doc} placeholder={placeholder} className="pj-doc-note"
        onChange={(d) => {
          if (made.current && st().projectLog.some((e) => e.id === made.current)) st().updateLog(made.current, d);
          else if (!isEmptyDoc(d)) made.current = st().addLog(parentId, d); // the first words make today's note
        }}
        onBlur={() => {
          const e = st().projectLog.find((x) => x.id === made.current);
          if (e && isEmptyDoc(e.doc)) {
            st().deleteLog(e.id);
            made.current = null;
          }
        }}
      />
    </div>
  );
}

const HINT = (
  <p className="pj-hint">
    <kbd>#</kbd> <kbd>##</kbd> <kbd>###</kbd> headings · <kbd>-</kbd> <kbd>1.</kbd> lists · <kbd>**bold**</kbd> · <kbd>$x$</kbd> maths ·
    <kbd>[]</kbd> to-do · <kbd>Tab</kbd> it waits on the one above · <kbd>@Name</kbd> someone else's ·
    a paragraph starting <kbd>Idea:</kbd> <kbd>Decided:</kbd> or <kbd>Q:</kbd> is collected
  </p>
);

function ThreadPage({ t, w, now }: { t: Thread; w: World; now: number }) {
  const p = w.projects.find((x) => x.id === t.projectId);
  const s = statusOf(w, t);
  const items = openItems(w, t.id);
  const fromNotes = items.filter((x) => isReady(x) && x.s.entry);
  const theirs = items.filter((x) => x.who);
  const qs = marksOf(w, t.id).filter((m) => m.kind === 'q' && !m.resolved);
  const up = (patch: Partial<Thread>, typing = false) => st().updateThread(t.id, patch, typing);
  return (
    <div className="pj-page with-margin" style={{ '--c': p?.color } as CSSProperties}>
      <article>
        {p && <button className="pj-kicker" onClick={() => open({ k: 'project', id: p.id })}><i className="pj-dot" />{p.title}</button>}
        <AutoText className="pj-title" value={t.title} onChange={(v) => up({ title: v.replace(/\n/g, ' ') }, true)} placeholder="Thread name" />
        <div className="pj-meta">
          <span className="seg pj-seg">
            {(['active', 'done'] as const).map((k) => (
              <button key={k} className={cls(t.status === k && 'on')} onClick={() => up({ status: k })}>{k === 'active' ? 'Active' : 'Done'}</button>
            ))}
          </span>
          {s.kind === 'waiting' && <span className="pj-pill">Waiting on {s.who}</span>}
          <span>Edited {ago(t.updatedAt, now)}</span>
        </div>
        <div className="pj-rule" />
        {(fromNotes.length > 0 || theirs.length > 0 || qs.length > 0) && (
          <aside className="pj-margin">
            {fromNotes.length > 0 && <div><div className="pj-mh">From the notes · {fromNotes.length}</div>{fromNotes.map((x, i) => <Check key={i} x={x} note={x.s.at && dots(noteDate(x.s.at, now))} />)}</div>}
            {theirs.length > 0 && <div><div className="pj-mh">Waiting on</div>{theirs.map((x, i) => <Check key={i} x={x} note={x.s.at && dots(span(x.s.at, now))} />)}</div>}
            {qs.length > 0 && <div><div className="pj-mh">Still to settle</div>{qs.map((q, i) => <div key={i} className="pj-mrow">{q.text}</div>)}</div>}
          </aside>
        )}
        <DocEditor doc={t.body} onChange={(d) => up({ body: d }, true)} placeholder="What this is, the plan, the draft… Type [] for a to-do." className="pj-doc-body" />
        <Notebook parentId={t.id} log={w.projectLog} now={now} placeholder="Write a note — a meeting, a result, a decision." />
        {HINT}
        <div className="pj-foot">
          <label className="pj-move">
            Project
            <select value={t.projectId} onChange={(e) => up({ projectId: e.target.value })}>
              {w.projects.filter((x) => !x.archived || x.id === t.projectId).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </label>
          <button className="pj-del" onClick={() => st().deleteThread(t.id)}>{Ico.trash} Delete thread</button>
        </div>
      </article>
    </div>
  );
}

function PinAdder({ projectId }: { projectId: string }) {
  const [href, setHref] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const add = () => {
    const h = (href ?? '').trim();
    if (h) {
      const p = st().projects.find((x) => x.id === projectId);
      const name = label.trim() || (isUrl(h) ? h.replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0] : h.split('/').filter(Boolean).pop() ?? h);
      st().updateProject(projectId, { pins: [...(p?.pins ?? []), { id: newPinId(), label: name, href: h }] });
    }
    setHref(null);
    setLabel('');
  };
  if (href === null) return <button className="pj-pin add" onClick={() => setHref('')}>{Ico.plus} Pin a link or folder</button>;
  return (
    <span className="pj-pin-form" onKeyDown={(e) => (e.key === 'Enter' ? add() : e.key === 'Escape' ? (e.stopPropagation(), setHref(null)) : undefined)}>
      <input autoFocus className="pj-input" placeholder="https://… or ~/path/to/folder" value={href} onChange={(e) => setHref(e.target.value)} />
      <input className="pj-input" placeholder="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <button className="pj-btn" onClick={add}>Pin</button>
      <button className="pj-btn ghost" onClick={() => setHref(null)}>Cancel</button>
    </span>
  );
}

function ProjectPage({ p, w, now }: { p: Project; w: World; now: number }) {
  const fam = familyOf(w, p.id);
  const items = fam.flatMap((id) => openItems(w, id));
  const theirs = items.filter((x) => x.who);
  const marks = fam.flatMap((id) => marksOf(w, id));
  const qs = marks.filter((m) => m.kind === 'q' && !m.resolved);
  const decided = marks.filter((m) => m.kind === 'decided').sort((a, b) => (b.s.at ?? 0) - (a.s.at ?? 0));
  const threadName = (id: string) => w.threads.find((t) => t.id === id)?.title;
  const up = (patch: Partial<Project>, typing = false) => st().updateProject(p.id, patch, typing);
  return (
    <div className="pj-page" style={{ '--c': p.color } as CSSProperties}>
      <article>
        <div className="pj-kicker static"><i className="pj-dot" />Project{p.archived ? ' · archived' : ''}</div>
        <AutoText className="pj-title" value={p.title} onChange={(v) => up({ title: v.replace(/\n/g, ' ') }, true)} placeholder="Project name" />
        <AutoText className="pj-sub" value={p.about ?? ''} onChange={(v) => up({ about: v.replace(/\n/g, ' ') }, true)} placeholder="One line: what this project is." />
        <div className="pj-rule" />
        <div className="pj-pins page">
          {(p.pins ?? []).map((x) => <PinLink key={x.id} pin={x} onRemove={() => up({ pins: (p.pins ?? []).filter((y) => y.id !== x.id) })} />)}
          <PinAdder projectId={p.id} />
        </div>
        {(theirs.length > 0 || qs.length > 0 || decided.length > 0) && (
          <div className="pj-catch">
            <div>
              <div className="pj-mh">Waiting on others · {theirs.length}</div>
              {theirs.map((x, i) => {
                const after = items.filter((b) => b.blockedBy === x.text && b.s.owner === x.s.owner);
                return (
                  <div key={i}>
                    <Check x={x} note={dots(threadName(x.s.owner), x.s.at && span(x.s.at, now))} />
                    {after.length > 0 && <div className="pj-then">then: {after.map((b) => b.text).join(' · ')}</div>}
                  </div>
                );
              })}
              {!theirs.length && <div className="pj-none">No one owes you anything.</div>}
            </div>
            <div>
              <div className="pj-mh">Still to settle · {qs.length}</div>
              {qs.map((q, i) => (
                <div key={i} className="pj-mrow">{q.text}<button className="pj-act" onClick={() => st().setResolved(q.s, q.path, true)}>Settled</button></div>
              ))}
              {!qs.length && <div className="pj-none">Nothing open.</div>}
              {decided.length > 0 && (
                <>
                  <div className="pj-mh pj-mh-gap">Decided</div>
                  {decided.slice(0, 5).map((d, i) => <div key={i} className="pj-mrow">{d.text}{d.s.at && <small> · {noteDate(d.s.at, now)}</small>}</div>)}
                </>
              )}
            </div>
          </div>
        )}
        <div className="pj-h">Overview</div>
        <DocEditor doc={p.doc} onChange={(d) => up({ doc: d }, true)} placeholder="The big picture: plan, outline, loose to-dos ([] …), who's involved…" className="pj-doc-body" />
        <Notebook parentId={p.id} log={w.projectLog} now={now} placeholder="Write a note — a meeting, a decision, a thought." />
        {HINT}
        <div className="pj-foot">
          <div className="pj-colors" role="radiogroup" aria-label="Colour">
            {CALENDAR_COLORS.map((c) => <button key={c} className={cls('pj-swatch', c === p.color && 'on')} style={{ '--s': c } as CSSProperties} onClick={() => up({ color: c })} aria-label={c} />)}
          </div>
          <span className="pj-foot-r">
            <button className="pj-btn" onClick={() => up({ archived: !p.archived })}>{p.archived ? 'Unarchive' : 'Archive'}</button>
            <button className="pj-del" onClick={() => confirm(`Delete “${p.title}” with all its threads and notes? (⌘Z undoes it.)`) && st().deleteProject(p.id)}>{Ico.trash} Delete</button>
          </span>
        </div>
      </article>
    </div>
  );
}

function WaitingPage({ w, now }: { w: World; now: number }) {
  const ids = [...w.projects.filter((p) => !p.archived).map((p) => p.id), ...w.threads.filter((t) => t.status === 'active').map((t) => t.id)];
  const all = ids.flatMap((id) => openItems(w, id));
  const byWho = new Map<string, OpenItem[]>();
  for (const x of all) if (x.who) byWho.set(x.who, [...(byWho.get(x.who) ?? []), x]);
  const title = (id: string) => (w.threads.find((t) => t.id === id) ?? w.projects.find((p) => p.id === id))?.title;
  const colorOf = (id: string) => w.projects.find((p) => p.id === (w.threads.find((t) => t.id === id)?.projectId ?? id))?.color;
  return (
    <div className="pj-page" style={{ '--c': 'var(--warn)' } as CSSProperties}>
      <article>
        <h2 className="pj-title static">Waiting on others</h2>
        <p className="pj-sub static">Every open to-do with an <b className="pj-who">@name</b> in it, wherever you wrote it: your list of what to chase.</p>
        <div className="pj-rule" />
        {[...byWho].map(([name, xs]) => (
          <div key={name} className="pj-person">
            <h3>{name}</h3>
            {xs.map((x, i) => {
              const after = all.filter((b) => b.blockedBy === x.text && b.s.owner === x.s.owner);
              return (
                <div key={i} style={{ '--c': colorOf(x.s.owner) } as CSSProperties}>
                  <Check x={x} note={<button className="pj-link" onClick={(e) => { e.preventDefault(); open({ k: pageKind(w, x.s.owner), id: x.s.owner }); }}>{dots(title(x.s.owner), x.s.at && span(x.s.at, now))}</button>} />
                  {after.length > 0 && <div className="pj-then">then you: {after.map((b) => b.text).join(' · ')}</div>}
                </div>
              );
            })}
          </div>
        ))}
        {!byWho.size && <p className="pj-none">Nobody owes you anything right now. Write <b className="pj-who">@Name</b> in a to-do to track it here.</p>}
      </article>
    </div>
  );
}

function SearchPage({ w, q, pid, now }: { w: World; q: string; pid?: string; now: number }) {
  const hits = useMemo(() => search(w, q, pid), [w, q, pid]);
  const scope = pid && w.projects.find((p) => p.id === pid);
  const needle = q.trim().toLowerCase();
  const mark = (text: string) => {
    const i = text.toLowerCase().indexOf(needle);
    return i < 0 ? text : <>{text.slice(0, i)}<mark>{text.slice(i, i + needle.length)}</mark>{text.slice(i + needle.length)}</>;
  };
  return (
    <div className="pj-page" style={{ '--c': 'var(--focus)' } as CSSProperties}>
      <article>
        <h2 className="pj-title static">“{q}”</h2>
        <p className="pj-sub static">{hits.length} result{hits.length === 1 ? '' : 's'}{scope ? ` in ${scope.title}` : ' in all projects'}</p>
        <div className="pj-rule" />
        {hits.map((h, i) => (
          <button key={i} className="pj-hit" onClick={() => open({ k: pageKind(w, h.owner), id: h.owner })}>
            <b>{h.label}{h.at && <span> · {noteDate(h.at, now)}</span>}</b>
            <span>{mark(h.snippet)}</span>
          </button>
        ))}
      </article>
    </div>
  );
}
