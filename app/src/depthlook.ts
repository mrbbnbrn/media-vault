// The 3D looks for still pictures (docs/picture-3d-looks-plan.md), the maths
// only (tested directly; drawn by Depth3D.tsx):
// - Focus: the depth under a point (averaged over a small spot), the focus
//   pull over time, whether a picture is too flat for any of this.
// - Wiggle: the viewpoints, their order and timing, and each one's camera pose.
// - Border fill: how big the painted border is and how much room it gives.

import type { DepthMap } from './api';
import { SHIFT, type Pose } from './depth';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The spread of a depth map's values (5th to 95th percentile, 0–1): tiny = a flat picture (a document, a screenshot). */
export function depthSpread(map: DepthMap): number {
  const { w, h, data } = map;
  const n = w * h;
  if (!w || !h || data.length < n || n < 4) return 0;
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(n / 20000));
  let count = 0;
  for (let i = 0; i < n; i += step) {
    hist[data[i]]++;
    count++;
  }
  const lo = count * 0.05;
  const hi = count * 0.95;
  let acc = 0;
  let a = 0;
  let b = 255;
  let seenA = false;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (!seenA && acc >= lo) {
      a = v;
      seenA = true;
    }
    if (acc >= hi) {
      b = v;
      break;
    }
  }
  return Math.max(0, b - a) / 255;
}

/** Below this spread the picture counts as flat: no focus blur on it. */
export const FLAT_SPREAD = 0.06;

/** The depth (0–1) at a point of the picture (0–1 each way), averaged over a small spot (no flicker on hair and edges). */
export function depthAtPoint(map: DepthMap, x: number, y: number, spot = 0.02): number {
  const { w, h, data } = map;
  if (!w || !h || data.length < w * h) return 0.5;
  const cx = clamp(x, 0, 1) * (w - 1);
  const cy = clamp(y, 0, 1) * (h - 1);
  const r = Math.max(1, Math.round(spot * Math.min(w, h)));
  let sum = 0;
  let n = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const px = clamp(Math.round(cx + dx), 0, w - 1);
      const py = clamp(Math.round(cy + dy), 0, h - 1);
      sum += data[py * w + px];
      n++;
    }
  return n ? sum / n / 255 : 0.5;
}

/** The farthest depth of a picture worth pulling focus from (its 10th percentile, 0–1). */
export function farDepth(map: DepthMap): number {
  const { w, h, data } = map;
  const n = w * h;
  if (!w || !h || data.length < n) return 0;
  const hist = new Uint32Array(256);
  const step = Math.max(1, Math.floor(n / 20000));
  let count = 0;
  for (let i = 0; i < n; i += step) {
    hist[data[i]]++;
    count++;
  }
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= count * 0.1) return v / 255;
  }
  return 0;
}

// ---- focus --------------------------------------------------------------------------------------

export type FocusPull = 'off' | 'start' | 'swing';

const smooth = (u: number) => {
  const t = clamp(u, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Where the focus is (depth 0–1) `ms` after the picture came: on the target,
 * or pulled from the far depth to the target once at the start, or back and
 * forth (a pull, a rest of the same length, back, a rest).
 */
export function focusPullAt(pull: FocusPull, ms: number, sec: number, target: number, far: number): number {
  const d = clamp(finite(sec, 1.5), 0.5, 3) * 1000;
  const t = Math.max(0, finite(ms, 0));
  if (pull === 'start') {
    // A short look at the far part first, then the pull.
    const u = smooth((t - d * 0.4) / d);
    return far + (target - far) * u;
  }
  if (pull === 'swing') {
    const cyc = (t % (d * 4)) / d;
    const u = cyc < 1 ? smooth(cyc) : cyc < 2 ? 1 : cyc < 3 ? 1 - smooth(cyc - 2) : 0;
    return far + (target - far) * u;
  }
  return target;
}

/** The pull is still moving at `ms` (so the picture keeps being drawn). */
export function focusPullMoving(pull: FocusPull, ms: number, sec: number): boolean {
  if (pull === 'off') return false;
  if (pull === 'swing') return true;
  const d = clamp(finite(sec, 1.5), 0.5, 3) * 1000;
  return ms < d * 1.4 + 50;
}

/** How wide the sharp zone is (depth either side of the focus) for the "Sharp depth range" setting (0–1). */
export function sharpRange(v: unknown): number {
  return 0.01 + clamp(finite(v, 0.3), 0, 1) * 0.2;
}

/** The biggest blur (share of the picture's height) for the "Blur strength" setting (0–1): 2.5 % at 100 %. */
export function blurReach(v: unknown): number {
  return clamp(finite(v, 0.4), 0, 1) * 0.025;
}

// ---- wiggle -------------------------------------------------------------------------------------

export type WiggleOrder = 'bounce' | 'round';
export type WiggleDir = 'side' | 'updown' | 'diagonal';

export interface WiggleOptions {
  views: number;
  /** Jumps per second (3–8; more is capped: it would flash). */
  speed: number;
  order: WiggleOrder;
  dir: WiggleDir;
  /** A short glide into each view instead of a hard jump. */
  smooth: boolean;
}

export const WIGGLE_MAX_SPEED = 8;

export function wiggleOptions(p: { depthWiggleViews?: number; depthWiggleSpeed?: number; depthWiggleOrder?: string; depthWiggleDir?: string; depthWiggleSmooth?: boolean }): WiggleOptions {
  return {
    views: Math.round(clamp(finite(p.depthWiggleViews, 3), 2, 4)),
    speed: clamp(finite(p.depthWiggleSpeed, 5), 3, WIGGLE_MAX_SPEED),
    order: p.depthWiggleOrder === 'round' ? 'round' : 'bounce',
    dir: p.depthWiggleDir === 'updown' || p.depthWiggleDir === 'diagonal' ? p.depthWiggleDir : 'side',
    smooth: !!p.depthWiggleSmooth,
  };
}

/** The order the views are shown in, one loop: back and forth (0 1 2 1) or round (0 1 2). */
export function wiggleSequence(views: number, order: WiggleOrder): number[] {
  const n = Math.round(clamp(views, 2, 4));
  const up = Array.from({ length: n }, (_, i) => i);
  if (order === 'round' || n === 2) return up;
  return [...up, ...up.slice(1, -1).reverse()];
}

/** How far the views spread (each way from the middle, times SHIFT × amount): about a real wigglegram's step. */
const WIGGLE_REACH = 1.1;

/** The camera at view `i` of `views` (amount 1 = as designed). */
export function wiggleViewPose(i: number, o: WiggleOptions, amount: number): Pose {
  const n = Math.max(2, o.views);
  const u = (clamp(i, 0, n - 1) / (n - 1)) * 2 - 1;
  const r = SHIFT * WIGGLE_REACH * Math.max(0, amount) * u;
  const [dx, dy] = o.dir === 'updown' ? [0, 0.8] : o.dir === 'diagonal' ? [0.71, 0.71] : [1, 0];
  return { x: r * dx, y: r * dy, dolly: 0 };
}

/** The camera `ms` into the wiggle (its own clock, which stops while paused). */
export function wigglePose(ms: number, o: WiggleOptions, amount: number): Pose {
  const seq = wiggleSequence(o.views, o.order);
  const stepMs = 1000 / clamp(o.speed, 1, WIGGLE_MAX_SPEED);
  const t = Math.max(0, finite(ms, 0));
  const k = Math.floor(t / stepMs);
  const now = wiggleViewPose(seq[k % seq.length], o, amount);
  if (!o.smooth) return now;
  // A glide over the first third of each step.
  const u = smooth((t - k * stepMs) / (stepMs * 0.33));
  if (u >= 1) return now;
  const was = wiggleViewPose(seq[(k - 1 + seq.length) % seq.length], o, amount);
  return { x: was.x + (now.x - was.x) * u, y: was.y + (now.y - was.y) * u, dolly: 0 };
}

// ---- border fill --------------------------------------------------------------------------------

/** The border's size in pixels on a picture `w` × `h` (share of the short side, 4–15 %). */
export function borderPx(w: number, h: number, size: unknown): number {
  const s = clamp(finite(size, 0.08), 0.04, 0.15);
  return Math.max(1, Math.round(Math.min(w, h) * s));
}

/** The room the border gives, as a share of the picture each way (x, y). */
export function borderRoom(w: number, h: number, size: unknown): { x: number; y: number } {
  const b = borderPx(w, h, size);
  return { x: b / Math.max(1, w), y: b / Math.max(1, h) };
}
