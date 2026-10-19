// The pieces made once per picture for the picture layers of 3D photos
// (still pictures only), kept in memory (dropped on lock); the plate and the
// subject layer of pictures in the vault are also saved there (encrypted,
// packed: layerpack.ts), so a picture prepared once (prepare.ts) or seen once
// shows Lift-off and Layered 3D at once, without working anything out:
//
// - the depth map with sharper edges (layers.ts refineEdges), kept for a few pictures;
// - Layered 3D's background plate: the picture with the subject filled in
//   (Simple: pulled in from the surroundings on a small copy, then enlarged;
//   MI-GAN / LaMa: natively, on a square copy of their size), with the depth
//   map filled the same way in its alpha channel, ready for one texture;
// - the subject cut out at full size as a PNG with a transparent background
//   ("Save subject as PNG").

import { api, onLocked, type DepthMap, type SubjectMask } from './api';
import { savedChanged } from './derived';
import { packedSize, packLayer, unpackLayer } from './layerpack';
import { inpaintPack } from './inpaint';
import { refineEdges } from './layers';
import { pixelsOffThread } from './picturecache';
import { composeFore, composePlate, holeSquare } from './platemath';

const REFINED_KEEP = 8;
const PLATES_KEEP = 4;
/** The plate's longest side at most (its fill is soft anyway; the picture outside the subject is the picture itself). */
const PLATE_MAX = 1600;

const refined = new Map<string, DepthMap>();
const plates = new Map<string, Promise<Plate | null>>();
const fores = new Map<string, Promise<Plate | null>>();
void onLocked(() => {
  refined.clear();
  plates.clear();
  fores.clear();
}).catch(() => {});

/** The saved ones were cleared (prepare again): the copies in memory go too. */
export function forgetLayers() {
  refined.clear();
  plates.clear();
  fores.clear();
}

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
  /** A picture in the vault: its saved layer is used (and a new one saved) under this tag. `wait`: saved before it is given (preparing). */
  save?: { id: number; tag: string; wait?: boolean };
}

/** The plate for this picture (made once per key, a few kept in memory). */
export function plateFor(key: string, r: PlateRequest): Promise<Plate | null> {
  const known = plates.get(key);
  if (known) {
    keep(plates, key, known, PLATES_KEEP);
    return known;
  }
  const p = savedOrMade('plate', r, () => makePlate(r), (x) => x.model === r.model).catch(() => null);
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

// ---- the work, away from the window's thread ------------------------------------------------------
// The picture is decoded, resized and read in the decode worker (picturecache.ts), the maths
// runs in the layer worker (layerworker.ts, platemath.ts). Only the fill models' call is here.

/** The picture's pixels at the plate's size (one read for the plate and the subject layer). */
const pixelsKept = new Map<string, Promise<{ data: Uint8ClampedArray; w: number; h: number } | null>>();
function picturePixels(src: string, w: number, h: number) {
  const key = `${src}|${w}x${h}`;
  const known = pixelsKept.get(key);
  if (known) return known;
  const p = pixelsOffThread(src, w, h);
  keep(pixelsKept, key, p, 2);
  return p;
}
void onLocked(() => pixelsKept.clear()).catch(() => {});

let worker: Worker | null | undefined;
let jobId = 0;
const jobs = new Map<number, { ok: (b: ArrayBuffer) => void; fail: (e: Error) => void }>();
function layerWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./layerworker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; data?: ArrayBuffer; error?: string }>) => {
      const j = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (!j) return;
      if (e.data.data) j.ok(e.data.data);
      else j.fail(new Error(e.data.error ?? 'failed'));
    };
    worker.onerror = () => {
      for (const j of jobs.values()) j.fail(new Error('worker failed'));
      jobs.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

type LayerJob =
  | { op: 'plate'; orig: Uint8ClampedArray; w: number; h: number; mask: SubjectMask; depth: DepthMap; fill: { data: Uint8ClampedArray; w: number; h: number } | null }
  | { op: 'fore'; orig: Uint8ClampedArray; w: number; h: number; mask: SubjectMask; depth: DepthMap }
  | { op: 'holeSquare'; mask: SubjectMask; side: number }
  | { op: 'pack'; orig: Uint8ClampedArray; layer: Uint8Array; w: number; h: number }
  | { op: 'unpack'; orig: Uint8ClampedArray; bytes: Uint8Array };

/** Run a layer job in the worker (copies of the arrays go there), else here. */
async function runLayerJob(j: LayerJob): Promise<Uint8Array> {
  const w = layerWorker();
  if (w) {
    const id = ++jobId;
    const msg: Record<string, unknown> = { ...j, id };
    const transfer: Transferable[] = [];
    if (j.op !== 'holeSquare') {
      const orig = j.orig.slice().buffer;
      msg.orig = orig;
      transfer.push(orig);
      if (j.op === 'pack') {
        const l = j.layer.slice().buffer;
        msg.layer = l;
        transfer.push(l);
      }
      if (j.op === 'unpack') {
        const b = j.bytes.slice().buffer;
        msg.bytes = b;
        transfer.push(b);
      }
      if (j.op === 'plate' && j.fill) {
        const f = j.fill.data.slice().buffer;
        msg.fill = { data: f, w: j.fill.w, h: j.fill.h };
        transfer.push(f);
      }
    }
    try {
      return new Uint8Array(await new Promise<ArrayBuffer>((ok, fail) => {
        jobs.set(id, { ok, fail });
        w.postMessage(msg, transfer);
      }));
    } catch {
      // Here instead.
    }
  }
  if (j.op === 'pack') return packLayer(j.orig, j.layer, j.w, j.h);
  if (j.op === 'unpack') return unpackLayer(j.orig, j.bytes);
  if (j.op === 'plate') return composePlate(j.orig, j.w, j.h, j.mask, j.depth, j.fill);
  if (j.op === 'fore') return composeFore(j.orig, j.w, j.h, j.mask, j.depth);
  return holeSquare(j.mask, j.side);
}

// ---- saved layers (pictures in the vault) -------------------------------------------------------

/** The saved layer (read back onto the picture at its saved size), else made now and saved (when `fits`). */
async function savedOrMade(kind: 'plate' | 'fore', r: { src: string; model?: string; save?: { id: number; tag: string; wait?: boolean } }, make: () => Promise<Plate | null>, fits: (made: Plate) => boolean): Promise<Plate | null> {
  if (r.save) {
    const got = await loadLayer(kind, r.src, r.save, r.model ?? '');
    if (got) return got;
  }
  const made = await make();
  if (made && r.save && fits(made)) {
    const saving = saveLayer(kind, r.src, r.save, made);
    if (r.save.wait) await saving;
  }
  return made;
}

async function loadLayer(kind: 'plate' | 'fore', src: string, save: { id: number; tag: string }, model: string): Promise<Plate | null> {
  try {
    const bytes = await api.derivedGet(save.id, kind, save.tag);
    const size = bytes ? packedSize(bytes) : null;
    if (!bytes || !size) return null;
    const pic = await picturePixels(src, size.w, size.h);
    if (!pic || pic.w !== size.w || pic.h !== size.h) return null;
    const data = await runLayerJob({ op: 'unpack', orig: pic.data, bytes });
    return { w: size.w, h: size.h, data, model };
  } catch {
    return null; // made again
  }
}

/** Saves a layer just made (in the background; a failure only means it's made again next time). */
export async function saveLayer(kind: 'plate' | 'fore', src: string, save: { id: number; tag: string }, made: Plate): Promise<void> {
  try {
    const pic = await picturePixels(src, made.w, made.h);
    if (!pic || pic.w !== made.w || pic.h !== made.h) return;
    const bytes = await runLayerJob({ op: 'pack', orig: pic.data, layer: made.data, w: made.w, h: made.h });
    await api.derivedPut(save.id, kind, save.tag, bytes);
    savedChanged();
  } catch (e) {
    console.warn(`Couldn't save the 3D layer (${kind}):`, e);
  }
}

/** The tags saved layers go under: what they were made from (depth.ts depthTag, subject.ts subjectTag, edges, fill). */
export function layerTags(depthTag: string, subjectTag: string, edges: number, fill: string): { fore: string; plate: string } {
  const base = `${depthTag}_${subjectTag}_e${edges.toFixed(2)}`;
  return { fore: base, plate: `${base}_${fill || 'simple'}` };
}

function plateSize(r: { w: number; h: number }) {
  const k = Math.min(1, PLATE_MAX / Math.max(r.w, r.h));
  return { w: Math.max(1, Math.round(r.w * k)), h: Math.max(1, Math.round(r.h * k)) };
}

async function makePlate(r: PlateRequest): Promise<Plate | null> {
  const { w, h } = plateSize(r);
  const pic = await picturePixels(r.src, w, h);
  if (!pic) return null;
  // A fill model's result (on a square copy of its size), else Simple (in the worker).
  let fill: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  let used = '';
  if (r.model) {
    try {
      const info = await inpaintPack(r.model);
      if (info?.available) {
        const s = info.inputSide && info.inputSide > 0 ? info.inputSide : 512;
        const sq = await pixelsOffThread(r.src, s, s);
        if (sq) {
          const mb = await runLayerJob({ op: 'holeSquare', mask: r.mask, side: s });
          const out = await api.inpaintEstimate({ width: s, height: s, model: info.model ?? r.model }, new Uint8Array(sq.data.buffer, sq.data.byteOffset, sq.data.byteLength), mb);
          fill = { data: new Uint8ClampedArray(out.data), w: out.w, h: out.h };
          used = info.model ?? r.model;
        }
      }
    } catch {
      fill = null; // Simple takes over
    }
  }
  const data = await runLayerJob({ op: 'plate', orig: pic.data, w: pic.w, h: pic.h, mask: r.mask, depth: r.depth, fill });
  return { w: pic.w, h: pic.h, data, model: used };
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
  const p = savedOrMade('fore', r, () => makeFore(r), () => true).catch(() => null);
  keep(fores, key, p, PLATES_KEEP);
  void p.then((x) => {
    if (!x && fores.get(key) === p) fores.delete(key);
  });
  return p;
}

async function makeFore(r: Omit<PlateRequest, 'model'>): Promise<Plate | null> {
  const { w, h } = plateSize(r);
  const pic = await picturePixels(r.src, w, h);
  if (!pic) return null;
  const data = await runLayerJob({ op: 'fore', orig: pic.data, w: pic.w, h: pic.h, mask: r.mask, depth: r.depth });
  return { w: pic.w, h: pic.h, data, model: '' };
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
