// The picture editor's sums (components/ImageEditor.tsx), kept apart so they
// can be tested: turning and flipping, straightening (the crop shrinks so no
// empty corners show), cropping with or without a fixed shape, and the light
// and colour changes done on the pixels. The same sums draw the live preview
// and the full-size copy, so what you see is what is saved.

import { turnedSize, turnMatrix, type Quarter } from './rotation';

export type Aspect = 'free' | 'original' | '1:1' | '4:3' | '3:2' | '16:9' | '9:16';
export const ASPECTS: { id: Aspect; label: string }[] = [
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: '1:1', label: '1:1' },
  { id: '4:3', label: '4:3' },
  { id: '3:2', label: '3:2' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
];

/** Straightening goes this far either way (degrees). */
export const MAX_ANGLE = 15;

/** A crop as parts (0…1) of the frame: the turned, straightened picture. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

/** Light and colour, each −100…100 (sharpness 0…100); 0 = unchanged. */
export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  sharpness: number;
}
export const NO_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0, warmth: 0, sharpness: 0 };

export interface Edit {
  /** Clockwise quarter turns. */
  quarter: Quarter;
  flipH: boolean;
  flipV: boolean;
  /** Straighten, degrees clockwise (−15…15). */
  angle: number;
  aspect: Aspect;
  crop: Crop;
  adjust: Adjust;
}
export const NO_EDIT: Edit = { quarter: 0, flipH: false, flipV: false, angle: 0, aspect: 'free', crop: FULL, adjust: NO_ADJUST };

export type Matrix = [number, number, number, number, number, number];

/** a ∘ b: b first, then a (canvas setTransform order: x' = a·x + c·y + e, y' = b·x + d·y + f). */
export function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  const [a, b, c, d] = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
const move = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
const scale = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0];
const rotate = (rad: number): Matrix => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];

export const clampAngle = (a: number) => Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, Number.isFinite(a) ? a : 0));

/**
 * How much a w × h picture turned `deg` must shrink (same shape) so that no
 * empty corner shows: the largest w·k × h·k box that fits inside it.
 */
export function straightenScale(w: number, h: number, deg: number): number {
  const t = (Math.abs(clampAngle(deg)) * Math.PI) / 180;
  if (t === 0 || w <= 0 || h <= 0) return 1;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return Math.min(w / (w * c + h * s), h / (w * s + h * c));
}

/** The frame (turned, straightened, before cropping) of a W × H picture, in its pixels. */
export function frameSize(W: number, H: number, e: Pick<Edit, 'quarter' | 'angle'>): { w: number; h: number } {
  const o = turnedSize({ w: W, h: H }, e.quarter);
  const k = straightenScale(o.w, o.h, e.angle);
  return { w: o.w * k, h: o.h * k };
}

/** The shape (width / height) a crop keeps, or null for Free. "Original" is the turned picture's own shape. */
export function aspectRatio(a: Aspect, frame: { w: number; h: number }): number | null {
  switch (a) {
    case 'free':
      return null;
    case 'original':
      return frame.w / frame.h;
    default: {
      const [x, y] = a.split(':').map(Number);
      return x / y;
    }
  }
}

/** The biggest crop of that shape, in the middle of the frame. */
export function fitAspect(ratio: number | null, frame: { w: number; h: number }): Crop {
  if (!ratio) return FULL;
  let w = frame.w;
  let h = w / ratio;
  if (h > frame.h) {
    h = frame.h;
    w = h * ratio;
  }
  const cw = w / frame.w;
  const ch = h / frame.h;
  return { x: (1 - cw) / 2, y: (1 - ch) / 2, w: cw, h: ch };
}

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * The crop after dragging `handle` by (dx, dy) frame pixels, kept inside the
 * frame, not smaller than `minPx`, and (with a fixed shape) keeping its shape.
 */
export function dragCrop(c: Crop, handle: Handle, dx: number, dy: number, ratio: number | null, frame: { w: number; h: number }, minPx = 16): Crop {
  const FW = frame.w;
  const FH = frame.h;
  const min = Math.min(minPx, FW / 2, FH / 2);
  let l = c.x * FW;
  let t = c.y * FH;
  let r = (c.x + c.w) * FW;
  let b = (c.y + c.h) * FH;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (handle === 'move') {
    const w = r - l;
    const h = b - t;
    l = clamp(l + dx, 0, FW - w);
    t = clamp(t + dy, 0, FH - h);
    return { x: l / FW, y: t / FH, w: w / FW, h: h / FH };
  }
  const W = handle.includes('w');
  const E = handle.includes('e');
  const N = handle.includes('n');
  const S = handle.includes('s');
  if (W) l = clamp(l + dx, 0, r - min);
  if (E) r = clamp(r + dx, l + min, FW);
  if (N) t = clamp(t + dy, 0, b - min);
  if (S) b = clamp(b + dy, t + min, FH);
  if (ratio) {
    if ((W || E) && (N || S)) {
      // A corner: the width leads; the height follows from the opposite corner, which stays put.
      let w = r - l;
      let h = w / ratio;
      const room = N ? b : FH - t;
      if (h > room) {
        h = room;
        w = h * ratio;
      }
      if (W) l = r - w;
      else r = l + w;
      if (N) t = b - h;
      else b = t + h;
    } else if (W || E) {
      let w = r - l;
      const cy = (t + b) / 2;
      let h = w / ratio;
      const room = 2 * Math.min(cy, FH - cy);
      if (h > room) {
        h = room;
        w = h * ratio;
        if (W) l = r - w;
        else r = l + w;
      }
      t = cy - h / 2;
      b = cy + h / 2;
    } else {
      let h = b - t;
      const cx = (l + r) / 2;
      let w = h * ratio;
      const room = 2 * Math.min(cx, FW - cx);
      if (w > room) {
        w = room;
        h = w / ratio;
        if (N) t = b - h;
        else b = t + h;
      }
      l = cx - w / 2;
      r = cx + w / 2;
    }
  }
  return { x: l / FW, y: t / FH, w: (r - l) / FW, h: (b - t) / FH };
}

/** Size of the saved picture (whole pixels). */
export function outputSize(W: number, H: number, e: Edit): { w: number; h: number } {
  const f = frameSize(W, H, e);
  return { w: Math.max(1, Math.round(e.crop.w * f.w)), h: Math.max(1, Math.round(e.crop.h * f.h)) };
}

/**
 * The canvas transform that draws the W × H picture as edited: turned, flipped,
 * straightened about its middle, then cropped; `k` scales the result (the
 * preview is smaller). Draw the picture at (0, 0) with it.
 */
export function editMatrix(W: number, H: number, e: Edit, k = 1): Matrix {
  const o = turnedSize({ w: W, h: H }, e.quarter);
  const f = frameSize(W, H, e);
  const turnM = turnMatrix(e.quarter, 0, 0, o.w, o.h) as Matrix;
  const flipM: Matrix = [e.flipH ? -1 : 1, 0, 0, e.flipV ? -1 : 1, e.flipH ? o.w : 0, e.flipV ? o.h : 0];
  let m = mul(flipM, turnM);
  m = mul(move(-o.w / 2, -o.h / 2), m);
  m = mul(rotate((clampAngle(e.angle) * Math.PI) / 180), m);
  m = mul(move(f.w / 2 - e.crop.x * f.w, f.h / 2 - e.crop.y * f.h), m);
  return mul(scale(k), m);
}

export const sameAdjust = (a: Adjust, b: Adjust) =>
  a.brightness === b.brightness && a.contrast === b.contrast && a.saturation === b.saturation && a.warmth === b.warmth && a.sharpness === b.sharpness;
export const hasAdjust = (a: Adjust) => !sameAdjust(a, NO_ADJUST);
const fullCrop = (c: Crop) => Math.abs(c.x) < 1e-6 && Math.abs(c.y) < 1e-6 && Math.abs(c.w - 1) < 1e-6 && Math.abs(c.h - 1) < 1e-6;

/** Nothing changed at all. */
export function isUnchanged(e: Edit): boolean {
  return e.quarter === 0 && isRotationOnly(e);
}

/** Only turned by quarter turns (or not at all): the rotation can be saved to the original instead. */
export function isRotationOnly(e: Edit): boolean {
  return !e.flipH && !e.flipV && Math.abs(e.angle) < 1e-6 && fullCrop(e.crop) && !hasAdjust(e.adjust);
}

/**
 * Light and colour, on RGBA pixels in place (see-through stays as it was).
 * Brightness and contrast work through a table; saturation keeps each pixel's
 * brightness; warmth moves it towards orange (or blue); sharpness is an unsharp mask.
 */
export function adjustPixels(px: Uint8ClampedArray, w: number, h: number, a: Adjust): void {
  if (!hasAdjust(a)) return;
  const b = (a.brightness / 100) * 96;
  const c = a.contrast >= 0 ? 1 + (a.contrast / 100) * 1.4 : 1 + (a.contrast / 100) * 0.85;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round((i + b - 127.5) * c + 127.5);
  const sat = 1 + a.saturation / 100;
  const warm = (a.warmth / 100) * 32;
  const tone = a.brightness !== 0 || a.contrast !== 0;
  const colour = a.saturation !== 0 || a.warmth !== 0;
  if (tone || colour) {
    for (let i = 0; i < px.length; i += 4) {
      let r = px[i];
      let g = px[i + 1];
      let bl = px[i + 2];
      if (tone) {
        r = lut[r];
        g = lut[g];
        bl = lut[bl];
      }
      if (colour) {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        r = y + (r - y) * sat + warm;
        g = y + (g - y) * sat + warm * 0.25;
        bl = y + (bl - y) * sat - warm;
      }
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = bl;
    }
  }
  if (a.sharpness > 0 && w > 2 && h > 2) sharpen(px, w, h, (a.sharpness / 100) * 1.6);
}

/** Unsharp mask with a 3 × 3 blur: each pixel moves away from its neighbours' average. */
function sharpen(px: Uint8ClampedArray, w: number, h: number, amount: number) {
  const src = new Uint8ClampedArray(px);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? -row : 0;
    const y1 = y < h - 1 ? row : 0;
    for (let x = 0; x < w; x++) {
      const i = y * row + x * 4;
      const x0 = x > 0 ? -4 : 0;
      const x1 = x < w - 1 ? 4 : 0;
      for (let ch = 0; ch < 3; ch++) {
        const j = i + ch;
        const blur = (src[j + y0 + x0] + src[j + y0] + src[j + y0 + x1] + src[j + x0] + src[j] + src[j + x1] + src[j + y1 + x0] + src[j + y1] + src[j + y1 + x1]) / 9;
        px[j] = src[j] + (src[j] - blur) * amount;
      }
    }
  }
}

/** How the copy is saved: JPEG pictures as JPEG (quality 95), PNG and see-through pictures as PNG, others as JPEG. */
export function savedFormat(name: string, seeThrough: boolean): { mime: 'image/jpeg' | 'image/png'; ext: 'jpg' | 'png'; quality?: number } {
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
  if (ext === 'png' || seeThrough) return { mime: 'image/png', ext: 'png' };
  return { mime: 'image/jpeg', ext: 'jpg', quality: 0.95 };
}

/** "Beach.jpg" → "Beach (edited).jpg" */
export function editedName(name: string, ext: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim() || 'Picture';
  return `${base} (edited).${ext}`;
}

/** Whether any pixel is see-through. */
export function anySeeThrough(px: Uint8ClampedArray): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return true;
  return false;
}

/** Turned a further quarter `by` (the crop starts over; a fixed shape is fitted again). */
export function turnEdit(e: Edit, by: number, W: number, H: number): Edit {
  const quarter = ((((e.quarter + by) % 4) + 4) % 4) as Quarter;
  const next = { ...e, quarter };
  return { ...next, crop: fitAspect(aspectRatio(e.aspect, frameSize(W, H, next)), frameSize(W, H, next)) };
}
