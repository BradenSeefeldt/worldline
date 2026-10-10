// Drag a task or deadline from the sidebar onto the hour grid to block out time for it.
//   pick up  → a floating card lifts off the row and follows the pointer (DragGhost)
//   hover    → over the grid the card fades and the grid shows a 1-hour block in the slot
//   drop     → the grid creates the block; anywhere else the card glides back to its row
// The grid registers itself as a drop target, so the pieces don't need to know about each other.
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore, type BlockDrag } from '../data/store';
import { cls } from '../lib/format';

export interface DropTarget {
  hover: (x: number, y: number) => boolean; // is this point over the target?
  drop: (x: number, y: number, item: BlockDrag) => boolean; // true = handled
}
const targets = new Set<DropTarget>();
export function registerDropTarget(t: DropTarget) {
  targets.add(t);
  return () => {
    targets.delete(t);
  };
}

let lastDragEnd = 0;
/** True right after a drag ended, so the row's own click doesn't also open/close its card. */
export const justDragged = () => Date.now() - lastDragEnd < 350;

type Item = Pick<BlockDrag, 'kind' | 'id' | 'title'>;

/** Call from a sidebar row's onPointerDown. Mouse: drag after moving 5px. Touch: long-press first. */
export function startBlockDrag(e: ReactPointerEvent, item: Item) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select')) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const st = useStore.getState;
  const id = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const touch = e.pointerType === 'touch';
  let active = false;
  let timer = 0;

  const activate = (x: number, y: number) => {
    active = true;
    document.body.classList.add('dragging-block');
    st().setBlockDrag({ ...item, x, y, origin: { x: rect.left + 18, y: rect.top + rect.height / 2 }, over: false, phase: 'drag' });
    navigator.vibrate?.(8);
  };
  const cleanup = () => {
    clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('touchmove', noScroll);
    document.body.classList.remove('dragging-block');
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (!active) {
      const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (touch) {
        if (dist > 8) cleanup(); // it was a scroll
        return;
      }
      if (dist < 5) return;
      activate(ev.clientX, ev.clientY);
    }
    const cur = st().blockDrag;
    if (!cur) return;
    const over = [...targets].some((t) => t.hover(ev.clientX, ev.clientY));
    st().setBlockDrag({ ...cur, x: ev.clientX, y: ev.clientY, over });
  };
  const flyBack = () => {
    const cur = st().blockDrag;
    if (!cur) return;
    st().setBlockDrag({ ...cur, over: false, phase: 'return', x: cur.origin.x, y: cur.origin.y });
    window.setTimeout(() => st().blockDrag?.phase === 'return' && st().setBlockDrag(null), 280);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    cleanup();
    if (!active) return;
    lastDragEnd = Date.now();
    const cur = st().blockDrag;
    if (cur && [...targets].some((t) => t.drop(ev.clientX, ev.clientY, cur))) st().setBlockDrag(null);
    else flyBack();
  };
  const cancel = () => {
    cleanup();
    if (active) flyBack();
  };
  const noScroll = (ev: TouchEvent) => active && ev.preventDefault();

  if (touch) timer = window.setTimeout(() => activate(x0, y0), 350);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('touchmove', noScroll, { passive: false });
}

/** The floating card that follows the pointer while dragging. */
export function DragGhost() {
  const d = useStore((s) => s.blockDrag);
  if (!d) return null;
  return (
    <div className={cls('ghost', d.over && 'over', d.phase === 'return' && 'return')} style={{ transform: `translate(${d.x}px, ${d.y}px)` }} aria-hidden>
      <div className={cls('ghost-card', d.kind)}>
        <span className="ghost-icon">{d.kind === 'task' ? '☐' : '⚑'}</span>
        <span className="ghost-title">{d.kind === 'deadline' ? `Work on ${d.title}` : d.title}</span>
        <span className="ghost-hint">1 h</span>
      </div>
    </div>
  );
}
