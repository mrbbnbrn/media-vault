// Border fill for 3D photos (still pictures only): made once per picture (the
// maths in lookworker.ts, the fill models' calls here), kept in memory for a
// few pictures (dropped on lock), and for pictures in the vault saved there
// (encrypted, packed like Layered 3D's plate: layerpack.ts, `derived` kind
// 'plate' with its own tag), so a picture seen once shows it at once next
// time. docs/picture-3d-looks-plan.md (More layers was removed 2026-11-27).

import { api, onLocked, type DepthMap } from './api';
import { savedChanged } from './derived';
import { inpaintPack } from './inpaint';
import { borderPx } from './depthlook';
import { pixelsOffThread } from './picturecache';

/** The border plate's picture part at most this long (the fill is soft anyway; inside, the picture itself is drawn). */
const BORDER_MAX = 1600;

export type LookJob =
  | { op: 'borderInput'; orig: Uint8ClampedArray; w: number; h: number; b: number; side: number }
  | { op: 'border'; orig: Uint8ClampedArray; w: number; h: number; b: number; depth: DepthMap; fill: { data: Uint8ClampedArray; w: number; h: number } | null }
  | { op: 'borderPack'; orig: Uint8ClampedArray; w: number; h: number; b: number; layer: Uint8Array }
  | { op: 'borderUnpack'; orig: Uint8ClampedArray; w: number; h: number; b: number; bytes: Uint8Array };

let worker: Worker | null | undefined;
let jobId = 0;
const jobs = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
function lookWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./lookworker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; out?: unknown; error?: string }>) => {
      const j = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (!j) return;
      if (e.data.error != null) j.fail(new Error(e.data.error));
      else j.ok(e.data.out);
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

/** A job in the worker (copies go there), else here. */
async function run<T>(j: LookJob): Promise<T> {
  const w = lookWorker();
  if (w) {
    const id = ++jobId;
    try {
      return (await new Promise<unknown>((ok, fail) => {
        jobs.set(id, { ok, fail });
        w.postMessage({ ...j, id });
      })) as T;
    } catch {
      // Here instead.
    }
  }
  const { runLook } = await import('./lookworker');
  return (await runLook(j)) as T;
}

function keep<T>(m: Map<string, T>, key: string, v: T, max: number) {
  m.delete(key);
  m.set(key, v);
  while (m.size > max) m.delete(m.keys().next().value as string);
}

const borders = new Map<string, Promise<Border | null>>();
const pixelsKept = new Map<string, Promise<{ data: Uint8ClampedArray; w: number; h: number } | null>>();
void onLocked(() => {
  borders.clear();
  pixelsKept.clear();
}).catch(() => {});

/** The saved ones were cleared (prepare again): the copies in memory go too. */
export function forgetLooks() {
  borders.clear();
}

function picturePixels(src: string, w: number, h: number) {
  const key = `${src}|${w}x${h}`;
  const known = pixelsKept.get(key);
  if (known) return known;
  const p = pixelsOffThread(src, w, h);
  keep(pixelsKept, key, p, 2);
  return p;
}

function fitIn(w: number, h: number, max: number) {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** A fill model's result for a square input (null: Simple, or the model isn't there / failed). */
async function modelFill(model: string, input: () => Promise<{ rgba: Uint8Array; hole: Uint8Array } | null>): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> {
  if (!model) return null;
  try {
    const info = await inpaintPack(model);
    if (!info?.available) return null;
    const got = await input();
    if (!got) return null;
    const s = Math.round(Math.sqrt(got.hole.length));
    const out = await api.inpaintEstimate({ width: s, height: s, model: info.model ?? model }, got.rgba, got.hole);
    return { data: new Uint8ClampedArray(out.data), w: out.w, h: out.h };
  } catch {
    return null;
  }
}

/** The fill model is there (or Simple is wanted): what's made is what its tag says, so it may be saved. */
async function fillThere(model: string): Promise<boolean> {
  return !model || !!(await inpaintPack(model).catch(() => null))?.available;
}

async function modelSide(model: string): Promise<number> {
  const info = model ? await inpaintPack(model).catch(() => null) : null;
  return info?.inputSide && info.inputSide > 0 ? info.inputSide : 512;
}

// ---- Border fill ---------------------------------------------------------------------------------

/** The border plate: RGBA `W` × `H` (the picture `w` × `h` in the middle, `b` pixels each way), alpha = depth. */
export interface Border {
  w: number;
  h: number;
  b: number;
  W: number;
  H: number;
  data: Uint8Array;
}

export interface BorderRequest {
  src: string;
  natural: { w: number; h: number };
  /** Share of the short side (Settings: Border size). */
  size: number;
  depth: DepthMap;
  /** '' = Simple. */
  model: string;
  /** `wait`: saved before it is given (preparing). */
  save?: { id: number; tag: string; wait?: boolean };
}

/** The border tag (its depth model's tag, size, fill). */
export function borderTag(depthTag: string, size: number, fill: string): string {
  return `${depthTag}_b${Math.round(size * 100)}_${fill || 'simple'}`;
}

export function borderFor(key: string, r: BorderRequest): Promise<Border | null> {
  const known = borders.get(key);
  if (known) {
    keep(borders, key, known, 3);
    return known;
  }
  const p = makeOrLoadBorder(r).catch(() => null);
  keep(borders, key, p, 3);
  void p.then((x) => {
    if (!x && borders.get(key) === p) borders.delete(key);
  });
  return p;
}

async function makeOrLoadBorder(r: BorderRequest): Promise<Border | null> {
  const { w, h } = fitIn(r.natural.w, r.natural.h, BORDER_MAX);
  const b = borderPx(w, h, r.size);
  const pic = await picturePixels(r.src, w, h);
  if (!pic || pic.w !== w || pic.h !== h) return null;
  const W = w + 2 * b;
  const H = h + 2 * b;
  if (r.save) {
    try {
      const bytes = await api.derivedGet(r.save.id, 'plate', r.save.tag);
      if (bytes) {
        const data = await run<Uint8Array>({ op: 'borderUnpack', orig: pic.data, w, h, b, bytes });
        if (data.length === W * H * 4) return { w, h, b, W, H, data };
      }
    } catch {
      // made again
    }
  }
  const side = await modelSide(r.model);
  const fill = await modelFill(r.model, () => run({ op: 'borderInput', orig: pic.data, w, h, b, side }));
  const data = await run<Uint8Array>({ op: 'border', orig: pic.data, w, h, b, depth: r.depth, fill });
  const made = { w, h, b, W, H, data };
  if (r.save && (await fillThere(r.model))) {
    const save = r.save;
    const saving = (async () => {
      try {
        const bytes = await run<Uint8Array>({ op: 'borderPack', orig: pic.data, w, h, b, layer: data });
        await api.derivedPut(save.id, 'plate', save.tag, bytes);
        savedChanged();
      } catch (e) {
        console.warn("Couldn't save the border fill:", e);
      }
    })();
    if (save.wait) await saving;
  }
  return made;
}
