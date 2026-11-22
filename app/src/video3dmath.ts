// Prepared 3D for videos and GIFs (video3d.ts): the pure maths, run in the
// preparing worker (video3dworker.ts) and tested directly.
//
// - Motion: how still each part of the picture is since the last frame, a
//   new scene, how much moved. Everything calm-making only happens where
//   nothing moved, so moving subjects never leave a ghost behind.
// - Calming: the depth aligned to the last frame's (a steady range: the scene
//   doesn't "breathe" as things come and go) and blended with it where still
//   (no shimmer); the outline blended the same way.
// - Background memory (Layered 3D): background seen in earlier frames, where
//   the camera stood still, fills in behind the subject before any guessing.
// - Tiles: one frame's 3D data packed into one picture for the video codec.

import type { DepthMap, SubjectMask } from './api';
import type { SubjectStats } from './subject';
import { resample } from './layers';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** The motion grid's side (the frame stretched to a square, like the models see it). */
export const GATE = 96;

/** A frame's brightness on a small square grid (cell averages). */
export function lumaGrid(rgba: ArrayLike<number>, w: number, h: number, g = GATE): Float32Array {
  const sum = new Float32Array(g * g);
  const cnt = new Float32Array(g * g);
  const sx = Math.max(1, Math.floor(w / (g * 2)));
  const sy = Math.max(1, Math.floor(h / (g * 2)));
  for (let y = 0; y < h; y += sy) {
    const gy = Math.min(g - 1, Math.floor((y * g) / h));
    for (let x = 0; x < w; x += sx) {
      const gx = Math.min(g - 1, Math.floor((x * g) / w));
      const i = (y * w + x) * 4;
      sum[gy * g + gx] += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      cnt[gy * g + gx]++;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 0;
  return sum;
}

export interface Motion {
  /** Per grid cell, 1 = nothing moved there (or next to it), 0 = moved. */
  gate: Float32Array;
  /** A new scene (or the first frame): nothing is carried over. */
  cut: boolean;
  /** Share of the picture that changed (0–1). */
  moving: number;
}

/** What changed between the last frame's grid and this one's. */
export function motionBetween(cur: Float32Array, prev: Float32Array | null, g = GATE): Motion {
  const n = cur.length;
  if (!prev || prev.length !== n) return { gate: new Float32Array(n), cut: true, moving: 1 };
  const d = new Float32Array(n);
  let sum = 0;
  let big = 0;
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(cur[i] - prev[i]);
    d[i] = v;
    sum += v;
    if (v > 20) big++;
    if (v > 8) moved++;
  }
  // Next to something that moved counts as moved (edges move before their middles change).
  const gate = new Float32Array(n);
  for (let y = 0; y < g; y++)
    for (let x = 0; x < g; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= g || xx >= g) continue;
          const v = d[yy * g + xx];
          if (v > m) m = v;
        }
      gate[y * g + x] = clamp01(1 - (m - 3) / 12);
    }
  return { gate, cut: sum / n > 38 || big / n > 0.6, moving: moved / n };
}

function gateAt(gate: Float32Array, u: number, v: number, g = GATE): number {
  return gate[Math.min(g - 1, Math.floor(v * g)) * g + Math.min(g - 1, Math.floor(u * g))];
}

/**
 * The depth calmed over time: lined up with the last frame's calmed depth
 * (scale and offset fitted where nothing moved, so the range stays steady),
 * then blended with it where nothing moved (`keep` of the old there).
 */
export function calmDepth(raw: DepthMap, prev: DepthMap | null, m: Motion, keep = 0.6): DepthMap {
  if (!prev || m.cut || prev.w !== raw.w || prev.h !== raw.h) return raw;
  const { w, h } = raw;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 96));
  let n = 0;
  let tot = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      tot++;
      if (gateAt(m.gate, (x + 0.5) / w, (y + 0.5) / h) < 0.9) continue;
      const i = y * w + x;
      const X = raw.data[i];
      const Y = prev.data[i];
      n++;
      sx += X;
      sy += Y;
      sxx += X * X;
      sxy += X * Y;
    }
  let a = 1;
  let b = 0;
  if (n >= 50 && n >= tot * 0.05) {
    const mx = sx / n;
    const my = sy / n;
    const vx = sxx / n - mx * mx;
    if (vx > 4) a = clamp((sxy / n - mx * my) / vx, 0.6, 1.6);
    b = clamp(my - a * mx, -80, 80);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = raw.data[i];
      // A little of the model's own depth each frame, so the range can't drift away.
      const al = 0.85 * (a * r + b) + 0.15 * r;
      const k = keep * gateAt(m.gate, (x + 0.5) / w, (y + 0.5) / h);
      out[i] = Math.round(clamp(al * (1 - k) + prev.data[i] * k, 0, 255));
    }
  return { w, h, data: out };
}

/** The outline calmed over time: blended with the last one where nothing moved. */
export function calmMask(raw: SubjectMask, prev: SubjectMask | null, m: Motion, keep = 0.5): SubjectMask {
  if (!prev || m.cut || prev.w !== raw.w || prev.h !== raw.h) return raw;
  const { w, h } = raw;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = keep * gateAt(m.gate, (x + 0.5) / w, (y + 0.5) / h);
      out[i] = Math.round(raw.data[i] * (1 - k) + prev.data[i] * k);
    }
  return { w, h, data: out };
}

// ---- background memory (Layered 3D) ----------------------------------------------------------

/** Frames a remembered background pixel stays usable. */
export const BG_FRESH = 150;
const NEVER = 65535;

export interface BgMemory {
  w: number;
  h: number;
  rgb: Uint8ClampedArray;
  /** Frames since each pixel was seen as background (NEVER = not known). */
  age: Uint16Array;
}

export function newBgMemory(w: number, h: number): BgMemory {
  return { w, h, rgb: new Uint8ClampedArray(w * h * 3), age: new Uint16Array(w * h).fill(NEVER) };
}

/**
 * Remembers the background wherever it shows (outside `hole`, the subject's
 * area at the plate's size) and nothing moved; a new scene or a moving camera
 * forgets everything (the remembered pixels would no longer line up).
 */
export function rememberBackground(mem: BgMemory, orig: ArrayLike<number>, hole: ArrayLike<number>, m: Motion) {
  if (m.cut || m.moving > 0.35) {
    mem.age.fill(NEVER);
    return;
  }
  const { w, h } = mem;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (hole[i] < 0.02 && gateAt(m.gate, (x + 0.5) / w, (y + 0.5) / h) > 0.9) {
        mem.rgb[i * 3] = orig[i * 4];
        mem.rgb[i * 3 + 1] = orig[i * 4 + 1];
        mem.rgb[i * 3 + 2] = orig[i * 4 + 2];
        mem.age[i] = 0;
      } else if (mem.age[i] < NEVER) mem.age[i]++;
    }
}

// ---- tiles ------------------------------------------------------------------------------------

/**
 * One frame's 3D data as one picture of 3 × 2 tiles, each the tile size:
 * top: the background plate's colour, the subject layer's colour, the outline;
 * bottom: the depth, the plate's depth, the subject layer's depth.
 * Grey tiles are stored as grey (the codec keeps brightness best).
 */
export const TILE = {
  plate: [0, 0],
  fore: [1, 0],
  mask: [2, 0],
  depth: [0, 1],
  plateDepth: [1, 1],
  foreDepth: [2, 1],
} as const;
export type TileName = keyof typeof TILE;
export const COLS = 3;
export const ROWS = 2;

/** A tile's place in the packed picture: x, y, width, height (0–1). */
export function tileRect(name: TileName): [number, number, number, number] {
  const [c, r] = TILE[name];
  return [c / COLS, r / ROWS, 1 / COLS, 1 / ROWS];
}

/** The tile size for a frame `w0` × `h0` with `long` pixels on its long side (even numbers, never bigger than the frame). */
export function tileSize(w0: number, h0: number, long: number): { w: number; h: number } {
  const k = Math.min(1, long / Math.max(1, w0, h0));
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { w: even(w0 * k), h: even(h0 * k) };
}

export interface TileParts {
  /** RGBA at the tile size: colour, alpha = depth (plate.ts / platemath.ts). */
  plate: ArrayLike<number> | null;
  fore: ArrayLike<number> | null;
  mask: SubjectMask | null;
  depth: DepthMap;
}

/** The packed picture (RGBA, 3w × 2h). Missing parts stay black. */
export function packTiles(w: number, h: number, p: TileParts): Uint8ClampedArray {
  const cw = w * COLS;
  const out = new Uint8ClampedArray(cw * h * ROWS * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const at = (name: TileName) => ({ x0: TILE[name][0] * w, y0: TILE[name][1] * h });
  const grey = (name: TileName, v: ArrayLike<number>) => {
    const { x0, y0 } = at(name);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = ((y0 + y) * cw + x0 + x) * 4;
        const g = v[y * w + x];
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
      }
  };
  const colour = (name: TileName, rgba: ArrayLike<number>, alphaTo: TileName) => {
    const { x0, y0 } = at(name);
    const a = at(alphaTo);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const o = ((y0 + y) * cw + x0 + x) * 4;
        out[o] = rgba[i];
        out[o + 1] = rgba[i + 1];
        out[o + 2] = rgba[i + 2];
        const q = ((a.y0 + y) * cw + a.x0 + x) * 4;
        out[q] = rgba[i + 3];
        out[q + 1] = rgba[i + 3];
        out[q + 2] = rgba[i + 3];
      }
  };
  const sized = (m: DepthMap) => (m.w === w && m.h === h ? m.data : resample(m.data, m.w, m.h, w, h));
  grey('depth', sized(p.depth));
  if (p.mask) grey('mask', sized(p.mask));
  if (p.plate) colour('plate', p.plate, 'plateDepth');
  if (p.fore) colour('fore', p.fore, 'foreDepth');
  return out;
}

/** A grey tile read back from a packed picture (tests, checks). */
export function readTile(packed: ArrayLike<number>, w: number, h: number, name: TileName): Uint8Array {
  const cw = w * COLS;
  const [c, r] = TILE[name];
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = packed[((r * h + y) * cw + c * w + x) * 4];
  return out;
}

// ---- each frame's numbers ---------------------------------------------------------------------

/** What the drawing needs per frame besides the pictures (kept in each piece's header). */
export interface FrameInfo {
  /** The depth that stays still (depth.ts pivotOf). */
  p: number;
  /** The subject's depth and the background's depth next to it (null: no subject). */
  z: number | null;
  b: number | null;
  /** Where the subject is (null: none in this frame). */
  st: SubjectStats | null;
  /** How much of the picture moved since the last frame (0–1): 3D is calmed on fast scenes. */
  mo: number;
}

const mixN = (a: number, b: number, k: number) => a * k + b * (1 - k);

/** The numbers smoothed over time (`keep` of the old), so the subject's frame doesn't jitter; a new scene starts fresh. */
export function smoothInfo(prev: FrameInfo | null, next: FrameInfo, cut: boolean, keep = 0.7): FrameInfo {
  if (!prev || cut) return next;
  const out: FrameInfo = { ...next, p: mixN(prev.p, next.p, keep), mo: mixN(prev.mo, next.mo, 0.5) };
  if (prev.z != null && next.z != null) out.z = mixN(prev.z, next.z, keep);
  if (prev.b != null && next.b != null) out.b = mixN(prev.b, next.b, keep);
  const a = prev.st;
  const s = next.st;
  if (a && s) {
    out.st = {
      box: { x0: mixN(a.box.x0, s.box.x0, keep), y0: mixN(a.box.y0, s.box.y0, keep), x1: mixN(a.box.x1, s.box.x1, keep), y1: mixN(a.box.y1, s.box.y1, keep) },
      bottom: { x: mixN(a.bottom.x, s.bottom.x, keep), y: mixN(a.bottom.y, s.bottom.y, keep) },
      centroid: { x: mixN(a.centroid.x, s.centroid.x, keep), y: mixN(a.centroid.y, s.centroid.y, keep) },
      coverage: mixN(a.coverage, s.coverage, keep),
    };
  }
  return out;
}

/** Numbers rounded for saving (4 decimals is far below a pixel). */
export function roundInfo(i: FrameInfo): FrameInfo {
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const st = i.st && {
    box: { x0: r(i.st.box.x0), y0: r(i.st.box.y0), x1: r(i.st.box.x1), y1: r(i.st.box.y1) },
    bottom: { x: r(i.st.bottom.x), y: r(i.st.bottom.y) },
    centroid: { x: r(i.st.centroid.x), y: r(i.st.centroid.y) },
    coverage: r(i.st.coverage),
  };
  return { p: r(i.p), z: i.z == null ? null : r(i.z), b: i.b == null ? null : r(i.b), st, mo: r(i.mo) };
}

/** How strong the 3D is on a frame: calmed where a lot moves (`calm` on), never below 40 %. */
export function motionDamp(mo: number, calm: boolean): number {
  return calm ? 1 - 0.6 * clamp01((mo - 0.08) / 0.4) : 1;
}
