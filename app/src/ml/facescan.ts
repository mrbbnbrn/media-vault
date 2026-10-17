// Face recognition, the window side. Faces are found by InsightFace
// buffalo_l, run natively by the app (faceid.rs), and only with the faces
// pack (tools\faces). Pictures the app reads itself (JPEG, PNG, WebP, GIF)
// are scanned by its analysis pass (analyse.rs); this loop scans the rest:
// videos (a few frames each) and pictures only the window can decode. They
// are decoded here in memory (nothing decrypted is written anywhere) and the
// pixels are sent to the app.

import { api, mediaUrl, type FaceEngineStatus, type FaceIn, type Kind } from '../api';
import { loopJob, updateJob } from '../jobs';
import { giveWay } from '../bgpace';

/** Where to get the faces pack (shown when it isn't installed). */
export const NO_FACE_PACK =
  'Face recognition needs the faces download: on the Releases page, open the newest “faces-…” release, get MediaVault-faces-windows.zip and unzip it next to the app (it adds MediaVault\\tools\\faces).';

/** Pictures are sent to the native model at most this big (it finds faces at 640, and lines them up from these pixels). */
const NATIVE_SIDE = 1600;
let available = false;
let nativeDevice: string | null = null;
let nativeFailures = 0;

/** "native-gpu" or "native-cpu" once the faces pack is there, else "". */
export const faceBackend = () => (available ? (nativeDevice === 'gpu' ? 'native-gpu' : 'native-cpu') : '');
/** The faces pack is there and working. */
export const facesReady = () => available;

/** Ask the app whether the faces pack is there. */
export async function checkFaceEngine(): Promise<FaceEngineStatus | null> {
  try {
    const e = await api.facesEngine();
    available = e.native.available && nativeFailures < 3;
    nativeDevice = e.native.device;
    return e;
  } catch {
    return null;
  }
}

async function detect(src: CanvasImageSource, w: number, h: number, frameMs = 0): Promise<FaceIn[]> {
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
    // The model itself failing again and again: stop scanning until the app restarts.
    if (++nativeFailures >= 3) available = false;
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
        const same = kept.findIndex((k) => cosine(k.descriptor, face.descriptor) > 0.5);
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

/** Faces in one item (needs the faces pack). */
export function scanItem(id: number, kind: Kind): Promise<FaceIn[]> {
  return kind === 'video' ? scanVideo(id) : scanImage(id);
}

// ---- background scanner ------------------------------------------------------------------

let running = false;
let stopFn: (() => void) | null = null;
let wake: (() => void) | null = null;
let paused = false;
const listeners = new Set<() => void>();
const pauseListeners = new Set<(p: boolean) => void>();

export function onFaceProgress(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Faces were stored (also by the app's own analysis pass): pages showing them refresh. */
export function noteFaceProgress() {
  listeners.forEach((l) => l());
}

export function kickFaceScanner() {
  wake?.();
  api.analyseKick().catch(() => {});
}

export function setFaceScanPaused(p: boolean) {
  paused = p;
  pauseListeners.forEach((l) => l(p));
  if (!p) kickFaceScanner();
}

/** The native analysis pass follows the pause too. */
export function onFaceScanPaused(cb: (p: boolean) => void): () => void {
  pauseListeners.add(cb);
  return () => pauseListeners.delete(cb);
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
    if ((!force && Date.now() - lastAuto < 20_000) || (!force && !named)) return;
    lastAuto = Date.now();
    named = false;
    await api.facesAuto().catch(() => 0);
  };
  const job = loopJob('faces', {
    label: 'Scanning faces',
    long: true,
    left: () => api.facesNeeded(1000).then((t) => t.length),
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
        if (!available) {
          // No faces pack: nothing is scanned (People says where to get it).
          job.idle();
          await sleep(30_000);
          continue;
        }
        // The faces pack just arrived: everything found by the old built-in model is scanned again, once.
        if (engine && !upgraded) {
          upgraded = true;
          await api.facesUpgrade().catch(() => 0);
        }
        upgrading = (engine?.upgradeLeft ?? 0) > 0;
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
        await giveWay(() => stopped || paused);
        if (stopped || paused || !available) break;
        try {
          const faces = await scanItem(t.id, t.kind);
          if (stopped) break;
          await api.facesSave(t.id, faces);
          if (faces.length) named = true;
        } catch {
          if (stopped) break;
          // The model itself stopped working: leave the item queued.
          if (!available) break;
          await api.facesFailed(t.id).catch(() => {});
        }
        job.step();
        tell();
        await new Promise((r) => setTimeout(r, 20));
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
