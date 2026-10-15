// Cover framing maths ("Adjust cover…"), kept apart so it can be tested.
//
// A framing is the point of the picture to keep in view (x, y: 0–1 across
// and down) and a zoom (1 = the picture just fills the card). It means
// exactly what this CSS does, so cards can draw it without knowing the
// picture's size:
//   object-fit: cover; object-position: x y; transform: scale(zoom);
//   transform-origin: x y   (inside a box that hides what spills out)
// The picture point x sits at the same spot x of the card, at any zoom, and
// the picture always covers the whole card.

import type { CSSProperties } from 'react';

export interface CoverPos {
  x: number;
  y: number;
  zoom: number;
}

export const ZOOM_MIN = 1;
/** Same limit as the library (library.rs COVER_ZOOM_MAX) and the automatic face close-up (facealign.ts). */
export const ZOOM_MAX = 8;

/** Where the picture lands: width, left as parts of the card's width; height, top as parts of its height. */
export interface Placement {
  w: number;
  h: number;
  left: number;
  top: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ok = (v: number, d: number) => (Number.isFinite(v) ? v : d);

export function clampPos(p: CoverPos): CoverPos {
  return { x: clamp(ok(p.x, 0.5), 0, 1), y: clamp(ok(p.y, 0.5), 0, 1), zoom: clamp(ok(p.zoom, 1), ZOOM_MIN, ZOOM_MAX) };
}

/** The picture's size at zoom 1 (just covering the card), in parts of the card. */
function base(aspect: number, box: number): { w: number; h: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const b = box > 0 && Number.isFinite(box) ? box : 1;
  const w = Math.max(1, a / b);
  return { w, h: (w * b) / a };
}

/**
 * Where a picture of aspect `aspect` (width / height) goes in a card of
 * aspect `box` with framing `pos` (null = centred, zoom 1) — the same as the
 * CSS above.
 */
export function placement(aspect: number, box: number, pos: CoverPos | null): Placement {
  const p = clampPos(pos ?? { x: 0.5, y: 0.5, zoom: 1 });
  const b = base(aspect, box);
  const w = b.w * p.zoom;
  const h = b.h * p.zoom;
  return { w, h, left: p.x * (1 - w), top: p.y * (1 - h) };
}

/** The framing that puts the picture at `pl` (e.g. the automatic face close-up), as near as framings go. */
export function fromPlacement(aspect: number, box: number, pl: Placement): CoverPos {
  const b = base(aspect, box);
  const zoom = clamp(Math.max(pl.w / b.w, pl.h / b.h), ZOOM_MIN, ZOOM_MAX);
  const w = b.w * zoom;
  const h = b.h * zoom;
  // With nothing spilling over on a side, any point gives the same picture: the middle.
  const x = 1 - w < -1e-9 ? pl.left / (1 - w) : 0.5;
  const y = 1 - h < -1e-9 ? pl.top / (1 - h) : 0.5;
  return clampPos({ x, y, zoom });
}

/** Dragging the picture by dx, dy (parts of the card's width and height): it follows the mouse. */
export function dragBy(pos: CoverPos, dx: number, dy: number, aspect: number, box: number): CoverPos {
  const pl = placement(aspect, box, pos);
  return fromPlacement(aspect, box, { ...pl, left: pl.left + dx, top: pl.top + dy });
}

/** Zooming to `zoom` while the picture point under (cx, cy) (parts of the card) stays put. */
export function zoomAround(pos: CoverPos, zoom: number, cx: number, cy: number, aspect: number, box: number): CoverPos {
  const z = clamp(ok(zoom, 1), ZOOM_MIN, ZOOM_MAX);
  const pl = placement(aspect, box, pos);
  const u = (cx - pl.left) / pl.w;
  const v = (cy - pl.top) / pl.h;
  const b = base(aspect, box);
  const w = b.w * z;
  const h = b.h * z;
  return fromPlacement(aspect, box, { w, h, left: cx - u * w, top: cy - v * h });
}

export function samePos(a: CoverPos | null | undefined, b: CoverPos | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.zoom - b.zoom) < 1e-4;
}

/**
 * The CSS custom properties a `.cframe` box hands to the picture or video in
 * it (styles in screens.css), so pooled video players pick them up too.
 */
export function frameVars(pos: CoverPos | null | undefined): CSSProperties | undefined {
  if (!pos) return undefined;
  const p = clampPos(pos);
  const at = `${(p.x * 100).toFixed(3)}% ${(p.y * 100).toFixed(3)}%`;
  return { ['--cpos' as string]: at, ['--czoom' as string]: p.zoom.toFixed(4) } as CSSProperties;
}
