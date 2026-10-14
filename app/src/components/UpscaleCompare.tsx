// Before / after for the AI upscaler: a thin line across the picture that
// follows the mouse; the original shows to its left, the upscaled picture to
// its right. Both pictures are drawn by ImageStage with the same fit and
// zoom, one on top of the other, so they line up exactly (zoomed and panned
// too); this only clips the upscaled layer at the line.
//
//  - the line follows the mouse while it is over the picture, and stays put
//    when the mouse leaves
//  - click: hold the line where it is; click again: follow the mouse again
//  - [ and ] or Shift+← / Shift+→: nudge the line (and hold it)
//  - touch or pen: drag the line
//
// Mouse moves never re-render React: positions are kept in refs and written
// to the DOM once per animation frame.

import { useEffect, useRef, type RefObject } from 'react';
import type { Box } from '../flip';
import { compareKeyStep, clampLine } from '../upscalecompare';

interface Props {
  /** The upscaled layer (clipped from the left up to the line). */
  layer: RefObject<HTMLDivElement | null>;
  /** Where the picture is drawn, in the layer's own pixels. */
  drawn: Box | null;
  /** e.g. "Upscaled ×4 · Real-ESRGAN". */
  label: string;
  /** Listen to [ ] and Shift+arrows. */
  keys: boolean;
}

/** Room for the viewer's top bar (title, View, Timing…) over the picture. */
const TOP_BAR = 84;

export function UpscaleCompare({ layer, drawn, label, keys }: Props) {
  const ui = useRef<HTMLDivElement>(null);
  const st = useRef({ x: NaN, pinned: false, frame: 0 });
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;

  /** The visible part of the picture, in layer pixels. */
  const visible = () => {
    const el = layer.current;
    const W = el?.offsetWidth ?? 0;
    const H = el?.offsetHeight ?? 0;
    const d = drawnRef.current ?? { left: 0, top: 0, width: W, height: H };
    const left = Math.max(0, d.left);
    const top = Math.max(0, d.top);
    return { left, top, right: Math.min(W, d.left + d.width), bottom: Math.min(H, d.top + d.height) };
  };

  const apply = () => {
    st.current.frame = 0;
    const el = layer.current;
    const box = ui.current;
    if (!el || !box) return;
    const v = visible();
    const s = st.current;
    if (!Number.isFinite(s.x)) s.x = (v.left + v.right) / 2;
    s.x = clampLine(s.x, v.left, v.right);
    el.style.clipPath = `inset(0 0 0 ${s.x}px)`;
    box.style.transform = `translateX(${s.x}px)`;
    box.style.top = `${v.top}px`;
    box.style.height = `${Math.max(0, v.bottom - v.top)}px`;
    // Labels near the top of the picture, but clear of the viewer's top bar.
    box.style.setProperty('--tag-top', `${Math.max(12, TOP_BAR - v.top)}px`);
    box.classList.toggle('pinned', s.pinned);
    // The labels fade out as the line nears that edge of the picture.
    const fade = (px: number) => String(Math.max(0, Math.min(1, (px - 24) / 90)));
    (box.children[1] as HTMLElement).style.opacity = fade(s.x - v.left);
    (box.children[2] as HTMLElement).style.opacity = fade(v.right - s.x);
  };

  const schedule = () => {
    if (!st.current.frame) st.current.frame = requestAnimationFrame(apply);
  };

  /** clientX → layer pixels (the layer may be scaled by the slow pan and zoom). */
  const toLocal = (clientX: number) => {
    const el = layer.current;
    if (!el) return NaN;
    const r = el.getBoundingClientRect();
    const scale = r.width > 0 && el.offsetWidth > 0 ? el.offsetWidth / r.width : 1;
    return (clientX - r.left) * scale;
  };
  const insidePicture = (clientX: number, clientY: number) => {
    const el = layer.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const scale = r.width > 0 && el.offsetWidth > 0 ? el.offsetWidth / r.width : 1;
    const x = (clientX - r.left) * scale;
    const y = (clientY - r.top) * scale;
    const v = visible();
    return x >= v.left && x <= v.right && y >= v.top && y <= v.bottom;
  };

  // Redraw when the picture moves (zoom, pan, window size).
  useEffect(schedule, [drawn?.left, drawn?.top, drawn?.width, drawn?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = layer.current;
    const stage = el?.closest<HTMLElement>('.stage') ?? el?.parentElement ?? null;
    if (!el || !stage) return;
    const s = st.current;
    let down: { x: number; y: number; id: number } | null = null;
    let dragging: number | null = null;

    const move = (e: PointerEvent) => {
      if (dragging != null) {
        if (e.pointerId !== dragging) return;
        s.x = toLocal(e.clientX);
        schedule();
        return;
      }
      if (e.pointerType !== 'mouse' || s.pinned) return;
      if (!insidePicture(e.clientX, e.clientY)) return;
      s.x = toLocal(e.clientX);
      schedule();
    };
    const pointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') {
        if (e.button === 0) down = { x: e.clientX, y: e.clientY, id: e.pointerId };
        return;
      }
      // Touch or pen: drag the line (and nothing else: no zoom box).
      if (!insidePicture(e.clientX, e.clientY)) return;
      e.stopPropagation();
      e.preventDefault();
      dragging = e.pointerId;
      s.pinned = true;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* fine without */
      }
      s.x = toLocal(e.clientX);
      schedule();
    };
    const pointerUp = (e: PointerEvent) => {
      if (dragging === e.pointerId) {
        dragging = null;
        return;
      }
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId || e.pointerType !== 'mouse') return;
      // A plain click (not a drag for the zoom box) holds or frees the line.
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= 6) return;
      if (!insidePicture(e.clientX, e.clientY)) return;
      s.pinned = !s.pinned;
      if (!s.pinned) s.x = toLocal(e.clientX);
      schedule();
    };
    const prevTouch = stage.style.touchAction;
    stage.style.touchAction = 'none';
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerdown', pointerDown, true);
    stage.addEventListener('pointerup', pointerUp);
    stage.addEventListener('pointercancel', pointerUp);
    schedule();
    return () => {
      stage.style.touchAction = prevTouch;
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerdown', pointerDown, true);
      stage.removeEventListener('pointerup', pointerUp);
      stage.removeEventListener('pointercancel', pointerUp);
      if (s.frame) cancelAnimationFrame(s.frame);
      s.frame = 0;
      el.style.clipPath = '';
    };
  }, [layer]); // eslint-disable-line react-hooks/exhaustive-deps

  // [ ] and Shift+arrows: nudge the line. Taken before the viewer's own keys
  // (Shift+arrows would otherwise change picture).
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [role=dialog]')) return;
      const dir = compareKeyStep(e);
      if (!dir) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const v = visible();
      const s = st.current;
      if (!Number.isFinite(s.x)) s.x = (v.left + v.right) / 2;
      s.pinned = true;
      s.x += dir * Math.max(4, (v.right - v.left) * 0.02);
      schedule();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ui} className="cmp-line" aria-hidden="true">
      <span className="cmp-knob" />
      <span className="cmp-tag left">Original</span>
      <span className="cmp-tag right">{label}</span>
    </div>
  );
}
