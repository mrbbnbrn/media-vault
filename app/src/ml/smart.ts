// Smart search: find pictures by describing them ("beach at sunset",
// "kırmızı araba"). Fully offline. Needs the model files of the full package
// (a `models` folder next to MediaVault.exe).

import { api, modelUrl, thumbUrl } from '../api';
import { FILES, SIZE, coverRect, toPixelValues } from './clipcore';

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { res: (v: Float32Array) => void; rej: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./clipworker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; vec?: Float32Array; error?: string; ok?: boolean }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.error) w.rej(new Error(e.data.error));
    else w.res(e.data.vec ?? new Float32Array());
  };
  ask({ type: 'base', url: modelUrl('') });
  return worker;
}

function ask(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<Float32Array> {
  const id = ++seq;
  return new Promise((res, rej) => {
    waiting.set(id, { res, rej });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

let available: Promise<boolean> | null = null;
/** Are the model files there? (Only the full package has them.) */
export function smartAvailable(): Promise<boolean> {
  available ??= fetch(modelUrl(FILES.tokenizerConfig))
    .then((r) => r.ok)
    .catch(() => false);
  return available;
}

/** Words -> meaning vector. */
export function embedQuery(q: string): Promise<Float32Array> {
  return ask({ type: 'text', q });
}

/** A picture (any drawable) -> CLIP's input. */
export function pixelsOf(src: CanvasImageSource, w: number, h: number): Float32Array {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  const r = coverRect(w, h);
  g.drawImage(src, r.x, r.y, r.w, r.h);
  return toPixelValues(g.getImageData(0, 0, SIZE, SIZE).data, 4);
}

export function embedPixels(px: Float32Array): Promise<Float32Array> {
  return ask({ type: 'image', px }, [px.buffer]);
}

async function embedItem(id: number): Promise<Float32Array> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = thumbUrl(id);
  await img.decode();
  const px = pixelsOf(img, img.naturalWidth, img.naturalHeight);
  img.src = '';
  return embedPixels(px);
}

let running = false;
let stop: (() => void) | null = null;
let wake: (() => void) | null = null;
const listeners = new Set<() => void>();

export function onClipProgress(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function kickClipIndexer() {
  wake?.();
}

/** Background loop: analyse pictures that haven't been yet. Stops on lock. */
export function startClipIndexer(): () => void {
  if (running) return stop ?? (() => {});
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
    if (!(await smartAvailable())) {
      running = false;
      return;
    }
    let notified = 0;
    while (!stopped) {
      let tasks: { id: number }[] = [];
      try {
        tasks = await api.clipNeeded(16);
      } catch {
        break; // locked
      }
      if (!tasks.length) {
        await sleep(6000);
        continue;
      }
      for (const t of tasks) {
        if (stopped) break;
        try {
          const v = await embedItem(t.id);
          if (stopped) break;
          await api.clipSave(t.id, Array.from(v));
        } catch (e) {
          if (stopped) break;
          if (String(e).includes('missing')) {
            stopped = true;
            break;
          }
          await api.clipFailed(t.id).catch(() => {});
        }
        if (Date.now() - notified > 1000) {
          notified = Date.now();
          listeners.forEach((l) => l());
        }
      }
    }
    listeners.forEach((l) => l());
    running = false;
  })();
  stop = () => {
    stopped = true;
    running = false;
    wake?.();
  };
  return stop;
}
