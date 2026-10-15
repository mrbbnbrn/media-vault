// Maths for a person's cut-out faces (the face wall, Best faces and the
// face time-lapse), kept apart from the screens so it can be tested:
//  - the "Smallest face" filter and its live count
//  - month/year groups for the wall, and where a face sits in a round tile
//  - lining faces up by the eyes (a similarity transform: move, turn, scale)
//  - the morph between two faces (a triangle mesh over the five face points
//    and the frame's corners and edges)
//  - time-lapse timing: which face shows (and how far into the morph) at a moment
//
// Face boxes and points are parts (0–1) of the picture unless said otherwise.

import type { PersonFace } from './api';

export type Pt = [number, number];
/** Eyes (left, right), nose tip, mouth corners (left, right). */
export type FivePoints = [Pt, Pt, Pt, Pt, Pt];

// ---- smallest face ---------------------------------------------------------------------------

/** Faces at least `minPx` tall in the original picture (pictures of unknown size are kept). */
export function bigEnough<F extends Pick<PersonFace, 'height' | 'facePx'>>(faces: F[], minPx: number): F[] {
  if (!(minPx > 0)) return faces;
  return faces.filter((f) => !(f.height > 0) || f.facePx >= minPx);
}

/** "312 of 1,040 faces". */
export function countLabel(shown: number, all: number): string {
  const n = (x: number) => x.toLocaleString('en-GB');
  return shown === all ? `${n(all)} face${all === 1 ? '' : 's'}` : `${n(shown)} of ${n(all)} faces`;
}

/** The slider's top: the biggest face (rounded up to a ten), at least 100. */
export function sliderMax(faces: Pick<PersonFace, 'facePx'>[]): number {
  let m = 100;
  for (const f of faces) if (f.facePx > m) m = f.facePx;
  return Math.ceil(m / 10) * 10;
}

// ---- the wall ---------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "March 2024" for a date in seconds (local time). */
export function monthLabel(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Faces (already oldest first) in runs of the same month. */
export function byMonth<F extends { date: number }>(faces: F[]): { label: string; faces: F[] }[] {
  const out: { label: string; faces: F[] }[] = [];
  for (const f of faces) {
    const label = monthLabel(f.date);
    const last = out[out.length - 1];
    if (last && last.label === label) last.faces.push(f);
    else out.push({ label, faces: [f] });
  }
  return out;
}

/**
 * Where to draw a picture of `pw` × `ph` (any units, its aspect is what
 * counts) so the face fills a square tile of `tile` px: the face's bigger side
 * takes `share` of the tile, centred, as far as the picture allows.
 * Returns the picture's drawn width/height and offset in px.
 */
export function tileCrop(face: Pick<PersonFace, 'x' | 'y' | 'w' | 'h'>, pw: number, ph: number, tile: number, share = 0.62): { w: number; h: number; left: number; top: number } {
  const W = pw > 0 ? pw : 1;
  const H = ph > 0 ? ph : 1;
  const side = Math.max(face.w * W, face.h * H, 1e-6);
  // Never smaller than the tile (no empty edges).
  const s = Math.max((tile * share) / side, tile / W, tile / H);
  const w = W * s;
  const h = H * s;
  const cx = (face.x + face.w / 2) * w;
  const cy = (face.y + face.h / 2) * h;
  return { w, h, left: clamp(tile / 2 - cx, tile - w, 0), top: clamp(tile / 2 - cy, tile - h, 0) };
}

// ---- lining up by the eyes ---------------------------------------------------------------------

/** x' = a·x − b·y + tx, y' = b·x + a·y + ty (a turn, an even scale and a move). */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

export function applySim(m: Similarity, [x, y]: Pt): Pt {
  return [m.a * x - m.b * y + m.tx, m.b * x + m.a * y + m.ty];
}

/** The similarity that takes p1 → q1 and p2 → q2 exactly (null when p1 = p2). */
export function similarityFrom(p1: Pt, p2: Pt, q1: Pt, q2: Pt): Similarity | null {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const d2 = dx * dx + dy * dy;
  if (d2 < 1e-12) return null;
  const ex = q2[0] - q1[0];
  const ey = q2[1] - q1[1];
  // (a + ib) = (q2 − q1) / (p2 − p1) as complex numbers.
  const a = (ex * dx + ey * dy) / d2;
  const b = (ey * dx - ex * dy) / d2;
  return { a, b, tx: q1[0] - (a * p1[0] - b * p1[1]), ty: q1[1] - (b * p1[0] + a * p1[1]) };
}

/** Where the eyes land in a square frame of `size` px. */
export function eyeTargets(size: number): [Pt, Pt] {
  return [[size * 0.37, size * 0.4], [size * 0.63, size * 0.4]];
}

/**
 * The five points guessed from a face box (when the face points are not
 * known: without the faces pack, or the picture couldn't be looked at).
 * Where they usually sit in the face finder's boxes.
 */
export function pointsFromBox(f: Pick<PersonFace, 'x' | 'y' | 'w' | 'h'>): FivePoints {
  const at = (u: number, v: number): Pt => [f.x + u * f.w, f.y + v * f.h];
  return [at(0.31, 0.4), at(0.69, 0.4), at(0.5, 0.58), at(0.35, 0.78), at(0.65, 0.78)];
}

/**
 * The transform from the picture's pixels (`pw` × `ph`) into a `size` px
 * square frame that puts the eyes at `eyeTargets`. Points are parts of the picture.
 */
export function alignEyes(points: FivePoints, pw: number, ph: number, size: number): Similarity {
  const [l, r] = points;
  const [tl, tr] = eyeTargets(size);
  const px = (p: Pt): Pt => [p[0] * pw, p[1] * ph];
  return similarityFrom(px(l), px(r), tl, tr) ?? { a: 1, b: 0, tx: 0, ty: 0 };
}

/** The five points inside the frame (px), after `alignEyes`. */
export function framePoints(points: FivePoints, pw: number, ph: number, m: Similarity): FivePoints {
  return points.map((p) => applySim(m, [p[0] * pw, p[1] * ph])) as FivePoints;
}

// ---- the morph mesh ---------------------------------------------------------------------------

/**
 * Mesh points: the frame's four corners (0–3: top left, top right, bottom
 * right, bottom left), the middles of its edges (4–7: top, right, bottom,
 * left), then the five face points (8–12). The frame points never move, so
 * the edges of the picture stay put while the face changes shape.
 */
export function meshPoints(face: FivePoints, size: number): Pt[] {
  const s = size;
  return [[0, 0], [s, 0], [s, s], [0, s], [s / 2, 0], [s, s / 2], [s / 2, s], [0, s / 2], ...face];
}

/** The triangles (indices into `meshPoints`); together they cover the whole frame. */
export const MESH: readonly [number, number, number][] = [
  // around the face, from the frame's edges in to the eyes and mouth
  [0, 4, 8], [4, 9, 8], [4, 1, 9],
  [1, 5, 9], [5, 12, 9], [5, 2, 12],
  [6, 12, 2], [6, 11, 12], [3, 11, 6],
  [7, 11, 3], [7, 8, 11], [0, 8, 7],
  // the face itself, around the nose
  [8, 9, 10], [8, 10, 11], [9, 12, 10], [10, 12, 11],
];

export function lerpPts(a: Pt[], b: Pt[], t: number): Pt[] {
  return a.map((p, i) => [p[0] + (b[i][0] - p[0]) * t, p[1] + (b[i][1] - p[1]) * t]);
}

/** Signed area of a triangle (positive = clockwise on screen, y down). */
export function triArea(p: Pt, q: Pt, r: Pt): number {
  return ((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
}

/**
 * The canvas transform (a, b, c, d, e, f as in `setTransform`) that maps the
 * triangle `src` onto `dst` (null when `src` has no area).
 */
export function triAffine(src: [Pt, Pt, Pt], dst: [Pt, Pt, Pt]): [number, number, number, number, number, number] | null {
  const [[x0, y0], [x1, y1], [x2, y2]] = src;
  const [[u0, v0], [u1, v1], [u2, v2]] = dst;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-9) return null;
  const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
  const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
  const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
  const d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
  return [a, b, c, d, u0 - a * x0 - c * y0, v0 - b * x0 - d * y0];
}

/** A triangle pushed out from its middle by `px` (hides hairline seams between triangles). */
export function grow(tri: [Pt, Pt, Pt], px: number): [Pt, Pt, Pt] {
  const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
  const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
  return tri.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    return [x + (dx / d) * px, y + (dy / d) * px];
  }) as [Pt, Pt, Pt];
}

// ---- time-lapse timing -------------------------------------------------------------------------

export interface LapseTiming {
  /** Faces per second. */
  fps: number;
  /** Morph into the next face (else a plain cut). */
  morph: boolean;
  /** The part (0.1–0.9) of each face's time spent morphing into the next one. */
  morphShare: number;
}

/** How long each face is on screen (ms), morph included. */
export function slotMs(fps: number): number {
  return 1000 / clamp(fps, 0.25, 60);
}

/** How long the morph into the next face takes (ms; 0 for a cut). */
export function morphMs(t: LapseTiming): number {
  return t.morph ? slotMs(t.fps) * clamp(t.morphShare, 0.1, 0.9) : 0;
}

/**
 * At `ms` from the start of a time-lapse of `n` faces: which face, and how
 * far (0…1) it has morphed into the next one. The last face just holds.
 */
export function lapseAt(ms: number, n: number, t: LapseTiming): { index: number; mix: number } {
  if (n <= 0) return { index: 0, mix: 0 };
  const slot = slotMs(t.fps);
  const pos = Math.max(0, ms) / slot;
  const index = Math.min(n - 1, Math.floor(pos));
  if (index >= n - 1 || !t.morph) return { index, mix: 0 };
  const into = (pos - index) * slot;
  const hold = slot - morphMs(t);
  return { index, mix: into <= hold ? 0 : clamp((into - hold) / (slot - hold), 0, 1) };
}

/** The whole time-lapse's length (ms). */
export function lapseLength(n: number, fps: number): number {
  return Math.max(0, n) * slotMs(fps);
}

/** Video frames per second when saving: one per face for cuts (at least 1), smooth (30) for morphs. */
export function videoFps(t: LapseTiming): number {
  return t.morph ? Math.max(30, Math.min(60, Math.round(t.fps))) : clamp(t.fps, 1, 60);
}

/** Every video frame's time (ms) for a saved time-lapse. */
export function videoFrameTimes(n: number, t: LapseTiming): number[] {
  const total = lapseLength(n, t.fps);
  const step = 1000 / videoFps(t);
  const out: number[] = [];
  for (let ms = 0; ms < total - 1e-6; ms += step) out.push(ms);
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
