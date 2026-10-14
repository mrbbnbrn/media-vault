// Holds the viewer. Full screen normally; as the mini player it is a small
// floating window in a corner: drag it to any corner (it snaps), resize it
// by the handle on its inner corner, double-click to go back to full view.
// The viewer inside stays the same component, so playback carries on.

import { useEffect, useRef, useState, type ReactNode } from 'react';

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const MARGIN = 18;
const MIN_W = 240;
const KEY = 'mv.mini';

function load(): { corner: Corner; width: number } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && ['tl', 'tr', 'bl', 'br'].includes(v.corner) && typeof v.width === 'number') return { corner: v.corner, width: Math.max(MIN_W, v.width) };
  } catch {
    /* defaults */
  }
  return { corner: 'br', width: 380 };
}
function save(v: { corner: Corner; width: number }) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* only a convenience */
  }
}

const maxWidth = () => Math.max(MIN_W, Math.min(960, window.innerWidth * 0.7 - MARGIN * 2));

export function MiniFrame(props: { mini: boolean; onExpand: () => void; children: ReactNode }) {
  const [place, setPlace] = useState(load);
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const [, setWin] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = () => setWin((n) => n + 1);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  const width = Math.min(place.width, maxWidth());
  const height = Math.round((width * 9) / 16);
  const pos: React.CSSProperties = drag
    ? { left: drag.left, top: drag.top }
    : {
        [place.corner[0] === 't' ? 'top' : 'bottom']: MARGIN,
        [place.corner[1] === 'l' ? 'left' : 'right']: MARGIN,
      };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!props.mini || e.button !== 0 || (e.target as HTMLElement).closest('button, input, .p-mini-bar, .mini-resize')) return;
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      moved = true;
      setDrag({
        left: Math.max(0, Math.min(window.innerWidth - box.width, ev.clientX - dx)),
        top: Math.max(0, Math.min(window.innerHeight - box.height, ev.clientY - dy)),
      });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      // Snap to the corner nearest to where it was let go.
      const cx = ev.clientX - dx + box.width / 2;
      const cy = ev.clientY - dy + box.height / 2;
      const corner = `${cy < window.innerHeight / 2 ? 't' : 'b'}${cx < window.innerWidth / 2 ? 'l' : 'r'}` as Corner;
      const next = { ...place, corner };
      setPlace(next);
      save(next);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = width;
    // The handle sits on the inner corner: dragging away from the anchored side grows it.
    const sign = place.corner[1] === 'r' ? -1 : 1;
    let last = place;
    const move = (ev: PointerEvent) => {
      last = { ...place, width: Math.round(Math.max(MIN_W, Math.min(maxWidth(), w0 + sign * (ev.clientX - x0)))) };
      setPlace(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={ref} className={props.mini ? `mini-frame ${place.corner}${drag ? ' dragging' : ''}` : 'viewer-host'}
      style={props.mini ? { ...pos, width, height } : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if (props.mini && !(e.target as HTMLElement).closest('button, input, .p-mini-bar')) props.onExpand();
      }}
      role={props.mini ? 'region' : undefined} aria-label={props.mini ? 'Mini player' : undefined}>
      {props.children}
      {props.mini && (
        <div className={`mini-resize ${place.corner}`} onPointerDown={onResize} title="Drag to resize" aria-hidden="true" />
      )}
    </div>
  );
}
