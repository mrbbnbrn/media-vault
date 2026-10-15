// Rotating in the viewer: the small sums, kept apart so they can be tested.
// A rotation is a number of clockwise quarter turns (0–3). Zoom and pan stay
// in screen pixels; only what is drawn turns, so the fit uses the turned shape.

import type { CSSProperties } from 'react';
import { applyPalette, quantize } from 'gifenc';
import { drawnRect, type Box } from './flip';

export type Quarter = 0 | 1 | 2 | 3;

/** `r` turned a further `by` quarter turns (negative = left). */
export const turn = (r: Quarter, by: number): Quarter => ((((r + by) % 4) + 4) % 4) as Quarter;

/** The shape after turning (a quarter turn swaps width and height). */
export function turnedSize<T extends { w: number; h: number }>(s: T, r: Quarter): { w: number; h: number } {
  return r % 2 ? { w: s.h, h: s.w } : { w: s.w, h: s.h };
}

/** Where a picture of nw × nh is drawn on a W × H stage, turned `r`. */
export function turnedRect(W: number, H: number, nw: number, nh: number, fit: 'contain' | 'cover', r: Quarter, zoom?: { s: number; x: number; y: number }): Box {
  const t = turnedSize({ w: nw, h: nh }, r);
  return drawnRect(W, H, t.w, t.h, fit, zoom);
}

/**
 * The canvas transform that draws the unturned picture (0,0)–(iw,ih) into the
 * screen box (x, y, w, h) of the turned picture, where iw × ih is w × h for
 * 0 / 180 and h × w for 90 / 270. [a, b, c, d, e, f] as for setTransform.
 */
export function turnMatrix(r: Quarter, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (r) {
    case 1:
      return [0, 1, -1, 0, x + w, y];
    case 2:
      return [-1, 0, 0, -1, x + w, y + h];
    case 3:
      return [0, -1, 1, 0, x, y + h];
    default:
      return [1, 0, 0, 1, x, y];
  }
}

/** A point of the unturned picture (parts of it, 0..1) in the turned picture. */
export function turnPoint(px: number, py: number, r: Quarter): [number, number] {
  switch (r) {
    case 1:
      return [1 - py, px];
    case 2:
      return [1 - px, 1 - py];
    case 3:
      return [py, 1 - px];
    default:
      return [px, py];
  }
}

/** A box (x, y, w, h as parts of the picture, e.g. a face) in the turned picture. */
export function turnBox<T extends { x: number; y: number; w: number; h: number }>(b: T, r: Quarter): T {
  switch (r) {
    case 1:
      return { ...b, x: 1 - b.y - b.h, y: b.x, w: b.h, h: b.w };
    case 2:
      return { ...b, x: 1 - b.x - b.w, y: 1 - b.y - b.h };
    case 3:
      return { ...b, x: b.y, y: 1 - b.x - b.w, w: b.h, h: b.w };
    default:
      return b;
  }
}

/**
 * Style for an element (video, plain picture) that fills the W × H stage and
 * should show turned: for a quarter turn it is laid out H × W, centred, then
 * turned, so `object-fit` fits the turned shape.
 */
export function turnedStyle(r: Quarter, W: number, H: number): CSSProperties | undefined {
  if (!r) return undefined;
  const odd = r % 2 === 1;
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: odd ? H : W,
    height: odd ? W : H,
    transform: `translate(-50%, -50%) rotate(${r * 90}deg)`,
  };
}

/** "Rotated 90° right" for the badge and messages. */
export function turnLabel(r: Quarter): string {
  return r === 1 ? 'Rotated 90° right' : r === 2 ? 'Rotated 180°' : r === 3 ? 'Rotated 90° left' : 'Not rotated';
}

export type SaveWay =
  | { way: 'jpeg' }
  | { way: 'pixels'; mime: 'image/png' | 'image/webp' }
  | { way: 'gif' }
  | { way: 'video' }
  | { way: 'no'; why: string };

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** How "Save rotation" keeps an item turned (by its kind and name). */
export function saveWay(kind: string, name: string): SaveWay {
  const ext = extOf(name);
  if (kind === 'image') {
    if (['jpg', 'jpeg', 'jpe', 'jfif'].includes(ext)) return { way: 'jpeg' };
    if (ext === 'png') return { way: 'pixels', mime: 'image/png' };
    if (ext === 'webp') return { way: 'pixels', mime: 'image/webp' };
    return { way: 'no', why: "This kind of picture can't be saved rotated." };
  }
  if (kind === 'gif') {
    if (ext === 'gif') return { way: 'gif' };
    return { way: 'no', why: "Animated WebP pictures can't be saved rotated yet. The rotation stays while you look at it." };
  }
  if (kind === 'video') {
    if (ext === 'mp4' || ext === 'm4v') return { way: 'video' };
    return { way: 'no', why: `Saving the rotation works for MP4 videos; this one is ${ext.toUpperCase() || 'another kind'}. The rotation stays while you watch.` };
  }
  return { way: 'no', why: "This can't be rotated." };
}

/** A PNG that moves (APNG): turning it as a still would lose the animation. */
export function isAnimatedPng(b: Uint8Array): boolean {
  let i = 8;
  while (i + 8 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + len;
  }
  return false;
}

/** A WebP stored losslessly (VP8L): saved losslessly again. */
export function isLosslessWebp(b: Uint8Array): boolean {
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 16 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return false;
  let i = 12;
  while (i + 8 <= b.length) {
    const t = tag(i);
    if (t === 'VP8L') return true;
    if (t === 'VP8 ') return false;
    const len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    i += 8 + len + (len & 1);
  }
  return false;
}

/** How often a GIF loops (NETSCAPE block): 0 = forever, null = plays once. */
export function gifLoops(b: Uint8Array): number | null {
  const sig = [0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]; // NETSCAPE2.0
  outer: for (let i = 0; i + sig.length + 5 <= b.length; i++) {
    for (let k = 0; k < sig.length; k++) if (b[i + k] !== sig[k]) continue outer;
    const j = i + sig.length;
    if (b[j] === 3 && b[j + 1] === 1) return b[j + 2] | (b[j + 3] << 8);
    return 0;
  }
  return null;
}

/** RGBA pixels turned `r` (w × h in, the turned size out). */
export function turnPixels(px: Uint8ClampedArray | Uint8Array, w: number, h: number, r: Quarter): { data: Uint8ClampedArray; w: number; h: number } {
  const { w: ow, h: oh } = turnedSize({ w, h }, r);
  const out = new Uint8ClampedArray(ow * oh * 4);
  const src = new Uint32Array(px.buffer, px.byteOffset, w * h);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (r === 1) [nx, ny] = [h - 1 - y, x];
      else if (r === 2) [nx, ny] = [w - 1 - x, h - 1 - y];
      else if (r === 3) [nx, ny] = [y, w - 1 - x];
      else [nx, ny] = [x, y];
      dst[ny * ow + nx] = src[y * w + x];
    }
  }
  return { data: out, w: ow, h: oh };
}

/**
 * One GIF frame: its exact colours when there are 256 or fewer (GIF frames
 * nearly always are, so turning loses nothing), otherwise the nearest 256.
 * Pixels under half opacity become the see-through colour.
 */
export function gifFrame(rgba: Uint8ClampedArray | Uint8Array): { palette: number[][]; index: Uint8Array; transparent: number; exact: boolean } {
  const n = rgba.length >> 2;
  const index = new Uint8Array(n);
  const palette: number[][] = [];
  const seen = new Map<number, number>();
  let transparent = -1;
  let exact = true;
  for (let i = 0; i < n && exact; i++) {
    const o = i * 4;
    let k: number | undefined;
    if (rgba[o + 3] < 128) {
      if (transparent < 0 && palette.length < 256) {
        transparent = palette.length;
        palette.push([0, 0, 0]);
      }
      k = transparent < 0 ? undefined : transparent;
    } else {
      const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
      k = seen.get(key);
      if (k === undefined && palette.length < 256) {
        k = palette.length;
        seen.set(key, k);
        palette.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
      }
    }
    if (k === undefined) exact = false;
    else index[i] = k;
  }
  if (exact) return { palette, index, transparent, exact };
  const data = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length);
  const pal = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true } as { format: string });
  return { palette: pal, index: applyPalette(data, pal, 'rgba4444'), transparent: pal.findIndex((p) => p.length > 3 && p[3] === 0), exact: false };
}
