// A slim strip beside the grid's scrollbar showing the whole grid at once:
// every tile as its picture's average colour, with a box for what is on
// screen. Click or drag on it to jump there; hovering shows a bigger preview
// of that spot (and the month or name when sorted that way).
//
// Fast with 50,000 items: the strip samples one tile row per pixel row, the
// colours come from thumbnails loaded a few at a time in idle moments (and
// are kept for the session), and scrolling only moves the box.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { thumbUrl, type Item } from '../api';
import { visibleRange, type Layout } from '../gridlayout';
import { averageColour, boxesBetween, scrollForStrip, stripRows, viewportBox } from '../tilemaths';

/** Strip width (px), and the room the grid leaves for it on its right. */
export const MINIMAP_W = 44;
export const MINIMAP_RESERVE = MINIMAP_W - 8;
const PREVIEW_W = 260;
const PREVIEW_H = 170;

// ---- average colours of thumbnails (kept for the session) ---------------------------------------

const colours = new Map<number, string | null>();
let queue: number[] = [];
let running = 0;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let sampler: CanvasRenderingContext2D | null = null;

const idle = (f: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(f, { timeout: 400 });
  else setTimeout(f, 30);
};

function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    listeners.forEach((f) => f());
  }, 300);
}

function sample(id: number): Promise<void> {
  return new Promise((done) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    const finish = (c: string | null) => {
      colours.set(id, c);
      notify();
      done();
    };
    img.onload = () => {
      try {
        if (!sampler) {
          const c = document.createElement('canvas');
          c.width = 6;
          c.height = 6;
          sampler = c.getContext('2d', { willReadFrequently: true });
        }
        if (!sampler) return finish(null);
        sampler.clearRect(0, 0, 6, 6);
        sampler.drawImage(img, 0, 0, 6, 6);
        finish(averageColour(sampler.getImageData(0, 0, 6, 6).data));
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = thumbUrl(id);
  });
}

function pump() {
  while (running < 6 && queue.length) {
    const id = queue.shift()!;
    if (colours.has(id)) continue;
    running++;
    sample(id).finally(() => {
      running--;
      idle(pump);
    });
  }
}

/** Load these colours next (replaces what was waiting). */
function want(ids: number[]) {
  queue = ids.filter((id) => !colours.has(id));
  idle(pump);
}

// ---- the strip ------------------------------------------------------------------------------------

export function Minimap(props: {
  items: Item[];
  layout: Layout;
  /** Width the layout was made for. */
  gridW: number;
  scroller: React.RefObject<HTMLElement | null>;
  grid: React.RefObject<HTMLDivElement | null>;
  /** What is on screen, in grid pixels. */
  view: { top: number; bottom: number };
  /** The month or name to show with the preview at item index i. */
  labelAt?: (i: number) => string | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; h: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drawTick, setDrawTick] = useState(0);
  const dragging = useRef(false);
  const viewRef = useRef(props.view);
  viewRef.current = props.view;
  const { layout } = props;
  const L = layout.height;

  // Where the strip goes: right of the grid, as tall as the scrolling area.
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
      const r = g.getBoundingClientRect();
      const left = Math.min(r.right + 8, s.left + sc.clientLeft + sc.clientWidth - MINIMAP_W - 4);
      setPlace({ left, top: s.top + 8, h: Math.max(40, s.height - 16) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    ro.observe(g);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [props.scroller, props.grid, retry]);

  useEffect(() => {
    const f = () => setDrawTick((t) => t + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);

  // Draw (layout, size and new colours; never on scroll). Asks for missing colours, nearest the view first.
  const askedFor = useRef<{ layout: Layout | null; h: number }>({ layout: null, h: 0 });
  useEffect(() => {
    const c = canvas.current;
    if (!c || !place || !L) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(MINIMAP_W * dpr);
    const ch = Math.round(place.h * dpr);
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    const rows = stripRows(ch, L, (y) => visibleRange(layout.boxes, y, y));
    const k = cw / Math.max(1, props.gridW);
    const missing: { id: number; row: number }[] = [];
    for (const { row, from, to } of rows) {
      for (let i = from; i < to; i++) {
        const b = layout.boxes[i];
        const it = props.items[i];
        if (!b || !it) continue;
        const col = colours.get(it.id);
        if (col === undefined && it.thumb === 'ok') missing.push({ id: it.id, row });
        ctx.fillStyle = col ?? (it.kind === 'pdf' || it.kind === 'text' ? '#3a3f47' : '#2a2e35');
        ctx.fillRect(Math.floor(b.x * k), row, Math.max(1, Math.round(b.w * k)), 1);
      }
    }
    // Month / group headers as thin lines.
    ctx.fillStyle = 'rgba(46, 196, 182, 0.55)';
    for (const h of layout.headers) ctx.fillRect(0, Math.floor((h.y / L) * ch), cw, Math.max(1, Math.round(dpr)));
    // New layout: fetch what is missing, nearest the view first.
    if (missing.length && (askedFor.current.layout !== layout || askedFor.current.h !== ch)) {
      askedFor.current = { layout, h: ch };
      const v = viewRef.current;
      const at = (((v.top + v.bottom) / 2) / L) * ch;
      const seen = new Set<number>();
      want(missing.sort((a, b) => Math.abs(a.row - at) - Math.abs(b.row - at)).map((m) => m.id).filter((id) => !seen.has(id) && !!seen.add(id)));
    }
  }, [layout, place?.h, props.gridW, drawTick, L, props.items]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!place) return null;
  const box = viewportBox(props.view.top, props.view.bottom, L, place.h);

  const jump = (clientY: number) => {
    const sc = props.scroller.current;
    const g = props.grid.current;
    if (!sc || !g) return;
    const gridTop = g.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = gridTop + scrollForStrip(clientY - place.top, place.h, L, sc.clientHeight);
  };

  // The preview: real thumbnails around the hovered spot.
  let preview: React.ReactNode = null;
  if (hover != null && !dragging.current) {
    const k = PREVIEW_W / Math.max(1, props.gridW);
    const centre = (hover / place.h) * L;
    const winH = PREVIEW_H / k;
    const wTop = Math.max(0, Math.min(L - winH, centre - winH / 2));
    const ids = boxesBetween(layout.boxes, wTop, wTop + winH, (a, b) => visibleRange(layout.boxes, a, b)).slice(0, 160);
    const mid = ids.find((i) => layout.boxes[i].y + layout.boxes[i].h >= centre) ?? ids[0];
    const label = mid != null ? props.labelAt?.(mid) : null;
    const top = Math.max(8, Math.min(window.innerHeight - PREVIEW_H - 36, place.top + hover - PREVIEW_H / 2));
    preview = (
      <div className="minimap-preview" style={{ left: place.left - PREVIEW_W - 12, top, width: PREVIEW_W }} aria-hidden="true">
        {label && <div className="minimap-label">{label}</div>}
        <div className="minimap-shot" style={{ height: PREVIEW_H }}>
          {ids.map((i) => {
            const b = layout.boxes[i];
            const it = props.items[i];
            return it.thumb === 'ok'
              ? <img key={it.id} src={thumbUrl(it.id)} alt="" draggable={false} style={{ left: b.x * k, top: (b.y - wTop) * k, width: b.w * k, height: b.h * k }} />
              : <span key={it.id} style={{ left: b.x * k, top: (b.y - wTop) * k, width: b.w * k, height: b.h * k }} />;
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="minimap" style={{ left: place.left, top: place.top, height: place.h, width: MINIMAP_W }}
        role="scrollbar" aria-orientation="vertical" aria-label="Overview of everything here — click to jump"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((props.view.top / Math.max(1, L)) * 100)}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          setHover(null);
          jump(e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging.current) jump(e.clientY);
          else setHover(e.clientY - place.top);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
          setHover(e.clientY - place.top);
        }}
        onPointerLeave={() => !dragging.current && setHover(null)}>
        <canvas ref={canvas} style={{ width: MINIMAP_W, height: place.h }} />
        <span className="minimap-view" style={{ top: box.y, height: box.h }} />
        {hover != null && <span className="minimap-hover" style={{ top: hover }} />}
      </div>
      {preview}
    </>
  );
}
