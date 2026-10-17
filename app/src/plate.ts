// The pieces made once per picture for the picture layers of 3D photos
// (still pictures only), all in memory (dropped on lock), never on disk:
//
// - the depth map with sharper edges (layers.ts refineEdges), kept for a few pictures;
// - Layered 3D's background plate: the picture with the subject filled in
//   (Simple: pulled in from the surroundings on a small copy, then enlarged;
//   MI-GAN / LaMa: natively, on a square copy of their size), with the depth
//   map filled the same way in its alpha channel, ready for one texture;
// - the subject cut out at full size as a PNG with a transparent background
//   ("Save subject as PNG").

import { api, onLocked, type DepthMap, type SubjectMask } from './api';
import { inpaintPack } from './inpaint';
import { fillDepth, fillRgba, holeMask, refineEdges, resample, subjectColours, subjectOwnDepth } from './layers';

const REFINED_KEEP = 8;
const PLATES_KEEP = 4;
/** The plate's longest side at most (its fill is soft anyway; the picture outside the subject is the picture itself). */
const PLATE_MAX = 1600;
/** Simple fills on a copy this big (longest side), then enlarges. */
const SIMPLE_SIDE = 256;

const refined = new Map<string, DepthMap>();
const plates = new Map<string, Promise<Plate | null>>();
const fores = new Map<string, Promise<Plate | null>>();
void onLocked(() => {
  refined.clear();
  plates.clear();
  fores.clear();
}).catch(() => {});

function keep<T>(m: Map<string, T>, key: string, v: T, max: number) {
  m.delete(key);
  m.set(key, v);
  while (m.size > max) m.delete(m.keys().next().value as string);
}

/** The depth map with sharper edges if it has been worked out already (undefined = not yet). */
export function peekRefined(key: string, strength: number): DepthMap | undefined {
  return refined.get(`${key}|${strength.toFixed(2)}`);
}

/** The depth map with sharper edges along the outline (worked out once per picture, outline and strength). */
export function refinedDepth(key: string, depth: DepthMap, mask: SubjectMask, strength: number): DepthMap {
  const k = `${key}|${strength.toFixed(2)}`;
  const known = refined.get(k);
  if (known) {
    keep(refined, k, known, REFINED_KEEP);
    return known;
  }
  const m = refineEdges(depth, mask, strength);
  keep(refined, k, m, REFINED_KEEP);
  return m;
}

/** A background plate: RGBA, the colour with the subject filled in, alpha = the depth with the subject filled in. */
export interface Plate {
  w: number;
  h: number;
  data: Uint8Array;
  /** How it was filled ('' = Simple). */
  model: string;
}

export interface PlateRequest {
  src: string;
  /** The picture's size as drawn (the plate is at most PLATE_MAX). */
  w: number;
  h: number;
  mask: SubjectMask;
  depth: DepthMap;
  /** '' = Simple, else the fill model ('migan', 'lama'); one that can't be used falls back to Simple. */
  model: string;
}

/** The plate for this picture (made once per key, a few kept in memory). */
export function plateFor(key: string, r: PlateRequest): Promise<Plate | null> {
  const known = plates.get(key);
  if (known) {
    keep(plates, key, known, PLATES_KEEP);
    return known;
  }
  const p = makePlate(r).catch(() => null);
  keep(plates, key, p, PLATES_KEEP);
  void p.then((x) => {
    if (!x && plates.get(key) === p) plates.delete(key);
  });
  return p;
}

function canvas2d(w: number, h: number): { c: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No canvas.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}

async function makePlate(r: PlateRequest): Promise<Plate | null> {
  const k = Math.min(1, PLATE_MAX / Math.max(r.w, r.h));
  const w = Math.max(1, Math.round(r.w * k));
  const h = Math.max(1, Math.round(r.h * k));
  const res = await fetch(r.src);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } as ImageBitmapOptions);
  const pic = canvas2d(w, h);
  try {
    pic.ctx.drawImage(bmp, 0, 0);
  } finally {
    bmp.close();
  }
  const orig = pic.ctx.getImageData(0, 0, w, h).data;
  // What to fill: the outline grown a little (its soft edge too), fading out at the rim.
  const side = Math.min(r.mask.w, r.mask.h);
  const hole = holeMask(r.mask, side * 0.004, side * 0.004);
  // The fill, at whatever size it was made.
  let fill: OffscreenCanvas | null = null;
  let used = '';
  if (r.model) {
    try {
      const info = await inpaintPack(r.model);
      if (info?.available) {
        const s = info.inputSide && info.inputSide > 0 ? info.inputSide : 512;
        const sq = canvas2d(s, s);
        sq.ctx.drawImage(pic.c, 0, 0, s, s);
        const px = sq.ctx.getImageData(0, 0, s, s).data;
        const hs = resample(hole, r.mask.w, r.mask.h, s, s);
        const mb = new Uint8Array(s * s);
        for (let i = 0; i < mb.length; i++) mb[i] = hs[i] > 0.02 ? 255 : 0;
        const out = await api.inpaintEstimate({ width: s, height: s, model: info.model ?? r.model }, new Uint8Array(px.buffer, px.byteOffset, px.byteLength), mb);
        const f = canvas2d(out.w, out.h);
        f.ctx.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.w, out.h), 0, 0);
        fill = f.c;
        used = info.model ?? r.model;
      }
    } catch {
      fill = null; // Simple takes over
    }
  }
  if (!fill) {
    const ks = Math.min(1, SIMPLE_SIDE / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * ks));
    const sh = Math.max(1, Math.round(h * ks));
    const small = canvas2d(sw, sh);
    small.ctx.drawImage(pic.c, 0, 0, sw, sh);
    const px = small.ctx.getImageData(0, 0, sw, sh).data;
    const filled = fillRgba(px, sw, sh, resample(hole, r.mask.w, r.mask.h, sw, sh));
    small.ctx.putImageData(new ImageData(new Uint8ClampedArray(filled), sw, sh), 0, 0);
    fill = small.c;
  }
  const big = canvas2d(w, h);
  big.ctx.drawImage(fill, 0, 0, w, h);
  const F = big.ctx.getImageData(0, 0, w, h).data;
  const hf = resample(hole, r.mask.w, r.mask.h, w, h);
  // The depth: the subject area filled with the background's depth around it. A wider area than the
  // colour's: the depth model blurs the subject's depth a little way out into the background, which
  // would otherwise make the background right next to the subject swim along with it.
  const depthHole = holeMask(r.mask, side * 0.015, side * 0.006);
  const pd = fillDepth(r.depth, resample(depthHole, r.mask.w, r.mask.h, r.depth.w, r.depth.h));
  const df = resample(pd.data, pd.w, pd.h, w, h);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = hf[i];
    const j = i * 4;
    data[j] = orig[j] + (F[j] - orig[j]) * a;
    data[j + 1] = orig[j + 1] + (F[j + 1] - orig[j + 1]) * a;
    data[j + 2] = orig[j + 2] + (F[j + 2] - orig[j + 2]) * a;
    data[j + 3] = df[i];
  }
  return { w, h, data, model: used };
}

/**
 * The subject as its own layer (Lift-off, Layered 3D, 3D only on the subject): RGBA at
 * the plate's size, the colour with its soft rim cleaned (layers.ts subjectColours),
 * alpha = the subject's own depth carried out past its rim (subjectOwnDepth). Drawn with
 * the outline as its transparency, so it moves as one clean piece at its own depth.
 */
export function foreFor(key: string, r: Omit<PlateRequest, 'model'>): Promise<Plate | null> {
  const known = fores.get(key);
  if (known) {
    keep(fores, key, known, PLATES_KEEP);
    return known;
  }
  const p = makeFore(r).catch(() => null);
  keep(fores, key, p, PLATES_KEEP);
  void p.then((x) => {
    if (!x && fores.get(key) === p) fores.delete(key);
  });
  return p;
}

async function makeFore(r: Omit<PlateRequest, 'model'>): Promise<Plate | null> {
  const k = Math.min(1, PLATE_MAX / Math.max(r.w, r.h));
  const w = Math.max(1, Math.round(r.w * k));
  const h = Math.max(1, Math.round(r.h * k));
  const res = await fetch(r.src);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } as ImageBitmapOptions);
  const pic = canvas2d(w, h);
  try {
    pic.ctx.drawImage(bmp, 0, 0);
  } finally {
    bmp.close();
  }
  const orig = pic.ctx.getImageData(0, 0, w, h).data;
  const m = resample(r.mask.data, r.mask.w, r.mask.h, w, h);
  const rgb = subjectColours(orig, m, w, h);
  const own = subjectOwnDepth(r.depth, r.mask);
  const od = resample(own.data, own.w, own.h, w, h);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = Math.round(od[i]);
  }
  return { w, h, data, model: '' };
}

/**
 * The subject cut out of the picture at its full size, as a PNG with a
 * transparent background: the outline enlarged to the picture's size, its
 * soft edge kept.
 */
export async function subjectPng(src: string, mask: SubjectMask): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error("The picture couldn't be read.");
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const { c, ctx } = canvas2d(bmp.width, bmp.height);
  try {
    ctx.drawImage(bmp, 0, 0);
  } finally {
    bmp.close();
  }
  const m = canvas2d(mask.w, mask.h);
  const a = new Uint8ClampedArray(mask.w * mask.h * 4);
  for (let i = 0; i < mask.w * mask.h; i++) a[i * 4 + 3] = mask.data[i];
  m.ctx.putImageData(new ImageData(a, mask.w, mask.h), 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(m.c, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/png' });
}
