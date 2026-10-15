// Scroll preview: a strip right beside the grid's scrollbar in long grids, a
// bigger target than the scrollbar itself. Click or drag on it to jump
// there; pointing at it shows a small screen of real thumbnails from that
// spot (and the month or name when sorted that way).

import { useLayoutEffect, useRef, useState } from 'react';
import { thumbUrl, type Item } from '../api';
import { visibleRange, type Layout } from '../gridlayout';
import { boxesBetween, scrollForStrip } from '../tilemaths';

/** Strip width (px), and the room the grid leaves for it on its right (it overlaps the scroller's padding). */
export const MINIMAP_W = 30;
export const MINIMAP_RESERVE = 12;
const PREVIEW_W = 260;
const PREVIEW_H = 170;

export function Minimap(props: {
  items: Item[];
  layout: Layout;
  /** Width the layout was made for. */
  gridW: number;
  scroller: React.RefObject<HTMLElement | null>;
  grid: React.RefObject<HTMLDivElement | null>;
  /** What is on screen, in grid pixels (for the scroll position read by assistive tech). */
  view: { top: number; bottom: number };
  /** The month or name to show with the preview at item index i. */
  labelAt?: (i: number) => string | null;
}) {
  const [place, setPlace] = useState<{ left: number; top: number; h: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const { layout } = props;
  const L = layout.height;

  // Where the strip goes: flush against the scrollbar, from the top of the
  // grid (not over the bar and folder cards above it) to the bottom.
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    const sc = props.scroller.current;
    const g = props.grid.current;
    if (!sc || !g) {
      // Mounted together with the grid: its ref is set right after this.
      const t = requestAnimationFrame(() => setRetry((n) => n + 1));
      return () => cancelAnimationFrame(t);
    }
    const measure = () => {
      const s = sc.getBoundingClientRect();
      const top0 = s.top + sc.clientTop;
      const bottom = top0 + sc.clientHeight;
      const top = Math.min(bottom - 120, Math.max(top0, g.getBoundingClientRect().top));
      const next = { left: s.left + sc.clientLeft + sc.clientWidth - MINIMAP_W, top, h: Math.max(40, bottom - top) };
      setPlace((p) => (p && p.left === next.left && p.top === next.top && p.h === next.h ? p : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    ro.observe(g);
    sc.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      sc.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [props.scroller, props.grid, retry]);

  const dragRef = useRef(false);
  if (!place) return null;

  const jump = (clientY: number) => {
    const sc = props.scroller.current;
    const g = props.grid.current;
    if (!sc || !g) return;
    const gridTop = g.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = gridTop + scrollForStrip(clientY - place.top, place.h, L, sc.clientHeight);
  };

  // The preview: real thumbnails around the hovered spot.
  let preview: React.ReactNode = null;
  if (hover != null && !dragging) {
    const k = PREVIEW_W / Math.max(1, props.gridW);
    const centre = (hover / place.h) * L;
    const winH = PREVIEW_H / k;
    const wTop = Math.max(0, Math.min(L - winH, centre - winH / 2));
    const ids = boxesBetween(layout.boxes, wTop, wTop + winH, (a, b) => visibleRange(layout.boxes, a, b)).slice(0, 160);
    const mid = ids.find((i) => layout.boxes[i].y + layout.boxes[i].h >= centre) ?? ids[0];
    const label = mid != null ? props.labelAt?.(mid) : null;
    const top = Math.max(8, Math.min(window.innerHeight - PREVIEW_H - 36, place.top + hover - PREVIEW_H / 2));
    preview = (
      <div className="minimap-preview" style={{ left: place.left - PREVIEW_W - 16, top, width: PREVIEW_W }} aria-hidden="true">
        {label && <div className="minimap-label">{label}</div>}
        <div className="minimap-shot" style={{ height: PREVIEW_H }}>
          {ids.map((i) => {
            const b = layout.boxes[i];
            const it = props.items[i];
            return it.thumb === 'ok'
              ? <img key={it.id} src={thumbUrl(it.id, it.thumbV, true)} alt="" draggable={false} style={{ left: b.x * k, top: (b.y - wTop) * k, width: b.w * k, height: b.h * k }} />
              : <span key={it.id} style={{ left: b.x * k, top: (b.y - wTop) * k, width: b.w * k, height: b.h * k }} />;
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`minimap${dragging ? ' dragging' : ''}`} style={{ left: place.left, top: place.top, height: place.h, width: MINIMAP_W }}
        role="scrollbar" aria-orientation="vertical" aria-label="Scroll preview — point for a look, click to jump"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((props.view.top / Math.max(1, L)) * 100)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = true;
          setDragging(true);
          setHover(null);
          jump(e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragRef.current) jump(e.clientY);
          else setHover(e.clientY - place.top);
        }}
        onPointerUp={(e) => {
          dragRef.current = false;
          setDragging(false);
          e.currentTarget.releasePointerCapture(e.pointerId);
          setHover(e.clientY - place.top);
        }}
        onPointerLeave={() => !dragRef.current && setHover(null)}>
        {hover != null && <span className="minimap-hover" style={{ top: hover }} />}
      </div>
      {preview}
    </>
  );
}
