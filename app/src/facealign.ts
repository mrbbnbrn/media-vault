// Face maths, kept apart so it can be tested:
//  - round person covers: where to put a picture inside a circle so the face
//    sits in the middle at a pleasant size
//  - "Line up faces" slideshows: how to move, scale (and slightly turn) each
//    picture so its main face lands at the same place and size on screen
//
// Face boxes are fractions (0–1) of the picture's width and height.

export interface FaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Both eye centres in picture fractions (only when landmarks are stored). */
export interface Eyes {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
}

// ---- round covers ---------------------------------------------------------------------------

/** How big the face is inside the circle (its larger side, as a part of the diameter). */
export const COVER_FACE_SHARE = 0.5;

/**
 * Where a picture of aspect `aspect` (width / height) goes inside a circle
 * (a square box of size 1): width, height, left and top as fractions of the
 * box. With a face, the face is centred and fills about half the circle (as
 * far as the picture allows, it always covers the whole circle); without
 * one, the picture is centred like `object-fit: cover`.
 */
export function coverFit(aspect: number, face?: FaceRect | null): { w: number; h: number; left: number; top: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  // Smallest height that still covers the square.
  const minH = Math.max(1, 1 / a);
  let h = minH;
  let cx = 0.5;
  let cy = 0.5;
  if (face && face.w > 0 && face.h > 0) {
    const side = Math.max(face.w * a, face.h); // in picture heights
    h = Math.max(minH, Math.min(minH * 8, COVER_FACE_SHARE / side));
    cx = face.x + face.w / 2;
    cy = face.y + face.h / 2;
  }
  const w = h * a;
  const left = clamp(0.5 - cx * w, 1 - w, 0);
  const top = clamp(0.5 - cy * h, 1 - h, 0);
  return { w, h, left, top };
}

// ---- line up faces ---------------------------------------------------------------------------------

export interface Aligned {
  /** CSS: translate(tx px, ty px) rotate(rot rad) scale(s), with transform-origin 0 0. */
  tx: number;
  ty: number;
  s: number;
  rot: number;
}

export const NO_ALIGN: Aligned = { tx: 0, ty: 0, s: 1, rot: 0 };

/** Where the main face goes on a W×H screen: a little above the middle, about 30% of the height. */
export function faceTarget(W: number, H: number): { x: number; y: number; size: number } {
  return { x: W / 2, y: H * 0.42, size: Math.min(H * 0.3, W * 0.4) };
}

/** The face's size on screen used for matching: the geometric mean of its sides. */
function faceSize(f: FaceRect, drawn: Rect): number {
  return Math.sqrt(Math.max(1e-9, f.w * drawn.width) * Math.max(1e-9, f.h * drawn.height));
}

/** At most this much turn from the eye line (radians, about 20°). */
export const MAX_TURN = 0.35;

/**
 * The transform that puts `face` (in a picture drawn at `drawn` on a W×H
 * stage) onto `target`. Scaling is limited to [minScale, maxScale] (so tiny
 * faces in crowds don't blow the picture up into a blur); with eyes, the
 * picture is turned so the eye line is level (at most MAX_TURN).
 */
export function alignFace(
  drawn: Rect,
  face: FaceRect,
  target: { x: number; y: number; size: number },
  opts: { eyes?: Eyes | null; minScale?: number; maxScale?: number } = {},
): Aligned {
  if (!(drawn.width > 0 && drawn.height > 0 && face.w > 0 && face.h > 0)) return NO_ALIGN;
  const minS = opts.minScale ?? 0.4;
  const maxS = Math.max(minS, opts.maxScale ?? 4);
  const s = clamp(target.size / faceSize(face, drawn), minS, maxS);
  let rot = 0;
  const e = opts.eyes;
  if (e) {
    const dx = (e.rx - e.lx) * drawn.width;
    const dy = (e.ry - e.ly) * drawn.height;
    if (Math.abs(dx) > 1e-6) rot = clamp(-Math.atan2(dy, dx), -MAX_TURN, MAX_TURN);
  }
  // Face centre on the stage before the transform.
  const cx = drawn.left + (face.x + face.w / 2) * drawn.width;
  const cy = drawn.top + (face.y + face.h / 2) * drawn.height;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return {
    s,
    rot,
    tx: target.x - s * (cos * cx - sin * cy),
    ty: target.y - s * (sin * cx + cos * cy),
  };
}

/** Where a stage point ends up under `a` (for tests and the face layer). */
export function applyAligned(a: Aligned, x: number, y: number): { x: number; y: number } {
  const cos = Math.cos(a.rot);
  const sin = Math.sin(a.rot);
  return { x: a.tx + a.s * (cos * x - sin * y), y: a.ty + a.s * (sin * x + cos * y) };
}

/** `a` followed by a zoom of `g` around the point (px, py): the gentle zoom while a picture shows. */
export function zoomAbout(a: Aligned, px: number, py: number, g: number): Aligned {
  return { s: a.s * g, rot: a.rot, tx: px + g * (a.tx - px), ty: py + g * (a.ty - py) };
}

export function alignedCss(a: Aligned): string {
  return `translate(${a.tx.toFixed(2)}px, ${a.ty.toFixed(2)}px) rotate(${a.rot.toFixed(4)}rad) scale(${a.s.toFixed(4)})`;
}

/** The face to line up: the person's (when the slideshow is about a person), else the biggest. */
export function mainFace<F extends FaceRect & { person?: number | null }>(faces: F[], person?: number | null): F | null {
  if (!faces.length) return null;
  const pool = person != null ? faces.filter((f) => f.person === person) : [];
  const list = pool.length ? pool : faces;
  return list.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
}

/**
 * How far a picture may be enlarged: up to `upscale` times its own pixels
 * (e.g. 2.5× of a 1000 px wide photo drawn at 500 px = 5×), and never less than 1.
 */
export function maxScaleFor(naturalWidth: number, drawnWidth: number, upscale = 2.5): number {
  if (!(naturalWidth > 0 && drawnWidth > 0)) return 1;
  return Math.max(1, (naturalWidth / drawnWidth) * upscale);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
