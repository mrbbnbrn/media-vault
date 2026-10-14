// Small sums for the grid extras, kept apart so they can be tested:
// the scroll preview beside the scrollbar, Alt enlarge and the progress
// line on video tiles.

import type { Box } from './gridlayout';

// ---- scroll preview -----------------------------------------------------------------------------

/** The scroll preview shows once the grid is longer than this many screens. */
export const MINIMAP_SCREENS = 3;

export function wantsMinimap(contentH: number, viewH: number): boolean {
  return viewH > 0 && contentH > viewH * MINIMAP_SCREENS;
}

/** The scroll position (inside the grid) that centres the view on strip point `y`. */
export function scrollForStrip(y: number, stripH: number, contentH: number, viewH: number): number {
  const at = (Math.min(stripH, Math.max(0, y)) / Math.max(1, stripH)) * contentH;
  return Math.max(0, Math.min(Math.max(0, contentH - viewH), at - viewH / 2));
}

// ---- Alt enlarge ---------------------------------------------------------------------------------

/** How much bigger the picture gets under Alt (compared with how big it is in its tile). */
export const ENLARGE = 1.8;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a tile's picture goes while Alt is held: the whole picture (its own
 * shape, nothing cropped) about `ENLARGE`× the size it has in the tile,
 * centred on the tile and kept inside the window (`margin` px from its
 * edges). Small pictures grow to at most twice their own size.
 * `nw`×`nh` is the picture's size (0 when unknown: the tile's shape is used).
 */
export function enlargeBox(tile: Rect, nw: number, nh: number, vw: number, vh: number, margin = 12): Rect {
  const w0 = nw > 0 && nh > 0 ? nw : tile.width;
  const h0 = nw > 0 && nh > 0 ? nh : tile.height;
  if (!(w0 > 0 && h0 > 0)) return tile;
  // The scale the tile draws the picture at (object-fit: cover).
  const cover = Math.max(tile.width / w0, tile.height / h0);
  const known = nw > 0 && nh > 0;
  let s = cover * ENLARGE;
  if (known) s = Math.min(s, Math.max(2, cover));
  s = Math.min(s, Math.max(1, vw - 2 * margin) / w0, Math.max(1, vh - 2 * margin) / h0);
  const width = w0 * s;
  const height = h0 * s;
  const cx = tile.left + tile.width / 2;
  const cy = tile.top + tile.height / 2;
  const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    left: clampTo(cx - width / 2, margin, Math.max(margin, vw - margin - width)),
    top: clampTo(cy - height / 2, margin, Math.max(margin, vh - margin - height)),
    width,
    height,
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
