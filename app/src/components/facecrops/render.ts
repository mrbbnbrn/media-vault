// Cutting faces out and lining them up, in the window only: pictures come
// from the vault's own addresses (decrypted in memory by the app), are drawn
// onto small canvases and forgotten again. Nothing is written anywhere.
//
// Also the face measurements (sharpness, looking at the camera, the five
// points), asked from the backend a few at a time and kept for the session.

import { api, mediaUrl, onEvent, thumbUrl, type FaceMeasure, type PersonFace } from '../../api';
import {
  alignEyes, framePoints, grow, lerpPts, MESH, meshPoints, pointsFromBox, triAffine, type FivePoints, type Pt,
} from '../../facecrops';

/** Side of the lined-up face frames (px). */
export const FRAME = 512;
/** The thumbnail's longest side (picture.rs THUMB_MAX). */
const THUMB_MAX = 640;
/** A face this tall (px) in the thumbnail is enough for a frame; smaller ones use the original. */
const THUMB_ENOUGH = 300;

// ---- measurements ----------------------------------------------------------------------------

/** Faces measured this session (face id → numbers). */
const measured = new Map<number, FaceMeasure>();
let jobN = 0;

export function measureOf(id: number): FaceMeasure | undefined {
  return measured.get(id);
}

/** Forget everything (the vault locked). */
export function forgetMeasures() {
  measured.clear();
}

/**
 * Measure these faces, a few at a time (so it can stop between them), with
 * progress (done, total). Faces measured before come back at once.
 */
export async function measureFaces(ids: number[], opts: { stopped?: () => boolean; progress?: (done: number, total: number) => void; chunk?: number } = {}): Promise<Map<number, FaceMeasure>> {
  const out = new Map<number, FaceMeasure>();
  const todo: number[] = [];
  for (const id of ids) {
    const m = measured.get(id);
    if (m) out.set(id, m);
    else todo.push(id);
  }
  const total = ids.length;
  let done = out.size;
  opts.progress?.(done, total);
  const chunk = opts.chunk ?? 16;
  const job = `faces-${++jobN}`;
  // Finer progress inside a chunk, from the backend.
  let base = done;
  const un = await onEvent<{ job: string; done: number; total: number }>('face-measure-progress', (p) => {
    if (p.job === job) opts.progress?.(Math.min(total, base + p.done), total);
  });
  // Stopping in the middle of a chunk: the backend stops after the picture it is on.
  const watch = setInterval(() => {
    if (opts.stopped?.()) api.faceCropsStop(job).catch(() => {});
  }, 200);
  try {
    for (let i = 0; i < todo.length; i += chunk) {
      if (opts.stopped?.()) break;
      const part = todo.slice(i, i + chunk);
      base = done;
      const got = await api.faceCropsMeasure(job, part);
      for (const m of got) {
        measured.set(m.id, m);
        out.set(m.id, m);
      }
      done += part.length;
      opts.progress?.(Math.min(done, total), total);
    }
  } finally {
    clearInterval(watch);
    un();
  }
  return out;
}

/** The five points of a face: measured, else guessed from its box. */
export function pointsOf(f: PersonFace): FivePoints {
  const p = measured.get(f.id)?.points;
  return p && p.length === 5 ? (p as FivePoints) : pointsFromBox(f);
}

// ---- pictures -------------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Without it the canvas can't be read back, and "Save as video" needs that.
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be shown.'));
    img.src = src;
  });
}

/** The thumbnail when the face is big enough in it, else the original (the thumbnail if that can't be shown). */
async function pictureFor(f: PersonFace): Promise<HTMLImageElement> {
  const longest = Math.max(f.width, f.height);
  const inThumb = longest > 0 ? f.h * f.height * Math.min(1, THUMB_MAX / longest) : 0;
  if (inThumb >= THUMB_ENOUGH) return loadImage(thumbUrl(f.mediaId));
  try {
    return await loadImage(mediaUrl(f.mediaId));
  } catch {
    return loadImage(thumbUrl(f.mediaId));
  }
}

/** One face lined up by the eyes in a FRAME × FRAME square, and its five points there. */
export interface Aligned {
  id: number;
  canvas: HTMLCanvasElement;
  pts: FivePoints;
}

/** Draw `f` lined up by the eyes (dark around the picture's edges). */
export async function alignedFace(f: PersonFace): Promise<Aligned> {
  const img = await pictureFor(f);
  const pw = img.naturalWidth;
  const ph = img.naturalHeight;
  const points = pointsOf(f);
  const m = alignEyes(points, pw, ph, FRAME);
  const canvas = document.createElement('canvas');
  canvas.width = FRAME;
  canvas.height = FRAME;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, FRAME, FRAME);
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(m.a, m.b, -m.b, m.a, m.tx, m.ty);
  ctx.drawImage(img, 0, 0, pw, ph);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Let the browser drop the decoded picture as soon as it likes.
  img.src = '';
  return { id: f.id, canvas, pts: framePoints(points, pw, ph, m) };
}

/** A small cache of lined-up faces (each is about 1 MB of memory). */
export class AlignedCache {
  private map = new Map<number, Aligned>();
  private waiting = new Map<number, Promise<Aligned | null>>();
  constructor(private max = 40) {}

  get(id: number): Aligned | undefined {
    const a = this.map.get(id);
    if (a) {
      // Most recently used last.
      this.map.delete(id);
      this.map.set(id, a);
    }
    return a;
  }

  has(id: number): boolean {
    return this.map.has(id);
  }

  /** Make (or wait for) a face's frame; null when its picture couldn't be shown. */
  load(f: PersonFace): Promise<Aligned | null> {
    const have = this.get(f.id);
    if (have) return Promise.resolve(have);
    let p = this.waiting.get(f.id);
    if (!p) {
      p = alignedFace(f).then(
        (a) => {
          this.map.set(f.id, a);
          while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value as number;
            const gone = this.map.get(oldest);
            if (gone) gone.canvas.width = 0; // frees its pixels now
            this.map.delete(oldest);
          }
          return a;
        },
        () => null,
      ).finally(() => this.waiting.delete(f.id));
      this.waiting.set(f.id, p);
    }
    return p;
  }

  clear() {
    for (const a of this.map.values()) a.canvas.width = 0;
    this.map.clear();
  }
}

// ---- drawing ---------------------------------------------------------------------------------

/** Draw `src` warped from its mesh points `from` onto `to`, one triangle at a time. */
function warp(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, from: Pt[], to: Pt[]) {
  for (const [i, j, k] of MESH) {
    const s: [Pt, Pt, Pt] = [from[i], from[j], from[k]];
    const d: [Pt, Pt, Pt] = [to[i], to[j], to[k]];
    const m = triAffine(s, d);
    if (!m) continue;
    const clip = grow(d, 0.75);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(clip[0][0], clip[0][1]);
    ctx.lineTo(clip[1][0], clip[1][1]);
    ctx.lineTo(clip[2][0], clip[2][1]);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }
}

/**
 * One time-lapse picture: face `a`, or (morph) `a` turning into `b` by `mix`
 * (0…1): both are warped to the in-between shape and blended. The canvas is FRAME × FRAME.
 */
export function drawLapse(ctx: CanvasRenderingContext2D, a: Aligned, b: Aligned | null, mix: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (!b || mix <= 0) {
    ctx.drawImage(a.canvas, 0, 0);
    return;
  }
  if (mix >= 1) {
    ctx.drawImage(b.canvas, 0, 0);
    return;
  }
  const pa = meshPoints(a.pts, FRAME);
  const pb = meshPoints(b.pts, FRAME);
  const mid = lerpPts(pa, pb, mix);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, FRAME, FRAME);
  warp(ctx, a.canvas, pa, mid);
  // The next face is warped on its own canvas first and then blended in one
  // go: blending triangle by triangle would show their overlapping edges as lines.
  const s = scratchCanvas();
  const sx = s.getContext('2d')!;
  sx.setTransform(1, 0, 0, 1, 0, 0);
  sx.clearRect(0, 0, FRAME, FRAME);
  warp(sx, b.canvas, pb, mid);
  ctx.globalAlpha = mix;
  ctx.drawImage(s, 0, 0);
  ctx.globalAlpha = 1;
}

let scratch: HTMLCanvasElement | null = null;
function scratchCanvas(): HTMLCanvasElement {
  if (!scratch) {
    scratch = document.createElement('canvas');
    scratch.width = FRAME;
    scratch.height = FRAME;
  }
  return scratch;
}
