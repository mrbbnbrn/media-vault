// Picture fingerprints for finding look-alikes, made the same way as in the
// user's Baro Alarm app: a 64-bit perceptual hash (pHash) and a sharpness
// score, both from the small thumbnail. Made once per item in the
// background; the library compares them.

import { api, thumbUrl } from './api';
import { loopJob } from './jobs';

// cos((2x + 1) · u · π / 64) for the 8 lowest frequencies over 32 pixels.
const COS: Float64Array[] = Array.from({ length: 8 }, (_, u) =>
  Float64Array.from({ length: 32 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 64)),
);

/**
 * pHash of a 32×32 grey picture (row by row): a 2D DCT, the top-left 8×8
 * (the overall shapes and light), each above the median (leaving out the
 * average brightness) = 1. Returned as 16 hex digits.
 */
export function phash(gray: ArrayLike<number>): string {
  const rows: Float64Array[] = [];
  for (let y = 0; y < 32; y++) {
    const r = new Float64Array(8);
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 32; x++) s += gray[y * 32 + x] * COS[u][x];
      r[u] = s;
    }
    rows.push(r);
  }
  const vals = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 32; y++) s += rows[y][u] * COS[v][y];
      vals[v * 8 + u] = s;
    }
  }
  const rest = Array.from(vals.subarray(1)).sort((a, b) => a - b);
  const median = (rest[31] + rest[32]) / 2;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 64; i++) {
    if (vals[i] > median) {
      if (i < 32) lo |= 1 << i;
      else hi |= 1 << (i - 32);
    }
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(hi) + hex(lo);
}

/** Sharpness: the variance of the Laplacian (4·pixel − its 4 neighbours). Higher = sharper. */
export function sharpness(g: ArrayLike<number>, w = 64, h = 64): number {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const l = 4 * g[y * w + x] - g[y * w + x - 1] - g[y * w + x + 1] - g[(y - 1) * w + x] - g[(y + 1) * w + x];
      s += l;
      s2 += l * l;
      n++;
    }
  }
  const m = s / n;
  return s2 / n - m * m;
}

/** How many of the 64 bits differ. */
export function distance(a: string, b: string): number {
  let d = 0;
  for (let k = 0; k < 16; k += 8) {
    let x = (parseInt(a.slice(k, k + 8), 16) ^ parseInt(b.slice(k, k + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

/** Grey values (0.299 R + 0.587 G + 0.114 B) of a picture scaled to size × size. */
function grey(img: CanvasImageSource, size: number): Float64Array {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size).data;
  const out = new Float64Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}

async function fingerprintOf(id: number): Promise<{ hash: string; sharp: number }> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = thumbUrl(id);
  try {
    await img.decode();
    return { hash: phash(grey(img, 32)), sharp: sharpness(grey(img, 64)) };
  } finally {
    img.src = '';
  }
}

// ---- background maker ---------------------------------------------------------------------

let running = false;
let stopFn: (() => void) | null = null;
let wake: (() => void) | null = null;
const listeners = new Set<() => void>();

export function onFingerprintProgress(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Fingerprints were made (also by the app's own analysis pass). */
export function noteFingerprintProgress() {
  listeners.forEach((l) => l());
}

export function kickFingerprints() {
  wake?.();
}

/** Fingerprints every new picture, a little at a time. Stops on lock. */
export function startFingerprinter(): () => void {
  if (running) return stopFn ?? (() => {});
  running = true;
  let stopped = false;
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
  const job = loopJob('fingerprints', {
    label: 'Fingerprinting pictures', left: () => api.similarStatus().then((s) => Math.max(0, s.total - s.done)),
  });
  (async () => {
    let told = 0;
    const tell = (force = false) => {
      if (force || Date.now() - told > 700) {
        told = Date.now();
        listeners.forEach((l) => l());
      }
    };
    while (!stopped) {
      let tasks: { id: number }[] = [];
      try {
        tasks = await api.similarNeeded(50);
      } catch {
        break; // locked
      }
      if (!tasks.length) {
        tell(true);
        job.idle();
        await sleep(15_000);
        continue;
      }
      job.batch();
      for (const t of tasks) {
        if (stopped) break;
        try {
          const f = await fingerprintOf(t.id);
          if (stopped) break;
          await api.similarSave(t.id, f.hash, f.sharp);
        } catch {
          if (stopped) break;
          await api.similarFailed(t.id).catch(() => {});
        }
        job.step();
        tell();
        await new Promise((r) => setTimeout(r, 8));
      }
    }
    job.idle();
    running = false;
  })();
  stopFn = () => {
    stopped = true;
    running = false;
    wake?.();
  };
  return stopFn;
}
