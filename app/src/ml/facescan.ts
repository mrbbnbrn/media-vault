// Face recognition, the window side: decode pictures and video frames (in
// memory, like thumbnails; nothing decrypted is written anywhere) and find
// the faces in them, fully offline. With the faces pack (InsightFace
// buffalo_l, run natively: faceid.rs) the pixels are sent to the app and
// each face gets a 512-number fingerprint; without it the built-in face-api
// (models in the app) makes 128-number ones, as before.

import { api, mediaUrl, type FaceEngineStatus, type FaceIn, type Kind } from '../api';
import { loopJob, updateJob } from '../jobs';

type FaceApi = typeof import('@vladmandic/face-api');
type Raw = { x: number; y: number; w: number; h: number; px: number; score: number; descriptor: number[] };

const MODELS = '/facemodels';
/** Faces smaller than this (pixels in the original) give unreliable fingerprints. */
const MIN_FACE = 36;
/** Pictures are scaled down to this before looking for faces. */
const MAX_SIDE = 1280;

let backend = '';
/** "webgl" (graphics card) or "cpu", once loaded. */
export const faceBackend = () => (model === 1 ? (nativeDevice === 'gpu' ? 'native-gpu' : 'native-cpu') : backend);

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

/** The upscaler: the 68 face points of every face in a picture, in its own pixels. */
export async function facePoints(src: CanvasImageSource, w: number, h: number): Promise<[number, number][][]> {
  const c = canvasOf(src, w, h);
  let pts: [number, number][][];
  if (await useWorker()) {
    const r = (await ask({ type: 'points', img: c.getContext('2d')!.getImageData(0, 0, c.width, c.height) })) as { points?: [number, number][][]; error?: string };
    if (r.error) throw new Error(r.error);
    pts = r.points ?? [];
  } else {
    const f = await loadFaceApi();
    const found = await f.detectAllFaces(c, new f.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 40 })).withFaceLandmarks();
    pts = found.map((r) => r.landmarks.positions.map((p) => [p.x, p.y] as [number, number]));
  }
  const k = w / c.width;
  return pts.map((face) => face.map(([x, y]) => [x * k, y * k] as [number, number]));
}

// ---- native (the faces pack) ---------------------------------------------------------------

/** Pictures are sent to the native model at most this big (it finds faces at 640, and lines them up from these pixels). */
const NATIVE_SIDE = 1600;
/** Which model the scanner uses: 1 = InsightFace (faces pack), 0 = built-in face-api. */
let model: 0 | 1 = 0;
let nativeDevice: string | null = null;
let nativeFailures = 0;
export const faceModel = () => model;

/** Ask the app whether the faces pack is there (and use it if so). */
export async function checkFaceEngine(): Promise<FaceEngineStatus | null> {
  try {
    const e = await api.facesEngine();
    model = e.native.available && nativeFailures < 3 ? 1 : 0;
    nativeDevice = e.native.device;
    return e;
  } catch {
    return null;
  }
}

async function detectNative(src: CanvasImageSource, w: number, h: number, frameMs = 0): Promise<FaceIn[]> {
  const s = Math.min(1, NATIVE_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  try {
    const faces = await api.facesDetect({ width: c.width, height: c.height, frameMs }, new Uint8Array(px.buffer, px.byteOffset, px.byteLength));
    nativeFailures = 0;
    return faces;
  } catch (e) {
    // The model itself failing again and again: back to the built-in one.
    if (++nativeFailures >= 3) model = 0;
    throw e;
  } finally {
    c.width = c.height = 0;
  }
}

function cosine(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function dist(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

const timeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

const find = (m: 0 | 1, src: CanvasImageSource, w: number, h: number, frameMs = 0) =>
  m === 1 ? detectNative(src, w, h, frameMs) : detect(src, w, h, frameMs);

async function scanImage(id: number, m: 0 | 1): Promise<FaceIn[]> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = mediaUrl(id);
  try {
    await timeout(img.decode(), 30_000);
    return await find(m, img, img.naturalWidth, img.naturalHeight);
  } finally {
    img.src = '';
  }
}

/** A few frames spread through the video; the same person seen again is kept once. */
async function scanVideo(id: number, m: 0 | 1): Promise<FaceIn[]> {
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
      for (const face of await find(m, v, v.videoWidth, v.videoHeight, Math.round(t * 1000))) {
        const same = kept.findIndex((k) => (m === 1 ? cosine(k.descriptor, face.descriptor) > 0.5 : dist(k.descriptor, face.descriptor) < 0.45));
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

/** Faces in one item, with the built-in model (0) or the faces pack (1, the default when it is there). */
export function scanItem(id: number, kind: Kind, m: 0 | 1 = model): Promise<FaceIn[]> {
  return kind === 'video' ? scanVideo(id, m) : scanImage(id, m);
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
  let upgraded = false;
  let lastAuto = 0;
  let named = false;
  // Name sure faces automatically now and then while scanning (and at the end).
  const autoName = async (force = false) => {
    if (model !== 1 || (!force && Date.now() - lastAuto < 20_000) || (!force && !named)) return;
    lastAuto = Date.now();
    named = false;
    await api.facesAuto().catch(() => 0);
  };
  const job = loopJob('faces', {
    label: 'Scanning faces',
    long: true,
    left: () => api.facesStatus().then((s) => s.queued),
    cancel: () => {
      setFaceScanPaused(true);
      listeners.forEach((l) => l());
    },
    cancelLabel: 'Pause',
    summary: (n) => `Face scan finished: ${n.toLocaleString()} ${n === 1 ? 'item' : 'items'} scanned`,
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
        job.idle();
        await sleep(60_000);
        continue;
      }
      let tasks: { id: number; kind: Kind }[] = [];
      let upgrading = false;
      try {
        const engine = await checkFaceEngine();
        // The faces pack just arrived: everything is scanned again with it, once.
        if (engine && model === 1 && !upgraded) {
          upgraded = true;
          await api.facesUpgrade().catch(() => 0);
        }
        upgrading = model === 1 && (engine?.upgradeLeft ?? 0) > 0;
        tasks = await api.facesNeeded(8);
      } catch {
        break; // locked
      }
      if (!tasks.length) {
        await autoName(true);
        tell(true);
        job.idle();
        await sleep(10_000);
        continue;
      }
      job.batch();
      updateJob('faces', { label: upgrading ? 'Updating faces (new model)' : 'Scanning faces' });
      for (const t of tasks) {
        if (stopped || paused) break;
        const m = model;
        try {
          const faces = await scanItem(t.id, t.kind, m);
          if (stopped) break;
          await api.facesSave(t.id, faces, m);
          if (faces.length) named = true;
        } catch {
          if (stopped) break;
          // A native failure with a working built-in model left: try that before giving up.
          if (m === 1 && model === 0) continue;
          await api.facesFailed(t.id, m).catch(() => {});
        }
        job.step();
        tell();
        await new Promise((r) => setTimeout(r, m === 1 ? 20 : 60));
      }
      await autoName();
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
