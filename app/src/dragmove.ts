// Moving things by dragging them onto folders: items from the grid, folders
// from the sidebar tree, the pinned list and folder cards. Pointer based, so
// it works alongside files dropped in from Windows. Any element with
// data-drop="folder:<id>" or "folder:top" is a target.

export interface MoveDrag {
  /** Text next to the pointer, given the target under it (or null). */
  label: (target: string | null) => string;
  /** Can it go there? Targets that say no are not highlighted. */
  canDrop?: (target: string) => boolean;
  onDrop: (target: string) => void;
}

export function startMoveDrag(e: React.PointerEvent, opts: MoveDrag) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let active = false;
  let over: HTMLElement | null = null;
  let ghost: HTMLDivElement | null = null;
  const move = (ev: PointerEvent) => {
    if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 7) return;
    if (!active) {
      active = true;
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      document.body.appendChild(ghost);
      document.body.classList.add('dragging');
    }
    const hit = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-drop^="folder:"]') ?? null;
    const el = hit && (!opts.canDrop || opts.canDrop(hit.dataset.drop!)) ? hit : null;
    if (el !== over) {
      over?.classList.remove('drop-over');
      el?.classList.add('drop-over');
      over = el;
    }
    if (ghost) {
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY + 10}px`;
      ghost.textContent = opts.label(el?.dataset.drop ?? null);
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    over?.classList.remove('drop-over');
    ghost?.remove();
    document.body.classList.remove('dragging');
    if (active && over?.dataset.drop) opts.onDrop(over.dataset.drop);
    if (active) {
      // The end of a drag is not a click.
      const block = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', block, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', block, { capture: true }), 50);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** "folder:12" -> 12, "folder:top" -> null. */
export function targetFolder(target: string): number | null {
  return target === 'folder:top' ? null : Number(target.slice(7));
}
