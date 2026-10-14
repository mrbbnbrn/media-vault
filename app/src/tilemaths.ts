// Small sums for the grid extras, kept apart so they can be tested:
// the minimap beside the scrollbar, the Alt-hover magnifier and the
// progress line on video tiles.

import type { Box } from './gridlayout';

// ---- minimap ---------------------------------------------------------------------------------

/** The minimap shows once the grid is longer than this many screens. */
export const MINIMAP_SCREENS = 3;

export function wantsMinimap(contentH: number, viewH: number): boolean {
  return viewH > 0 && contentH > viewH * MINIMAP_SCREENS;
}

/** The viewport box on a strip of height `stripH` (min 6 px tall, kept inside). */
export function viewportBox(top: number, bottom: number, contentH: number, stripH: number): { y: number; h: number } {
  if (!(contentH > 0 && stripH > 0)) return { y: 0, h: stripH };
  const k = stripH / contentH;
  const h = Math.min(stripH, Math.max(6, (bottom - top) * k));
  const y = Math.min(stripH - h, Math.max(0, top * k));
  return { y, h };
}

/** The scroll position (inside the grid) that centres the view on strip point `y`. */
export function scrollForStrip(y: number, stripH: number, contentH: number, viewH: number): number {
  const at = (Math.min(stripH, Math.max(0, y)) / Math.max(1, stripH)) * contentH;
  return Math.max(0, Math.min(Math.max(0, contentH - viewH), at - viewH / 2));
}

/**
 * Which tiles to paint, one strip row at a time: for every row of the
 * canvas (in canvas pixels), the boxes that cross the matching height of the
 * grid. Big grids are sampled (one tile row per canvas row), so this stays
 * fast with 50,000 items. `rangeAt` finds the boxes at a height.
 */
export function stripRows(rows: number, contentH: number, rangeAt: (y: number) => [number, number]): { row: number; from: number; to: number }[] {
  const out: { row: number; from: number; to: number }[] = [];
  if (!(rows > 0 && contentH > 0)) return out;
  for (let r = 0; r < rows; r++) {
    const y = ((r + 0.5) / rows) * contentH;
    const [from, to] = rangeAt(y);
    if (to > from) out.push({ row: r, from, to });
  }
  return out;
}

/** Average of RGBA pixels (transparent ones ignored) as "rgb(r, g, b)", or null. */
export function averageColour(px: ArrayLike<number>): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    if (px[i + 3] < 16) continue;
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
    n++;
  }
  if (!n) return null;
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}

// ---- magnifier ---------------------------------------------------------------------------------

export const LOUPE_MIN = 1.5;
export const LOUPE_MAX = 6;

/** Alt + wheel: one notch up or down (about ×1.2), kept within 1.5×–6×. */
export function loupeZoom(mag: number, deltaY: number): number {
  const next = deltaY < 0 ? mag * 1.2 : deltaY > 0 ? mag / 1.2 : mag;
  return Math.round(Math.min(LOUPE_MAX, Math.max(LOUPE_MIN, next)) * 100) / 100;
}

/**
 * Where the picture is drawn inside a tile of w×h: `object-fit: cover` (or
 * `contain`) with an object position (0–1). Returns the drawn size and offset.
 */
export function tileDraw(nw: number, nh: number, w: number, h: number, fit: 'cover' | 'contain' = 'cover', px = 0.5, py = 0.5) {
  if (!(nw > 0 && nh > 0)) return { dw: w, dh: h, ox: 0, oy: 0 };
  const s = fit === 'cover' ? Math.max(w / nw, h / nh) : Math.min(w / nw, h / nh);
  const dw = nw * s;
  const dh = nh * s;
  return { dw, dh, ox: (w - dw) * px, oy: (h - dh) * py };
}

/** The point under the cursor (x, y inside the tile) as picture fractions (0–1, clamped). */
export function tilePoint(x: number, y: number, d: { dw: number; dh: number; ox: number; oy: number }): { u: number; v: number } {
  const u = (x - d.ox) / Math.max(1e-6, d.dw);
  const v = (y - d.oy) / Math.max(1e-6, d.dh);
  return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
}

/** Parse a CSS object-position like "50% 30%" (anything else counts as centred). */
export function objectPosition(css: string | null | undefined): { px: number; py: number } {
  const m = /^\s*(-?[\d.]+)%\s+(-?[\d.]+)%\s*$/.exec(css ?? '');
  if (!m) return { px: 0.5, py: 0.5 };
  return { px: Number(m[1]) / 100, py: Number(m[2]) / 100 };
}

/** Where the loupe sits: centred on the cursor, kept on screen. */
export function loupeSpot(x: number, y: number, size: number, vw: number, vh: number): { left: number; top: number } {
  return {
    left: Math.min(Math.max(0, vw - size), Math.max(0, x - size / 2)),
    top: Math.min(Math.max(0, vh - size), Math.max(0, y - size / 2)),
  };
}

// ---- progress lines -----------------------------------------------------------------------------

/** Only videos longer than this (the "Continue watching" limit) get a line. */
export const PROGRESS_MIN_MS = 120_000;

/** How much of a video was watched (0–1), or null when no line should show. */
export function watchedShare(kind: string, durationMs: number | null | undefined, resumeMs: number | null | undefined): number | null {
  if (kind !== 'video' || !resumeMs || resumeMs <= 0 || !durationMs || durationMs <= PROGRESS_MIN_MS) return null;
  return Math.min(1, Math.max(0.01, resumeMs / durationMs));
}

/** Boxes of a grid inside a window [top, bottom] (boxes in reading order). */
export function boxesBetween(boxes: Box[], top: number, bottom: number, rangeAt: (a: number, b: number) => [number, number]): number[] {
  const [from, to] = rangeAt(top, bottom);
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const b = boxes[i];
    if (b && b.y + b.h >= top && b.y <= bottom) out.push(i);
  }
  return out;
}
