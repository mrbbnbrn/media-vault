// Face recognition, the window side: find faces in pictures and video frames
// and make a 128-number fingerprint for each, fully offline (face-api, models
// built into the app). Nothing decrypted is written anywhere: pictures are
// decoded in memory, like thumbnails.

import { api, mediaUrl, type FaceIn, type Kind } from '../api';

type FaceApi = typeof import('@vladmandic/face-api');
type Raw = { x: number; y: number; w: number; h: number; px: number; score: number; descriptor: number[] };

const MODELS = '/facemodels';
/** Faces smaller than this (pixels in the original) give unreliable fingerprints. */
const MIN_FACE = 36;
/** Pictures are scaled down to this before looking for faces. */
const MAX_SIDE = 1280;

let backend = '';
/** "webgl" (graphics card) or "cpu", once loaded. */
export const faceBackend = () => backend;

// ---- preferred: a worker (keeps the window smooth) ---------------------------------------

let worker: Worker | null = null;
let workerOk: Promise<boolean> | null = null;
let seq = 0;
const waiting = new Map<number, (r: { faces?: Raw[]; backend?: string; error?: string }) => void>();

function ask(msg: Record<string, unknown>): Promise<{ faces?: Raw[]; backend?: string; error?: string }> {
  const id = ++seq;
  return new Promise((res) => {
    waiting.set(id, res);
    worker!.postMessage({ ...msg, id });
  });
}

function useWorker(): Promise<boolean> {
  workerOk ??= (async () => {
    try {
      worker = new Worker(new URL('./faceworker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const r = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        r?.(e.data);
      };
      worker.onerror = () => waiting.forEach((r) => r({ error: 'worker failed' }));
      const r = await Promise.race([
        ask({ type: 'init' }),
        new Promise<{ backend?: string; error?: string }>((res) => setTimeout(() => res({ error: 'timeout' }), 120_000)),
      ]);
      if (r.error) throw new Error(r.error);
      backend = r.backend ?? '';
      return true;
    } catch {
      worker?.terminate();
      worker = null;
      return false;
    }
  })();
  return workerOk;
}

// ---- fallback: on the main thread ---------------------------------------------------------

let lib: Promise<FaceApi> | null = null;
function loadFaceApi(): Promise<FaceApi> {
  lib ??= (async () => {
    const f = await import('@vladmandic/face-api');
    const tf = f.tf as unknown as { setBackend(b: string): Promise<boolean>; ready(): Promise<void>; getBackend(): string };
    const ok = await tf.setBackend('webgl').catch(() => false);
    if (!ok) await tf.setBackend('cpu');
    await tf.ready();
    backend = tf.getBackend();
    await Promise.all([
      f.nets.ssdMobilenetv1.loadFromUri(MODELS),
      f.nets.faceLandmark68Net.loadFromUri(MODELS),
      f.nets.faceRecognitionNet.loadFromUri(MODELS),
    ]);
    return f;
  })().catch((e) => {
    lib = null;
    throw e;
  });
  return lib;
}

async function detectHere(c: HTMLCanvasElement): Promise<Raw[]> {
  const f = await loadFaceApi();
  const found = await f
    .detectAllFaces(c, new f.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 40 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  return found.map((r) => {
    const b = r.detection.box;
    return { x: b.x / c.width, y: b.y / c.height, w: b.width / c.width, h: b.height / c.height, px: b.width, score: r.detection.score, descriptor: Array.from(r.descriptor) };
  });
}

function canvasOf(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext('2d', { willReadFrequently: true })!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Faces in one picture (coordinates as fractions of the picture). */
export async function detect(src: CanvasImageSource, w: number, h: number, frameMs = 0): Promise<FaceIn[]> {
  const c = canvasOf(src, w, h);
  let raw: Raw[];
  if (await useWorker()) {
    const r = await ask({ type: 'detect', img: c.getContext('2d')!.getImageData(0, 0, c.width, c.height) });
    if (r.error) throw new Error(r.error);
    raw = r.faces ?? [];
  } else {
    raw = await detectHere(c);
  }
  const scale = c.width / w;
  return raw
    .filter((r) => r.px / scale >= MIN_FACE && r.px >= 24)
    .map((r) => ({ frameMs, x: r.x, y: r.y, w: r.w, h: r.h, score: r.score, descriptor: r.descriptor }));
}

function dist(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

const timeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function scanImage(id: number): Promise<FaceIn[]> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = mediaUrl(id);
  try {
    await timeout(img.decode(), 30_000);
    return await detect(img, img.naturalWidth, img.naturalHeight);
  } finally {
    img.src = '';
  }
}

/** A few frames spread through the video; the same person seen again is kept once. */
async function scanVideo(id: number): Promise<FaceIn[]> {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  try {
    v.src = mediaUrl(id);
    await timeout(
      new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('unsupported'));
      }),
      30_000,
    );
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const spots = dur < 4 ? [dur / 2] : [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => p * dur);
    const kept: FaceIn[] = [];
    for (const t of spots) {
      if (Math.abs(v.currentTime - t) > 0.05) {
        await timeout(
          new Promise<void>((res) => {
            v.onseeked = () => res();
            v.currentTime = t;
          }),
          15_000,
        );
      }
      if (!v.videoWidth) continue;
      for (const face of await detect(v, v.videoWidth, v.videoHeight, Math.round(t * 1000))) {
        const same = kept.findIndex((k) => dist(k.descriptor, face.descriptor) < 0.45);
        if (same < 0) kept.push(face);
        else if (face.score * face.w > kept[same].score * kept[same].w) kept[same] = face;
      }
    }
    return kept;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

export function scanItem(id: number, kind: Kind): Promise<FaceIn[]> {
  return kind === 'video' ? scanVideo(id) : scanImage(id);
}

// ---- background scanner ------------------------------------------------------------------

let running = false;
let stopFn: (() => void) | null = null;
let wake: (() => void) | null = null;
let paused = false;
const listeners = new Set<() => void>();

export function onFaceProgress(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function kickFaceScanner() {
  wake?.();
}

export function setFaceScanPaused(p: boolean) {
  paused = p;
  if (!p) wake?.();
}

export function faceScanPaused() {
  return paused;
}

/** Scans what is queued, one item at a time, with little rests so the app stays smooth. */
export function startFaceScanner(): () => void {
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
  (async () => {
    let told = 0;
    const tell = (force = false) => {
      if (force || Date.now() - told > 800) {
        told = Date.now();
        listeners.forEach((l) => l());
      }
    };
    while (!stopped) {
      if (paused) {
        await sleep(60_000);
        continue;
      }
      let tasks: { id: number; kind: Kind }[] = [];
      try {
        tasks = await api.facesNeeded(8);
      } catch {
        break; // locked
      }
      if (!tasks.length) {
        tell(true);
        await sleep(10_000);
        continue;
      }
      for (const t of tasks) {
        if (stopped || paused) break;
        try {
          const faces = await scanItem(t.id, t.kind);
          if (stopped) break;
          await api.facesSave(t.id, faces);
        } catch {
          if (stopped) break;
          await api.facesFailed(t.id).catch(() => {});
        }
        tell();
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    running = false;
  })();
  stopFn = () => {
    stopped = true;
    running = false;
    wake?.();
  };
  return stopFn;
}
