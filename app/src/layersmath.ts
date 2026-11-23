// More layers and Border fill for 3D photos (still pictures only), the pixel
// maths (run in lookworker.ts, tested directly; drawn by Depth3D.tsx;
// docs/picture-3d-looks-plan.md):
//
// More layers: the depth map is cut at its real depth jumps (where depth
// changes suddenly across a few pixels, never along a slope such as a floor
// going into the distance), into up to 3 or 4 layers from far (0) to near.
// The subject outline, when there and nearer than what's around it, is always
// one cut. Each layer but the nearest gets a band behind the nearer things
// filled in (colour and depth, from its own side only), only along the real
// jumps: elsewhere it keeps the picture itself, so layers meeting along a
// slope show the very same pixels and leave no seam. Its coverage (where it
// is the surface) says which layer is seen where; the farthest covers all.
//
// Border fill: the picture placed in the middle of a bigger canvas, the ring
// around it filled (a fill model, or Simple: pulled out from the edge), its
// depth carried straight out from the edge. A plain one-colour edge (black
// bars, a white frame) is simply carried on in that colour, no painting.

import type { DepthMap, SubjectMask } from './api';
import { boxBlur, distanceTo, fillRgba, pushPull, resample } from './layers';
import { resizeRgba, SIMPLE_SIDE } from './platemath';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- More layers ---------------------------------------------------------------------------------

export type CutSize = 'small' | 'medium' | 'big';

/** How big a depth jump (levels across 4 pixels of the depth map) makes a cut. */
export function cutJump(cut: CutSize): number {
  return cut === 'small' ? 11 : cut === 'big' ? 30 : 18;
}

export interface LayerPlan {
  /** The depth map's size (everything below is at this size). */
  w: number;
  h: number;
  /** Layers, 2–4 (far 0 … near n − 1). */
  n: number;
  /** Each pixel's layer. */
  cls: Uint8Array;
  /** For each layer but the nearest: the band behind nearer things that is filled in (0 / 255). */
  holes: Uint8Array[];
}

/** Bits smaller than this share of the picture are not layers of their own (hair, leaves, fences). */
const MIN_AREA = 0.004;
/** How far behind a jump the filled band reaches (share of the depth map's shorter side). */
const BAND = 0.07;

/**
 * Where the picture is cut into layers (null: no clear jumps and no subject, so
 * nothing to cut: the picture is drawn as it is).
 */
export function planLayers(depth: DepthMap, mask: SubjectMask | null, max: number, cut: CutSize): LayerPlan | null {
  const { w, h, data } = depth;
  const n0 = w * h;
  if (w < 8 || h < 8 || data.length < n0) return null;
  const most = clamp(Math.round(max), 2, 4);
  const T = cutJump(cut);
  const f = new Float32Array(n0);
  for (let i = 0; i < n0; i++) f[i] = data[i];
  const D = boxBlur(f, w, h, 1);
  const at = (x: number, y: number) => D[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];

  // The subject: its own nearest layer when it stands out from what's around it.
  let subj: Uint8Array | null = null;
  if (mask && mask.w > 0 && mask.h > 0) {
    const m = resample(mask.data, mask.w, mask.h, w, h);
    const inside = new Uint8Array(n0);
    let cnt = 0;
    let sIn = 0;
    for (let i = 0; i < n0; i++)
      if (m[i] >= 128) {
        inside[i] = 1;
        cnt++;
        sIn += D[i];
      }
    if (cnt >= n0 * MIN_AREA && cnt <= n0 * 0.9) {
      // Its surroundings: a ring just outside it.
      const dist = distanceTo(inside, w, h);
      const ring = Math.max(2, Math.round(Math.min(w, h) * 0.03));
      let sOut = 0;
      let nOut = 0;
      for (let i = 0; i < n0; i++)
        if (!inside[i] && dist[i] <= ring) {
          sOut += D[i];
          nOut++;
        }
      if (nOut > 0 && sIn / cnt - sOut / nOut >= T * 0.5) subj = inside;
    }
  }

  // Real jumps: the depth either side of each, weighted by how big the jump is.
  // Each jump's two sides (far, near) and size; a jump between them is split by any cut level in between.
  // A real depth model's jump is soft (a ramp over several pixels): its two sides are read across the
  // whole ramp (the farthest and nearest depth a little way round it, any direction), so every pixel
  // on it votes for the same cut in its middle and the ramp itself never becomes thin layers of its
  // own (a rim round a person).
  const R = Math.max(4, Math.round(Math.min(w, h) * 0.02));
  const lo = squareMinMax(D, w, h, R, false);
  const hi = squareMinMax(D, w, h, R, true);
  const pairs: number[] = [];
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      const d = Math.max(Math.abs(at(x - 2, y) - at(x + 2, y)), Math.abs(at(x, y - 2) - at(x, y + 2)));
      if (d < T) continue;
      const i = y * w + x;
      pairs.push(lo[i], hi[i], d);
    }
  // The strongest few cut levels, far enough apart; each needs a jump line of a few per cent of the
  // picture. A jump that a level already splits doesn't vote again (a box in front of both a table and
  // the wall behind needs no cut of its own between the two).
  const need = (w + h) * 0.04 * T;
  const want = most - 1 - (subj ? 1 : 0);
  const levels: number[] = [];
  const used = new Uint8Array(256);
  const split = new Uint8Array(pairs.length / 3);
  while (levels.length < want && pairs.length) {
    const hist = new Float32Array(256);
    for (let k = 0; k < split.length; k++) {
      if (split[k]) continue;
      hist[clamp(Math.round((pairs[k * 3] + pairs[k * 3 + 1]) / 2), 0, 255)] += pairs[k * 3 + 2];
    }
    const sm = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      let t = 0;
      for (let d = -4; d <= 4; d++) t += hist[clamp(v + d, 0, 255)];
      sm[v] = t;
    }
    let best = -1;
    for (let v = 8; v < 248; v++) if (!used[v] && (best < 0 || sm[v] > sm[best])) best = v;
    if (best < 0 || sm[best] < need) break;
    levels.push(best);
    for (let d = -24; d <= 24; d++) used[clamp(best + d, 0, 255)] = 1;
    for (let k = 0; k < split.length; k++) if (pairs[k * 3] < best && pairs[k * 3 + 1] > best) split[k] = 1;
  }
  levels.sort((a, b) => a - b);
  if (!levels.length && !subj) return null;

  // Each pixel's layer: how many cut levels it is nearer than; the subject on top.
  // On a jump's ramp the cut is made in the middle of that jump (not at the level, which is shared by
  // every jump it splits), so no rim of the near thing stays on the far layer, or the other way round.
  const cls = new Uint8Array(n0);
  for (let i = 0; i < n0; i++) {
    let c = 0;
    const ramp = hi[i] - lo[i] >= T;
    const mid = (lo[i] + hi[i]) / 2;
    for (const l of levels) if (D[i] > (ramp && lo[i] < l && hi[i] > l ? mid : l)) c++;
    cls[i] = c;
  }
  let n = levels.length + 1;
  if (subj) {
    for (let i = 0; i < n0; i++) if (subj[i]) cls[i] = n;
    n++;
  }
  // (Again until nothing changes: a bit can be joined to one that is itself joined later.)
  for (let pass = 0; pass < 4 && dropSmallBits(cls, w, h, Math.round(n0 * MIN_AREA)); pass++);
  // A layer that lost all its pixels is gone: the rest close up.
  const seen = new Uint8Array(n);
  for (let i = 0; i < n0; i++) seen[cls[i]] = 1;
  const remap = new Uint8Array(n);
  let k = 0;
  for (let c = 0; c < n; c++) if (seen[c]) remap[c] = k++;
  if (k < n) for (let i = 0; i < n0; i++) cls[i] = remap[cls[i]];
  n = k;
  if (n < 2) return null;

  // The band behind nearer things, only where the step down to this layer (or farther) is a real jump.
  const band = Math.max(3, Math.round(Math.min(w, h) * BAND));
  const holes: Uint8Array[] = [];
  for (let j = 0; j < n - 1; j++) {
    const seeds = new Uint8Array(n0);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cls[i] <= j) continue;
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (cls[q] > j) continue;
          // A real jump, or the subject's own edge.
          if (D[i] - D[q] >= T * 0.6 || (subj && subj[i] && !subj[q])) {
            seeds[i] = 1;
            break;
          }
        }
      }
    const dist = distanceTo(seeds, w, h);
    const hole = new Uint8Array(n0);
    let any = false;
    for (let i = 0; i < n0; i++)
      if (cls[i] > j && dist[i] <= band) {
        hole[i] = 255;
        any = true;
      }
    holes.push(any ? hole : new Uint8Array(n0));
  }
  return { w, h, n, cls, holes };
}

/** The smallest (or largest) value within `r` pixels each way (a square), for every pixel. */
function squareMinMax(v: Float32Array, w: number, h: number, r: number, max: boolean): Float32Array {
  const s = max ? 1 : -1;
  const row = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let m = v[o + x] * s;
      const e = Math.min(w - 1, x + r);
      for (let k = Math.max(0, x - r); k <= e; k++) {
        const t = v[o + k] * s;
        if (t > m) m = t;
      }
      row[o + x] = m;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const e = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let m = row[y * w + x];
      for (let k = Math.max(0, y - r); k <= e; k++) {
        const t = row[k * w + x];
        if (t > m) m = t;
      }
      out[y * w + x] = m * s;
    }
  }
  return out;
}

/** Bits of a layer smaller than `minArea` pixels, or thin slivers, join the layer most of their border touches. */
function dropSmallBits(cls: Uint8Array, w: number, h: number, minArea: number): boolean {
  const n = w * h;
  let changed = false;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const bit: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const c = cls[s];
    bit.length = 0;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    const touch = new Map<number, number>();
    while (top) {
      const i = stack[--top];
      bit.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const q of nb) {
        if (q < 0) continue;
        if (cls[q] === c) {
          if (!seen[q]) {
            seen[q] = 1;
            stack[top++] = q;
          }
        } else touch.set(cls[q], (touch.get(cls[q]) ?? 0) + 1);
      }
    }
    if (!touch.size) continue;
    // A thin sliver (the soft edge of a jump crossing a cut level): hardly a pixel inside it.
    let inner = 0;
    if (bit.length >= minArea) {
      for (const i of bit) {
        const x = i % w;
        const y = (i - x) / w;
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && cls[i - 1] === c && cls[i + 1] === c && cls[i - w] === c && cls[i + w] === c) inner++;
      }
      if (inner >= bit.length * 0.3) continue;
    }
    let to = c;
    let best = -1;
    for (const [k, v] of touch) if (v > best) [to, best] = [k, v];
    for (const i of bit) cls[i] = to;
    changed = true;
  }
  return changed;
}

/** The area a fill model fills for layer `j` (all of what's nearer, so it never copies their colours), at its square size (0 / 255). */
export function layerModelHole(plan: LayerPlan, j: number, side: number): Uint8Array {
  const near = new Float32Array(plan.w * plan.h);
  for (let i = 0; i < near.length; i++) near[i] = plan.cls[i] > j ? 1 : 0;
  const r = resample(near, plan.w, plan.h, side, side);
  const out = new Uint8Array(side * side);
  for (let i = 0; i < out.length; i++) out[i] = r[i] > 0.02 ? 255 : 0;
  return out;
}

/**
 * Layer `j` at the picture's size `w` × `h`: RGBA, the picture with its band
 * (and all behind nearer things, but right along a jump-free meeting) filled in
 * (`fill`: a model's result for this layer, any size, or Simple when
 * null; the nearest layer has no band), alpha = its own depth: the layer's
 * surface (its pixels, and its band filled from its own side) carried straight
 * out past its edges, so marching it never meets the picture's soft depth ramp
 * at its rim (which would stretch its edge): beyond its edge it is simply not
 * the surface (its coverage), and the layer behind shows.
 */
export function composeLayer(orig: ArrayLike<number>, w: number, h: number, depth: DepthMap, plan: LayerPlan, j: number, fill: { data: ArrayLike<number>; w: number; h: number } | null): Uint8Array {
  const pw = plan.w;
  const ph = plan.h;
  const known = new Float32Array(pw * ph);
  for (let i = 0; i < known.length; i++) known[i] = plan.cls[i] <= j ? 1 : 0;
  const hole = plan.holes[j] ?? new Uint8Array(pw * ph);
  // The band's depth: pulled in from this layer's side only.
  const df = pushPull(depth.data, known, pw, ph);
  const surf = new Float32Array(pw * ph);
  const on = new Float32Array(pw * ph);
  for (let i = 0; i < surf.length; i++) {
    if (plan.cls[i] === j) {
      surf[i] = depth.data[i];
      on[i] = 1;
    } else if (hole[i]) {
      surf[i] = df[i];
      on[i] = 1;
    }
  }
  const own = pushPull(surf, on, pw, ph);
  const dBig = resample(own, pw, ph, w, h);
  // The colour is filled in the band and everywhere further in behind nearer things too (a big camera
  // move, Border fill's Bigger moves, can see past the band: never a copy of the near thing there).
  // Only right along a meeting with no jump (a slope crossing a cut) the picture's own pixels stay.
  const distKnown = distanceTo(known, pw, ph);
  const hf = new Float32Array(pw * ph);
  for (let i = 0; i < hf.length; i++) hf[i] = hole[i] || (plan.cls[i] > j && distKnown[i] > 2) ? 1 : 0;
  const hBig = resample(hf, pw, ph, w, h);
  // The colour: the model's, or Simple from this layer's side on a small copy.
  let F: ArrayLike<number>;
  if (fill) F = resizeRgba(fill.data, fill.w, fill.h, w, h);
  else {
    const ks = Math.min(1, SIMPLE_SIDE / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * ks));
    const sh = Math.max(1, Math.round(h * ks));
    const small = resizeRgba(orig, w, h, sw, sh);
    const unknown = resample(known.map((k) => 1 - k), pw, ph, sw, sh);
    F = resizeRgba(fillRgba(small, sw, sh, unknown), sw, sh, w, h);
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = hBig[i] > 0.5 ? 1 : hBig[i] * 2;
    const o = i * 4;
    out[o] = Math.round(orig[o] + (F[o] - orig[o]) * a);
    out[o + 1] = Math.round(orig[o + 1] + (F[o + 1] - orig[o + 1]) * a);
    out[o + 2] = Math.round(orig[o + 2] + (F[o + 2] - orig[o + 2]) * a);
    out[o + 3] = Math.round(clamp(dBig[i], 0, 255));
  }
  return out;
}

/**
 * Where each layer is the surface, for the shader: RGBA at the depth map's
 * size, R/G/B = layers 1, 2, 3 (layer 0, the farthest, covers everything):
 * the layer itself plus its filled band, softened by a pixel.
 */
export function layerCoverage(plan: LayerPlan): Uint8Array {
  const { w, h, n, cls, holes } = plan;
  const out = new Uint8Array(w * h * 4);
  for (let c = 0; c < 3; c++) {
    const j = c + 1;
    if (j >= n) continue;
    const m = new Float32Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = cls[i] === j || (j < n - 1 && holes[j][i]) ? 255 : 0;
    const b = boxBlur(m, w, h, 1);
    for (let i = 0; i < m.length; i++) out[i * 4 + c] = Math.round(b[i]);
  }
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = 255;
  return out;
}

/** The saved form of a plan's layers is checked against this (made again when the cut changed). */
export function planKey(plan: LayerPlan): string {
  let s = 0;
  for (let i = 0; i < plan.cls.length; i += 7) s = (s * 31 + plan.cls[i]) >>> 0;
  return `${plan.n}${s.toString(36)}`;
}

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
