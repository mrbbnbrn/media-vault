// Opening and closing the viewer over the library, which stays mounted (and
// frozen) underneath, so its scroll position and selection never change.
//
// Opening: a copy of the tile's own thumbnail (already decoded) grows from the
// exact tile rect to where the viewer draws the picture, then crossfades to
// the full picture once that is ready. Closing: the library first scrolls the
// item's tile into view (hidden under the viewer), then a snapshot of what the
// viewer shows shrinks into that tile; with no tile, a short fade.
// Settings → Viewer "Open and close animation" turns it off; reduced motion too.

import { useEffect, useRef } from 'react';
import { invert, reducedMotion, type Box } from './flip';
import { viewerPrefs } from './prefs';

export const OPEN_MS = 220;
export const CLOSE_MS = 200;
const EASE = 'cubic-bezier(0.2, 0, 0.1, 1)';

/** Grow / shrink animations wanted right now. */
export function animOn(): boolean {
  return viewerPrefs().openCloseAnim !== false && !reducedMotion();
}

// ---- the sums ----------------------------------------------------------------------------------

export interface Cover {
  /** translate(x, y) scale(s), transform-origin top left. */
  x: number;
  y: number;
  s: number;
  /** clip-path: inset(top right bottom left) in the element's own (unscaled) pixels. */
  clip: [number, number, number, number];
}

/**
 * The transform that lays an element drawn at `el` over `tile`, scaled
 * uniformly so it covers the tile, plus the clip that cuts it down to exactly
 * the tile (like the tile's object-fit: cover).
 */
export function coverInto(tile: Box, el: Box): Cover {
  const t = invert(tile, el);
  if (t.s <= 0) return { ...t, clip: [0, 0, 0, 0] };
  // Tile edges in the element's own coordinates.
  const u0 = (tile.left - el.left - t.x) / t.s;
  const v0 = (tile.top - el.top - t.y) / t.s;
  const u1 = (tile.left + tile.width - el.left - t.x) / t.s;
  const v1 = (tile.top + tile.height - el.top - t.y) / t.s;
  const c = (n: number) => Math.max(0, Math.round(n * 100) / 100);
  return { x: t.x, y: t.y, s: t.s, clip: [c(v0), c(el.width - u1), c(el.height - v1), c(u0)] };
}

const transformOf = (c: Cover) => `translate(${c.x}px, ${c.y}px) scale(${c.s})`;
const clipOf = (c: Cover, radius: number) => `inset(${c.clip.map((n) => `${n}px`).join(' ')} round ${radius / c.s}px)`;

// ---- where the item's tile is ------------------------------------------------------------------

/** A grid tile, or (People page, look-alikes, statistics) the thing that was double-clicked. */
export function sourceElement(id: number | null | undefined): HTMLElement | null {
  if (id == null || typeof document === 'undefined') return null;
  const tile = document.querySelector<HTMLElement>(`.library [data-item="${id}"]`);
  if (tile) return tile;
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && a.closest('.library') && a.querySelector('img, canvas')) return a;
  return null;
}

/** A tile's place on screen when it is (mostly) visible, else null. */
export function visibleRect(el: Element | null): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Where to open the viewer from (null: no tile on screen). */
export function openRect(id: number | null | undefined): Box | null {
  return visibleRect(sourceElement(id));
}

// The library tells the viewer how to bring an item's tile into view when it closes.
type Reveal = (id: number) => Box | null;
let libraryReveal: Reveal | null = null;
export function setLibraryReveal(fn: Reveal | null) {
  libraryReveal = fn;
}
/** Scroll the item's tile into view (instantly, under the viewer) and say where it is. */
export function revealTile(id: number | null | undefined): Box | null {
  if (id == null || !libraryReveal) return null;
  try {
    return libraryReveal(id);
  } catch {
    return null;
  }
}

// The media grid (virtual: off-screen tiles don't exist) knows where every item is.
let gridReveal: { current: Reveal } | null = null;
export function useGridReveal(fn: Reveal) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const me = ref;
    gridReveal = me;
    return () => {
      if (gridReveal === me) gridReveal = null;
    };
  }, []);
}
export function revealInGrid(id: number): Box | null {
  return gridReveal?.current(id) ?? null;
}

// ---- copies of what is on screen -----------------------------------------------------------------

/** A canvas copy of a decoded <img> (whole picture), so it shows in the very first frame. */
export function copyImage(img: HTMLImageElement | null): HTMLCanvasElement | null {
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return null;
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')?.drawImage(img, 0, 0);
    return c;
  } catch {
    return null;
  }
}

/** The part of `src` (drawn by `fit` inside `box`, intrinsic size `nw`×`nh`) that is on screen at `rect`, as a canvas. */
function copyRegion(src: CanvasImageSource, box: DOMRect, nw: number, nh: number, fit: string, rect: Box): HTMLCanvasElement | null {
  if (!nw || !nh || !box.width || !box.height) return null;
  const k = fit === 'cover' ? Math.max(box.width / nw, box.height / nh) : fit === 'fill' ? NaN : Math.min(box.width / nw, box.height / nh);
  const kx = Number.isNaN(k) ? box.width / nw : k;
  const ky = Number.isNaN(k) ? box.height / nh : k;
  const left = box.left + (box.width - nw * kx) / 2;
  const top = box.top + (box.height - nh * ky) / 2;
  const sx = (rect.left - left) / kx;
  const sy = (rect.top - top) / ky;
  const sw = rect.width / kx;
  const sh = rect.height / ky;
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(Math.min(rect.width * dpr, sw)));
  c.height = Math.max(1, Math.round(Math.min(rect.height * dpr, sh)));
  try {
    c.getContext('2d')?.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  } catch {
    return null;
  }
}

/** A snapshot of the picture / video frame the viewer shows at `rect` (screen coordinates). */
export function snapshotViewer(root: HTMLElement | null, rect: Box | null): HTMLCanvasElement | null {
  if (!root || !rect || rect.width < 2 || rect.height < 2) return null;
  const all = [...root.querySelectorAll<HTMLElement>('.stage canvas.media-canvas, .stage img.media, .stage video.media')];
  // The top-most visible one (an upscaled copy sits over the original).
  const el = all.reverse().find((e) => e.offsetWidth > 0 && !e.closest('.hide'));
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (el instanceof HTMLCanvasElement) {
    // Drawn by ImageStage at the device pixel ratio, filling its box.
    if (!el.width || !el.height) return null;
    return copyRegion(el, box, el.width, el.height, 'fill', rect);
  }
  const fit = getComputedStyle(el).objectFit || 'contain';
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 ? copyRegion(el, box, el.videoWidth, el.videoHeight, fit, rect) : null;
  if (el instanceof HTMLImageElement) return copyRegion(el, box, el.naturalWidth, el.naturalHeight, fit, rect);
  return null;
}

/** Is the viewer's picture / video frame on screen yet? `drawn`: the player knows where it is drawn (picture decoded, video size known). */
export function viewerMediaReady(root: HTMLElement | null, drawn: boolean): boolean {
  if (root?.querySelector('.stage .media-failed')) return true;
  if (!drawn) return false;
  const v = root?.querySelector<HTMLVideoElement>('.stage video.media');
  return !v || v.readyState >= 2;
}

// ---- opening -------------------------------------------------------------------------------------

/**
 * Grow `ghost` (laid out at `to`, inside the viewer) out of the tile at `from`.
 * Resolves when the movement is done.
 */
export function growGhost(ghost: HTMLElement, from: Box, to: Box, radius = 8): Promise<void> {
  const c = coverInto(from, to);
  const a = ghost.animate(
    [
      { transform: transformOf(c), clipPath: clipOf(c, radius) },
      { transform: 'none', clipPath: 'inset(0px 0px 0px 0px round 0px)' },
    ],
    { duration: OPEN_MS, easing: EASE, fill: 'both' },
  );
  return a.finished.then(() => undefined, () => undefined);
}

// ---- closing -------------------------------------------------------------------------------------

let closing: HTMLElement | null = null;

/**
 * Over everything (the viewer is about to go): the snapshot shrinks from where
 * the viewer showed it into the tile at `to`, while the black behind it fades
 * to show the library. Without a tile it simply fades.
 */
export function playClose(snap: HTMLCanvasElement | null, from: Box | null, to: Box | null, radius = 8) {
  closing?.remove();
  const layer = document.createElement('div');
  layer.className = 'vflip-layer';
  layer.setAttribute('aria-hidden', 'true');
  const back = document.createElement('div');
  back.className = 'vflip-back';
  layer.appendChild(back);
  document.body.appendChild(layer);
  closing = layer;
  const ms = to ? CLOSE_MS : Math.round(CLOSE_MS * 0.8);
  const anims: Animation[] = [back.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-out', fill: 'both' })];
  if (snap && from) {
    snap.className = 'vflip-ghost';
    Object.assign(snap.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    layer.appendChild(snap);
    if (to) {
      const c = coverInto(to, from);
      anims.push(snap.animate(
        [
          { transform: 'none', clipPath: 'inset(0px 0px 0px 0px round 0px)' },
          { transform: transformOf(c), clipPath: clipOf(c, radius) },
        ],
        { duration: CLOSE_MS, easing: EASE, fill: 'both' },
      ));
    } else {
      anims.push(snap.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.97)' }], { duration: ms, easing: 'ease-out', fill: 'both' }));
    }
  }
  const done = () => {
    layer.remove();
    if (closing === layer) closing = null;
  };
  Promise.all(anims.map((a) => a.finished)).then(done, done);
  setTimeout(done, CLOSE_MS + 1500);
}
