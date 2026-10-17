// Decoded pictures for the viewer, in memory only.
//
//  - Decoding happens off the main thread (createImageBitmap), straight to
//    about the size of the screen, so a 50-megapixel photo opens without
//    freezing the window and costs ~15 MB to keep instead of ~200 MB. The
//    decrypted file stays alongside, so the full picture can be decoded
//    (again off the main thread) once you zoom in past what the screen copy
//    holds.
//  - The last few pictures stay decoded (going back and forth is instant),
//    and the viewer decodes the next ones ahead of time (preload()).
//  - Everything is let go when the last viewer closes, the vault locks, a
//    picture's file changes (saved rotation), or the window is hidden for a
//    while; and older pictures go first when the memory budget is reached.
//
// Nothing is ever written to disk: bytes live in ordinary memory and are
// only wrapped in a Blob for the moment of decoding.

import { onLocked } from './api';
import { onItemsChanged } from './media';

export interface Picture {
  /** What to draw: a screen-sized copy, or the whole picture if it is small. */
  bmp: ImageBitmap;
  /** The picture's real size (pixels, turned as the file says). */
  natural: { w: number; h: number };
  /** `bmp` is the whole picture. */
  full: boolean;
  /** The decrypted file, kept while `bmp` is a reduced copy (for zooming in). */
  bytes: Uint8Array<ArrayBuffer> | null;
}

export interface GifBytes {
  gif: true;
  bytes: Uint8Array<ArrayBuffer>;
}

type Value = Picture | GifBytes;

/** Most recently used last; older ones go first, except those held or wanted. */
export class Lru<V> {
  private map = new Map<string, { v: V; cost: number }>();
  private held = new Map<string, number>();
  private wanted = new Set<string>();
  total = 0;

  constructor(
    public maxEntries: number,
    public maxCost: number,
    private release: (v: V) => void,
  ) {}

  get size() {
    return this.map.size;
  }

  has(k: string) {
    return this.map.has(k);
  }

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V, cost: number) {
    const old = this.map.get(k);
    if (old) {
      this.map.delete(k);
      this.total -= old.cost;
      if (old.v !== v) this.release(old.v);
    }
    this.map.set(k, { v, cost });
    this.total += cost;
    // Never the one just added: whoever decoded it is about to draw it.
    this.trim(this.maxEntries, this.maxCost, k);
  }

  delete(k: string) {
    const e = this.map.get(k);
    if (!e) return;
    this.map.delete(k);
    this.total -= e.cost;
    this.release(e.v);
  }

  /** In use (drawn right now): never let go until unheld. */
  hold(k: string) {
    this.held.set(k, (this.held.get(k) ?? 0) + 1);
  }

  unhold(k: string) {
    const n = (this.held.get(k) ?? 0) - 1;
    if (n > 0) this.held.set(k, n);
    else this.held.delete(k);
    this.trim();
  }

  /** About to be shown (preloaded): kept before older ones. Replaces the last set. */
  want(keys: Iterable<string>) {
    this.wanted = new Set(keys);
    this.trim();
  }

  private keep(k: string) {
    return this.held.has(k) || this.wanted.has(k);
  }

  /** Let go of the oldest until within the limits (held and wanted ones stay). */
  trim(maxEntries = this.maxEntries, maxCost = this.maxCost, spare?: string) {
    for (const k of [...this.map.keys()]) {
      if (this.map.size <= maxEntries && this.total <= maxCost) return;
      if (k !== spare && !this.keep(k)) this.delete(k);
    }
  }

  /** Let go of everything not drawn right now. */
  dropUnheld() {
    for (const k of [...this.map.keys()]) if (!this.held.has(k)) this.delete(k);
  }

  clear() {
    for (const k of [...this.map.keys()]) this.delete(k);
    this.wanted.clear();
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

const MB = 1024 * 1024;

/** How much decoded pictures may take: an eighth of the computer's memory, between 256 MB and 1 GB. */
export function budgetBytes(deviceMemoryGb: number | undefined): number {
  const gb = deviceMemoryGb && deviceMemoryGb > 0 ? deviceMemoryGb : 8;
  return Math.max(256 * MB, Math.min(1024 * MB, (gb * 1024 * MB) / 8));
}

/** The last 5 shown plus the next 2 and 1 behind. */
const ENTRIES = 8;

function costOf(v: Value): number {
  if ('gif' in v) return v.bytes.byteLength;
  return v.bmp.width * v.bmp.height * 4 + (v.bytes?.byteLength ?? 0);
}

const cache = new Lru<Value>(
  ENTRIES,
  budgetBytes(typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined),
  (v) => {
    if (!('gif' in v)) v.bmp.close();
  },
);
const inflight = new Map<string, Promise<Value>>();
let generation = 0;

/**
 * The size to decode to for a picture of real size `size` shown in a box
 * of `box` device pixels: just enough to fill the box (as "cover" would),
 * never larger than the picture. Null = decode as it is.
 */
export function displayScale(size: { w: number; h: number } | null | undefined, box: { w: number; h: number }): number | null {
  if (!size || size.w <= 0 || size.h <= 0 || box.w <= 0 || box.h <= 0) return null;
  const k = Math.max(box.w / size.w, box.h / size.h);
  // Not worth a reduced copy for pictures barely bigger than the screen.
  return k >= 0.8 ? null : k;
}

/** What the viewer's picture box is in device pixels (the whole screen in the full viewer). */
export function screenBox(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1920, h: 1080 };
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(window.innerWidth, window.screen?.width ?? 0);
  const h = Math.max(window.innerHeight, window.screen?.height ?? 0);
  return { w: Math.round(w * dpr), h: Math.round(h * dpr) };
}

// ---- decoding in a worker (decodeworker.ts) ---------------------------------------------

let worker: Worker | null | undefined;
let jobId = 0;
type Decoded = { bmp?: ImageBitmap; data?: ArrayBuffer; w?: number; h?: number; bytes: ArrayBuffer };
const jobs = new Map<number, { ok: (r: Decoded) => void; fail: (e: Error) => void }>();

function decoder(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./decodeworker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Decoded & { id: number; error?: string }>) => {
      const j = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (!j) return e.data.bmp?.close();
      if (e.data.bmp || e.data.data) j.ok(e.data);
      else j.fail(Object.assign(new Error(e.data.error ?? 'decode failed'), { bytes: e.data.bytes }));
    };
    worker.onerror = () => {
      // No worker after all: decode here from now on.
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

/**
 * Decode `bytes` (optionally to `resizeWidth` wide) without blocking the
 * window. The bytes travel to the worker and back without being copied;
 * the returned array is the one to keep using.
 */
async function bitmapOf(bytes: Uint8Array<ArrayBuffer>, resizeWidth?: number, resizeHeight?: number): Promise<{ bmp: ImageBitmap; bytes: Uint8Array<ArrayBuffer> }> {
  const w = decoder();
  if (w) {
    const id = ++jobId;
    try {
      const r = await new Promise<Decoded>((ok, fail) => {
        jobs.set(id, { ok, fail });
        w.postMessage({ id, bytes: bytes.buffer, resizeWidth, resizeHeight }, [bytes.buffer]);
      });
      return { bmp: r.bmp!, bytes: new Uint8Array(r.bytes) };
    } catch (e) {
      const back = (e as { bytes?: ArrayBuffer }).bytes;
      if (!back) throw e;
      // Couldn't decode there: one more try here (older engines without createImageBitmap in workers).
      bytes = new Uint8Array(back);
    }
  }
  return { bmp: await bitmapHere(bytes, resizeWidth, resizeHeight), bytes };
}

/**
 * A picture's RGBA pixels at `w` × `h` (stretched to it), decoded, resized and read in
 * the worker: the 3D models' input, the 3D layers. Nothing of it runs on the window's
 * thread (a high-quality resize there froze the window for up to a second per photo).
 */
export async function pixelsOffThread(src: string, w: number, h: number): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> {
  const bytes = await fetchBytes(src).catch(() => null);
  if (!bytes) return null;
  const wk = decoder();
  if (wk) {
    const id = ++jobId;
    try {
      const r = await new Promise<Decoded>((ok, fail) => {
        jobs.set(id, { ok, fail });
        wk.postMessage({ id, bytes: bytes.buffer, resizeWidth: w, resizeHeight: h, pixels: true }, [bytes.buffer]);
      });
      if (r.data) return { data: new Uint8ClampedArray(r.data), w: r.w!, h: r.h! };
    } catch {
      // Below, here.
    }
  }
  try {
    const again = bytes.buffer.byteLength ? bytes : await fetchBytes(src);
    const bmp = await bitmapHere(again, w, h);
    try {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0);
      return { data: ctx.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
    } finally {
      bmp.close();
    }
  } catch {
    return null;
  }
}

/** A picture decoded and resized to `w` × `h` in the worker (for drawing it, e.g. as a 3D texture). */
export async function bitmapOffThread(src: string, w: number, h: number): Promise<ImageBitmap | null> {
  const bytes = await fetchBytes(src).catch(() => null);
  if (!bytes) return null;
  try {
    return (await bitmapOf(bytes, w, h)).bmp;
  } catch {
    return null;
  }
}

async function bitmapHere(bytes: Uint8Array<ArrayBuffer>, resizeWidth?: number, resizeHeight?: number): Promise<ImageBitmap> {
  const blob = new Blob([bytes]);
  const opts: ImageBitmapOptions = { imageOrientation: 'from-image' };
  if (resizeWidth) Object.assign(opts, { resizeWidth, resizeQuality: 'high' });
  if (resizeWidth && resizeHeight) opts.resizeHeight = resizeHeight;
  try {
    return await createImageBitmap(blob, opts);
  } catch {
    // Older engines: without the extra options.
    return await createImageBitmap(blob, resizeWidth ? { resizeWidth } : undefined);
  }
}

async function fetchBytes(src: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(src, { signal });
  if (!r.ok) throw new Error(String(r.status));
  return new Uint8Array(await r.arrayBuffer());
}

async function decode(src: string, kind: 'image' | 'gif', size: { w: number; h: number } | null | undefined): Promise<Value> {
  const fetched = await fetchBytes(src);
  if (kind === 'gif') return { gif: true, bytes: fetched };
  const k = displayScale(size, screenBox());
  if (k == null || !size) {
    const { bmp } = await bitmapOf(fetched);
    return { bmp, natural: { w: bmp.width, h: bmp.height }, full: true, bytes: null };
  }
  const { bmp, bytes } = await bitmapOf(fetched, Math.max(1, Math.round(size.w * k)));
  // The known size may be the other way round (turned by the file's orientation tag).
  const a = bmp.width / bmp.height;
  const natural = Math.abs(a - size.w / size.h) < 0.02 * a ? size : Math.abs(a - size.h / size.w) < 0.02 * a ? { w: size.h, h: size.w } : null;
  if (!natural) {
    // The size we were told is wrong: decode the whole picture to be sure.
    bmp.close();
    const { bmp: full } = await bitmapOf(bytes);
    return { bmp: full, natural: { w: full.width, h: full.height }, full: true, bytes: null };
  }
  return { bmp, natural, full: false, bytes };
}

async function decodeRetrying(src: string, kind: 'image' | 'gif', size: { w: number; h: number } | null | undefined) {
  try {
    return await decode(src, kind, size);
  } catch (e) {
    // Out of memory? Let go of everything not on screen and try once more.
    if (!cache.size) throw e;
    cache.dropUnheld();
    return await decode(src, kind, size);
  }
}

/** A picture (or a GIF's bytes), from memory if it is there, else fetched and decoded. */
export function loadPicture(src: string, kind: 'image' | 'gif', size?: { w: number; h: number } | null): Promise<Value> {
  hookUp();
  const have = cache.get(src);
  if (have) return Promise.resolve(have);
  const running = inflight.get(src);
  if (running) return running;
  const gen = generation;
  const p = decodeRetrying(src, kind, size).then(
    (v) => {
      inflight.delete(src);
      if (gen !== generation) {
        // Forgotten meanwhile (locked, file changed): hand it over once, keep nothing.
        return v;
      }
      cache.set(src, v, costOf(v));
      return v;
    },
    (e) => {
      inflight.delete(src);
      throw e;
    },
  );
  inflight.set(src, p);
  return p;
}

/** Already decoded? (No fetch.) */
export function cachedPicture(src: string): Value | undefined {
  return cache.get(src);
}

/** The whole picture at full resolution (the caller owns it and closes it). */
export function fullPicture(p: Picture): Promise<ImageBitmap | null> {
  return fromBytes(p);
}

/**
 * The picture decoded afresh at exactly w × h (a sharp resample for a zoom
 * between screen size and full size), made in the worker from the file
 * rather than from the whole decoded picture, so the window never stalls.
 * Null if the file isn't kept (or is busy being decoded).
 */
export function resizedPicture(p: Picture, w: number, h: number): Promise<ImageBitmap | null> {
  return fromBytes(p, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
}

async function fromBytes(p: Picture, w?: number, h?: number): Promise<ImageBitmap | null> {
  if (p.full || !p.bytes) return null;
  // The bytes are lent to the worker meanwhile; nobody else reads them.
  const lent = p.bytes;
  p.bytes = null;
  try {
    const r = await bitmapOf(lent, w, h);
    p.bytes = r.bytes;
    return r.bmp;
  } catch (e) {
    p.bytes = lent.byteLength ? lent : null;
    throw e;
  }
}

/** The viewer draws this one: it stays while drawn. */
export function holdPicture(src: string): () => void {
  cache.hold(src);
  return () => cache.unhold(src);
}

let preloadToken = 0;

/**
 * Decode these ahead of time, one after the other, nearest first (pictures
 * and GIFs; anything else is skipped). Replaces the previous wish list.
 */
export function preloadPictures(list: { src: string; kind: string; size?: { w: number; h: number } | null }[]) {
  hookUp();
  const want = list.filter((x) => x.kind === 'image' || x.kind === 'gif');
  cache.want(want.map((x) => x.src));
  const token = ++preloadToken;
  (async () => {
    for (const x of want) {
      if (token !== preloadToken) return;
      await loadPicture(x.src, x.kind as 'image' | 'gif', x.size).catch(() => {});
    }
  })();
}

// ---- videos: the next ones start loading (details and first pictures) ----------------

const warm = new Map<string, HTMLVideoElement>();

/**
 * Let the next videos load their details and first part ahead of time, in
 * hidden players that are never shown. The file's first chunks are then
 * already decrypted and kept (protocol.rs) when the real player asks.
 */
export function warmVideos(srcs: string[]) {
  if (typeof document === 'undefined') return;
  const keep = new Set(srcs.slice(0, 2));
  for (const [s, v] of warm) {
    if (keep.has(s)) continue;
    v.removeAttribute('src');
    v.load();
    warm.delete(s);
  }
  for (const s of keep) {
    if (warm.has(s)) continue;
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.crossOrigin = 'anonymous';
    v.src = s;
    warm.set(s, v);
  }
}

/** Let go of every decoded picture (and stop warming videos). */
export function forgetPictures() {
  generation += 1;
  preloadToken += 1;
  cache.clear();
  warmVideos([]);
}

let users = 0;
/** A viewer is open (call the returned function when it closes); the last one to close lets go of everything. */
export function viewerOpened(): () => void {
  users += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users -= 1;
    if (users <= 0) {
      users = 0;
      forgetPictures();
    }
  };
}

let hooked = false;
function hookUp() {
  if (hooked || typeof document === 'undefined') return;
  hooked = true;
  onLocked(() => forgetPictures()).catch(() => {});
  onItemsChanged(() => forgetPictures());
  // Hidden for a minute (minimised, another program in front): keep only what is on screen.
  let t: ReturnType<typeof setTimeout> | null = null;
  document.addEventListener('visibilitychange', () => {
    if (t) clearTimeout(t);
    t = document.hidden ? setTimeout(() => cache.dropUnheld(), 60_000) : null;
  });
}

/** For tests and measurements. */
export const pictureCacheState = () => ({ entries: cache.size, bytes: cache.total, keys: cache.keys(), users, videos: [...warm.keys()] });
