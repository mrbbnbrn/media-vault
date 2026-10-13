// Thumbnail grid that only draws the rows on screen, so 10,000+ items scroll
// smoothly. Click to select (Ctrl/Shift for more), double-click to open, and
// drag a selection onto any folder to move it there.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { thumbUrl, type Item } from '../api';
import { formatTime, onThumb } from '../media';
import { BrokenIcon, HeartIcon } from './Icons';

const GAP = 10;

export function MediaGrid(props: {
  items: Item[];
  tile: number;
  selected: Set<number>;
  onSelect: (sel: Set<number>, anchor: number | null) => void;
  anchor: number | null;
  onOpen: (item: Item) => void;
  onDropOnFolder: (ids: number[], target: string) => void;
  scroller: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [range, setRange] = useState({ from: 0, to: 40 });
  const [ready, setReady] = useState<Set<number>>(new Set());
  const [drag, setDrag] = useState<{ x: number; y: number; n: number; over: string | null } | null>(null);

  useEffect(() => onThumb((id) => setReady((r) => new Set(r).add(id))), []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((width + GAP) / (props.tile + GAP)));
  const tileW = (width - GAP * (cols - 1)) / cols;
  const rowH = tileW * 0.75 + GAP;
  const rows = Math.ceil(props.items.length / cols);

  useEffect(() => {
    const sc = props.scroller.current;
    const el = ref.current;
    if (!sc || !el) return;
    const update = () => {
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const first = Math.max(0, Math.floor((sc.scrollTop - top) / rowH) - 3);
      const last = Math.min(rows, Math.ceil((sc.scrollTop - top + sc.clientHeight) / rowH) + 3);
      setRange({ from: first * cols, to: Math.min(props.items.length, last * cols) });
    };
    update();
    sc.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      sc.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [props.scroller, rowH, rows, cols, props.items.length]);

  const click = (e: React.MouseEvent, item: Item, i: number) => {
    const sel = new Set(props.selected);
    if (e.shiftKey && props.anchor != null) {
      const a = props.items.findIndex((x) => x.id === props.anchor);
      if (a >= 0) {
        const [lo, hi] = a < i ? [a, i] : [i, a];
        if (!(e.ctrlKey || e.metaKey)) sel.clear();
        for (let k = lo; k <= hi; k++) sel.add(props.items[k].id);
        props.onSelect(sel, props.anchor);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (sel.has(item.id)) sel.delete(item.id);
      else sel.add(item.id);
    } else {
      sel.clear();
      sel.add(item.id);
    }
    props.onSelect(sel, item.id);
  };

  // Pointer-based dragging (works the same with files dropped from Windows enabled).
  const startDrag = (e: React.PointerEvent, item: Item) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let over: HTMLElement | null = null;
    const ids = props.selected.has(item.id) ? [...props.selected] : [item.id];
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 7) return;
      active = true;
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-drop^="folder:"]') ?? null;
      if (el !== over) {
        over?.classList.remove('drop-over');
        el?.classList.add('drop-over');
        over = el;
      }
      setDrag({ x: ev.clientX, y: ev.clientY, n: ids.length, over: el?.dataset.drop ?? null });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      over?.classList.remove('drop-over');
      setDrag(null);
      if (active && over?.dataset.drop) props.onDropOnFolder(ids, over.dataset.drop);
      if (active) {
        // Don't treat the end of a drag as a click.
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
  };

  const visible = props.items.slice(range.from, range.to);
  return (
    <div ref={ref} className="mgrid" style={{ height: Math.max(0, rows * rowH - GAP) }} role="grid" aria-label="Media">
      {visible.map((it, k) => {
        const i = range.from + k;
        const r = Math.floor(i / cols);
        const c = i % cols;
        const hasThumb = it.thumb === 'ok' || ready.has(it.id);
        const sel = props.selected.has(it.id);
        return (
          <button key={it.id} type="button" role="gridcell" aria-selected={sel} title={it.name}
            className={`tile${sel ? ' sel' : ''}`}
            style={{ left: c * (tileW + GAP), top: r * rowH, width: tileW, height: tileW * 0.75 }}
            onClick={(e) => click(e, it, i)} onDoubleClick={() => props.onOpen(it)}
            onKeyDown={(e) => e.key === 'Enter' && props.onOpen(it)} onPointerDown={(e) => startDrag(e, it)}>
            {hasThumb && it.thumb !== 'failed' ? (
              <img src={`${thumbUrl(it.id)}?v=${ready.has(it.id) ? 1 : 0}`} alt="" loading="lazy" draggable={false} />
            ) : it.thumb === 'failed' ? (
              <span className="tile-msg"><BrokenIcon /> Can't play</span>
            ) : (
              <span className="tile-msg"><span className="spinner small" /></span>
            )}
            {sel && <span className="tick" aria-hidden="true">✓</span>}
            {it.favourite && <span className="fav" aria-label="Favourite"><HeartIcon filled size={15} /></span>}
            {it.weight !== 1 && <span className="wt" title={`Weight ${it.weight}`}>×{it.weight}</span>}
            {it.kind === 'video' && <span className="badge">{formatTime(it.durationMs) || 'VIDEO'}</span>}
            {it.kind === 'gif' && <span className="badge">GIF</span>}
          </button>
        );
      })}
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>
          {drag.over ? `Move ${drag.n} item${drag.n > 1 ? 's' : ''} here` : `${drag.n} item${drag.n > 1 ? 's' : ''}`}
        </div>
      )}
    </div>
  );
}
