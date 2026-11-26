// Border fill for 3D photos (still pictures only), the pixel maths (run in
// lookworker.ts, tested directly; drawn by Depth3D.tsx;
// docs/picture-3d-looks-plan.md; More layers was removed 2026-11-27):
//
// Border fill: the picture placed in the middle of a bigger canvas, the ring
// around it filled (a fill model, or Simple: pulled out from the edge), its
// depth carried straight out from the edge. A plain one-colour edge (black
// bars, a white frame) is simply carried on in that colour, no painting.

import type { DepthMap } from './api';
import { fillRgba, resample } from './layers';
import { resizeRgba, SIMPLE_SIDE } from './platemath';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- Border fill ---------------------------------------------------------------------------------

/** A one-colour edge (black bars, a frame): its strip barely varies. */
function plainEdge(orig: ArrayLike<number>, w: number, h: number, side: 'top' | 'bottom' | 'left' | 'right'): boolean {
  const strip = Math.max(1, Math.min(3, Math.floor(Math.min(w, h) / 50)));
  let n = 0;
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  const add = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      sum[c] += orig[o + c];
      sq[c] += orig[o + c] * orig[o + c];
    }
    n++;
  };
  for (let k = 0; k < strip; k++) {
    if (side === 'top' || side === 'bottom') {
      const y = side === 'top' ? k : h - 1 - k;
      for (let x = 0; x < w; x += 2) add(x, y);
    } else {
      const x = side === 'left' ? k : w - 1 - k;
      for (let y = 0; y < h; y += 2) add(x, y);
    }
  }
  if (!n) return false;
  for (let c = 0; c < 3; c++) {
    const m = sum[c] / n;
    if (sq[c] / n - m * m > 30) return false;
  }
  return true;
}

export interface BorderCanvas {
  /** The bigger canvas: the picture in the middle, its edge pixels carried straight out into the ring. */
  data: Uint8ClampedArray;
  W: number;
  H: number;
  /** What gets painted (0–1, W × H): the ring, except along plain one-colour edges. */
  hole: Float32Array;
}

/** The picture (`w` × `h`) in the middle of a canvas `b` pixels bigger each way. */
export function borderCanvas(orig: ArrayLike<number>, w: number, h: number, b: number): BorderCanvas {
  const W = w + 2 * b;
  const H = h + 2 * b;
  const data = new Uint8ClampedArray(W * H * 4);
  const hole = new Float32Array(W * H);
  const plain = { top: plainEdge(orig, w, h, 'top'), bottom: plainEdge(orig, w, h, 'bottom'), left: plainEdge(orig, w, h, 'left'), right: plainEdge(orig, w, h, 'right') };
  for (let y = 0; y < H; y++) {
    const sy = clamp(y - b, 0, h - 1);
    for (let x = 0; x < W; x++) {
      const sx = clamp(x - b, 0, w - 1);
      const o = (y * W + x) * 4;
      const s = (sy * w + sx) * 4;
      data[o] = orig[s];
      data[o + 1] = orig[s + 1];
      data[o + 2] = orig[s + 2];
      data[o + 3] = 255;
      const inX = x >= b && x < b + w;
      const inY = y >= b && y < b + h;
      if (inX && inY) continue;
      // Beyond a plain edge only (or a corner between two plain edges): carried on as it is.
      const offL = x < b;
      const offR = x >= b + w;
      const offT = y < b;
      const offB = y >= b + h;
      const plainHere = (!offL || plain.left) && (!offR || plain.right) && (!offT || plain.top) && (!offB || plain.bottom);
      hole[y * W + x] = plainHere ? 0 : 1;
    }
  }
  return { data, W, H, hole };
}

/** Whether a border canvas needs painting at all (every edge plain: no). */
export function borderNeedsFill(c: BorderCanvas): boolean {
  for (let i = 0; i < c.hole.length; i++) if (c.hole[i] > 0) return true;
  return false;
}

/** The hole for a fill model at its square size (0 / 255). */
export function borderModelHole(c: BorderCanvas, side: number): Uint8Array {
  const r = resample(c.hole, c.W, c.H, side, side);
  const out = new Uint8Array(side * side);
  for (let i = 0; i < out.length; i++) out[i] = r[i] > 0.02 ? 255 : 0;
  return out;
}

/**
 * The border plate (RGBA, W × H): the canvas with its ring painted (`fill`: a
 * model's result, any size, or Simple when null), alpha = the depth carried
 * straight out from the picture's edge (`b` pixels of border on a `w` × `h` picture).
 */
export function composeBorder(c: BorderCanvas, w: number, h: number, b: number, depth: DepthMap, fill: { data: ArrayLike<number>; w: number; h: number } | null): Uint8Array {
  const { W, H, data, hole } = c;
  let F: ArrayLike<number> = data;
  if (borderNeedsFill(c)) {
    if (fill) F = resizeRgba(fill.data, fill.w, fill.h, W, H);
    else {
      const ks = Math.min(1, SIMPLE_SIDE / Math.max(W, H));
      const sw = Math.max(1, Math.round(W * ks));
      const sh = Math.max(1, Math.round(H * ks));
      const small = resizeRgba(data, W, H, sw, sh);
      F = resizeRgba(fillRgba(small, sw, sh, resample(hole, W, H, sw, sh)), sw, sh, W, H);
    }
  }
  const out = new Uint8Array(W * H * 4);
  const dw = depth.w;
  const dh = depth.h;
  for (let y = 0; y < H; y++) {
    // The depth of the nearest point of the picture (its edge carried straight out), bilinear.
    const fy = clamp(((clamp(y - b, 0, h - 1) + 0.5) / h) * dh - 0.5, 0, dh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(dh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = clamp(((clamp(x - b, 0, w - 1) + 0.5) / w) * dw - 0.5, 0, dw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(dw - 1, x0 + 1);
      const tx = fx - x0;
      const d0 = depth.data[y0 * dw + x0] + (depth.data[y0 * dw + x1] - depth.data[y0 * dw + x0]) * tx;
      const d1 = depth.data[y1 * dw + x0] + (depth.data[y1 * dw + x1] - depth.data[y1 * dw + x0]) * tx;
      const i = y * W + x;
      const o = i * 4;
      const a = hole[i];
      out[o] = Math.round(data[o] + (F[o] - data[o]) * a);
      out[o + 1] = Math.round(data[o + 1] + (F[o + 1] - data[o + 1]) * a);
      out[o + 2] = Math.round(data[o + 2] + (F[o + 2] - data[o + 2]) * a);
      out[o + 3] = Math.round(d0 + (d1 - d0) * ty);
    }
  }
  return out;
}
