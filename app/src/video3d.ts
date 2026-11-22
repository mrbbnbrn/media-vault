// Prepared 3D for videos and GIFs (docs/video-3d-plan.md): every frame's 3D
// worked out once, in the background, when asked (viewer 3D ▾ menu, a
// video's or folder's right-click menu), then saved in the vault so the video
// plays with 3D smoothly, frame by frame (track3d.ts, Depth3D.tsx).
//
// For each frame, the same models as for pictures, with the settings in use:
// depth (any model), the subject outline (Lift-off, 3D only on the subject),
// sharper depth edges, and Layered 3D's background fill. The worker
// (video3dworker.ts) calms it over time and encodes it; each finished piece is
// saved at once, so a stopped job carries on where it stopped next time.
//
// Videos are decoded by the backend's ffmpeg (video3d.rs), GIFs here.
// One video at a time; the others wait in the queue. Stops on lock.

import { useSyncExternalStore } from 'react';
import { api, mediaUrl, onLocked, type DepthMap, type SubjectMask } from './api';
import { viewerPrefs } from './prefs';
import { beginJob, endJob, updateJob } from './jobs';
import { depthPack, depthSetup, depthTag, lastSpeed, pivotOf, type DepthSetup } from './depth';
import { lastSubjectSpeed, maskStats, subjectDepth, subjectPack, subjectSetup, subjectTag, type SubjectSetup } from './subject';
import { bgDepthNear, edgesStrength } from './layers';
import { inpaintChoice, inpaintPack } from './inpaint';
import { savedChanged } from './derived';
import { packIndex, parseIndex, trackChanged, trackTag, type TrackIndex } from './track3d';
import { COLS, ROWS, roundInfo, smoothInfo, tileSize, type FrameInfo } from './video3dmath';
import { errText } from './text';

// ---- settings -------------------------------------------------------------------------------------

export const VIDEO3D_SIZES = [512, 768, 1024] as const;

/** The video 3D settings read safely. */
export function videoPrefs(p = viewerPrefs()): { size: number; every: number; calm: boolean } {
  const size = (VIDEO3D_SIZES as readonly number[]).includes(p.video3dSize ?? 0) ? p.video3dSize! : 768;
  return { size, every: p.video3dEvery === 2 ? 2 : 1, calm: p.video3dCalm !== false };
}

/** What preparing uses now: the models in use and the video settings, and the tag it's saved under. */
export interface Setup {
  depth: DepthSetup;
  subject: SubjectSetup | null;
  /** The fill model ('' = Simple) and its square size. */
  fill: string;
  fillSide: number;
  edges: number;
  size: number;
  every: number;
  tag: string;
}

/** The setup from the settings and the installed packs (null: no depth pack). */
export async function currentSetup(): Promise<Setup | null> {
  const di = await depthPack();
  const depth = di?.available ? depthSetup() : null;
  if (!depth) return null;
  const si = await subjectPack();
  const subject = si?.available ? subjectSetup() : null;
  const p = viewerPrefs();
  let fill = '';
  let fillSide = 0;
  if (subject) {
    const want = inpaintChoice(p);
    if (want) {
      const info = await inpaintPack(want);
      if (info?.available) {
        fill = info.model ?? want;
        fillSide = info.inputSide && info.inputSide > 0 ? info.inputSide : 512;
      }
    }
  }
  const edges = subject && p.depthEdges3d ? edgesStrength(p.depthEdgesStrength) : 0;
  const { size, every } = videoPrefs(p);
  const tag = trackTag({ depth: depthTag(depth), subject: subject ? subjectTag(subject) : '', edges, fill, size, every });
  return { depth, subject, fill, fillSide, edges, size, every, tag };
}

// ---- estimates ------------------------------------------------------------------------------------

export interface Want3d {
  id: number;
  kind: 'video' | 'gif';
  name: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

/** Rough time (seconds) and size (bytes) to prepare these, from the speed tests when they were run. */
export function estimate3d(items: Want3d[], s: Setup): { seconds: number; bytes: number; frames: number } {
  const big = /large|base/.test(s.depth.model);
  const depthMs = lastSpeed(s.depth.model, s.depth.detail)?.ms ?? (big ? 450 : 120);
  const subjMs = s.subject ? lastSubjectSpeed(s.subject.model)?.ms ?? 180 : 0;
  const fillMs = s.subject ? (s.fill === 'lama' ? 260 : s.fill ? 90 : 40) : 0;
  const perFrame = (depthMs + subjMs + fillMs + 60) / 1000;
  let frames = 0;
  let bytes = 0;
  for (const it of items) {
    const fps = it.kind === 'gif' ? 15 : 30;
    const secs = Math.max(1, (it.durationMs ?? 10_000) / 1000);
    const n = Math.ceil((secs * fps) / s.every);
    frames += n;
    const t = tileSize(it.width || 1920, it.height || 1080, s.size);
    // The encoder's budget (video3dworker.ts): an upper end; still scenes come out smaller.
    bytes += (t.w * COLS * t.h * ROWS * fps * 0.05 * secs) / 8 / s.every;
  }
  return { seconds: frames * perFrame, bytes, frames };
}

// ---- the queue and its state ------------------------------------------------------------------

export interface Prep3dState {
  running: boolean;
  /** The one being prepared now (fraction 0–1). */
  current: { id: number; name: string; fraction: number } | null;
  queue: { id: number; name: string }[];
}

let state: Prep3dState = { running: false, current: null, queue: [] };
const subs = new Set<() => void>();
function set(patch: Partial<Prep3dState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export function prep3dState(): Prep3dState {
  return state;
}

export function usePrep3d(): Prep3dState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}

/** How far this item is (0–1 while preparing, 0 while waiting; null: not in the queue). */
export function prep3dOf(s: Prep3dState, id: number): number | null {
  if (s.current?.id === id) return s.current.fraction;
  return s.queue.some((q) => q.id === id) ? 0 : null;
}

const JOB = 'video3d';
let stopAll = false;
let stopOne: number | null = null;
let queue: Want3d[] = [];
let done = 0;
let failed = 0;
let lastError = '';

/** Prepare these videos and GIFs (added to the queue; ones already waiting are skipped). */
export function prepare3d(items: Want3d[]) {
  for (const it of items) if (!queue.some((q) => q.id === it.id) && state.current?.id !== it.id) queue.push(it);
  set({ queue: queue.map((q) => ({ id: q.id, name: q.name })) });
  if (!state.running) void run();
}

/** Stop everything (the one being prepared keeps what it made so far). */
export function stopPrepare3d() {
  stopAll = true;
  queue = [];
  set({ queue: [] });
}

/** Stop one item (taken out of the queue, or stopped if it's being prepared). */
export function stopPrepare3dOf(id: number) {
  queue = queue.filter((q) => q.id !== id);
  set({ queue: queue.map((q) => ({ id: q.id, name: q.name })) });
  if (state.current?.id === id) stopOne = id;
}

void onLocked(() => stopPrepare3d()).catch(() => {});

async function run() {
  stopAll = false;
  done = 0;
  failed = 0;
  lastError = '';
  set({ running: true });
  beginJob({ id: JOB, label: 'Preparing 3D for videos', long: true, unit: 'videos', total: queue.length, cancel: stopPrepare3d, cancelLabel: 'Stop' });
  try {
    while (queue.length && !stopAll) {
      const it = queue.shift()!;
      set({ current: { id: it.id, name: it.name, fraction: 0 }, queue: queue.map((q) => ({ id: q.id, name: q.name })) });
      updateJob(JOB, { total: done + failed + 1 + queue.length, detail: it.name });
      stopOne = null;
      try {
        const setup = await currentSetup();
        if (!setup) throw new Error("3D needs a depth pack (Settings → AI & 3D).");
        await prepareOne(it, setup, (f) => {
          set({ current: { id: it.id, name: it.name, fraction: f } });
          updateJob(JOB, { fraction: (done + failed + f) / Math.max(1, done + failed + 1 + queue.length) });
        }, () => stopAll || stopOne === it.id);
        if (!stopAll && stopOne !== it.id) done++;
      } catch (e) {
        failed++;
        lastError = `${it.name}: ${errText(e)}`;
        console.warn('Preparing 3D failed:', lastError);
      }
      updateJob(JOB, { done: done + failed });
    }
  } finally {
    const stopped = stopAll;
    set({ running: false, current: null, queue: [] });
    queue = [];
    endJob(JOB, {
      failed: failed > 0 && done === 0,
      summary: stopped ? `3D preparing stopped (${done} done; it carries on where it stopped next time)` : failed ? `3D prepared for ${done}, failed for ${failed} (${lastError})` : `3D prepared for ${done} ${done === 1 ? 'video' : 'videos'}`,
    });
  }
}

// ---- one item ---------------------------------------------------------------------------------------

interface Frame {
  t: number;
  rgba: Uint8ClampedArray;
}

interface Source {
  w: number;
  h: number;
  fps: number;
  duration: number;
  next(): Promise<Frame | null>;
  close(): void;
}

/** A video's size and length as the player sees it (after its rotation). */
function probeVideo(src: string): Promise<{ w: number; h: number; duration: number }> {
  return new Promise((ok, fail) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = () => {
      v.removeAttribute('src');
      v.load();
    };
    const t = setTimeout(() => {
      done();
      fail(new Error("the video didn't open"));
    }, 20_000);
    v.onloadedmetadata = () => {
      clearTimeout(t);
      const r = { w: v.videoWidth, h: v.videoHeight, duration: Number.isFinite(v.duration) ? v.duration : 0 };
      done();
      if (!r.w || !r.h) fail(new Error('the video has no picture'));
      else ok(r);
    };
    v.onerror = () => {
      clearTimeout(t);
      done();
      fail(new Error("the video couldn't be read"));
    };
    v.src = src;
  });
}

async function videoSource(id: number, size: number, start: number): Promise<Source> {
  const meta = await probeVideo(mediaUrl(id));
  const { w, h } = tileSize(meta.w, meta.h, size);
  const open = await api.video3dOpen(id, w, h, start);
  let buf: Frame[] = [];
  let ended = false;
  let fps = 30;
  let lastT = NaN;
  const seen: number[] = [];
  return {
    w,
    h,
    get fps() {
      return fps;
    },
    duration: meta.duration,
    async next() {
      while (!buf.length && !ended) {
        const b = await api.video3dRead(open.id, 8);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const n = dv.getUint32(0, true);
        ended = b[4] === 1;
        const px = w * h * 4;
        for (let i = 0; i < n; i++) {
          let t = dv.getFloat64(8 + i * 8, true);
          if (!Number.isFinite(t)) t = Number.isFinite(lastT) ? lastT + 1 / fps : start;
          if (seen.length < 12) {
            seen.push(t);
            if (seen.length >= 3) fps = Math.min(240, Math.max(1, (seen.length - 1) / Math.max(1e-3, seen[seen.length - 1] - seen[0])));
          }
          lastT = t;
          const o = 8 + n * 8 + i * px;
          buf.push({ t, rgba: new Uint8ClampedArray(b.buffer.slice(b.byteOffset + o, b.byteOffset + o + px)) });
        }
      }
      return buf.shift() ?? null;
    },
    close() {
      buf = [];
      void api.video3dClose(open.id).catch(() => {});
    },
  };
}

interface FrameDecoder {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } | null };
  completed: Promise<void>;
  decode: (o: { frameIndex: number }) => Promise<{ image: VideoFrame }>;
  close: () => void;
}

function animationType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
  return 'image/gif';
}

async function gifSource(src: string, size: number, from: number): Promise<Source> {
  const Dec = (globalThis as unknown as { ImageDecoder?: new (o: { data: Uint8Array; type: string }) => FrameDecoder }).ImageDecoder;
  if (!Dec) throw new Error("GIFs can't be decoded here");
  const r = await fetch(src);
  if (!r.ok) throw new Error("the GIF couldn't be read");
  const bytes = new Uint8Array(await r.arrayBuffer());
  const dec = new Dec({ data: bytes, type: animationType(bytes) });
  await dec.tracks.ready;
  await dec.completed.catch(() => {});
  const count = Math.max(1, dec.tracks.selectedTrack?.frameCount ?? 1);
  const first = await dec.decode({ frameIndex: 0 });
  const { w, h } = tileSize(first.image.displayWidth, first.image.displayHeight, size);
  first.image.close();
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  let i = from;
  return {
    w,
    h,
    fps: 15,
    duration: count,
    async next() {
      if (i >= count) return null;
      const f = await dec.decode({ frameIndex: i });
      try {
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(f.image, 0, 0, w, h);
      } finally {
        f.image.close();
      }
      const t = i++;
      return { t, rgba: ctx.getImageData(0, 0, w, h).data };
    },
    close() {
      dec.close();
    },
  };
}

/** The worker, with replies matched to requests. */
function newWorker() {
  const w = new Worker(new URL('./video3dworker.ts', import.meta.url), { type: 'module' });
  let n = 0;
  const waiting = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  w.onmessage = (e: MessageEvent<Record<string, unknown> & { id: number; error?: string }>) => {
    const j = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (!j) return;
    if (e.data.error) j.fail(new Error(e.data.error));
    else j.ok(e.data);
  };
  w.onerror = (e) => {
    for (const j of waiting.values()) j.fail(new Error(e.message || 'the worker stopped'));
    waiting.clear();
  };
  return {
    ask<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
      const id = ++n;
      return new Promise<T>((ok, fail) => {
        waiting.set(id, { ok: ok as (v: Record<string, unknown>) => void, fail });
        w.postMessage({ ...msg, id }, transfer);
      });
    },
    close: () => w.terminate(),
  };
}

type Piece = { bytes: Uint8Array | ArrayBuffer; t0: number; t1: number; frames: number };

async function prepareOne(it: Want3d, s: Setup, progress: (f: number) => void, stopped: () => boolean) {
  const name = (k: string) => `${s.tag}.${k}`;
  let index = parseIndex(await api.derivedGet(it.id, 'track', name('i')));
  if (index?.complete) return;
  const last = index?.segs[index.segs.length - 1];
  // Carries on after the last saved piece.
  const from = last ? (it.kind === 'gif' ? last.t1 + 1 : last.t1 + 0.0005) : 0;
  const src = it.kind === 'video' ? await videoSource(it.id, s.size, from) : await gifSource(mediaUrl(it.id), s.size, from);
  const worker = newWorker();
  try {
    const { w, h } = src;
    const init = await worker.ask<{ codec: string }>({ op: 'init', w, h, fps: src.fps, plate: !!s.subject, subject: !!s.subject });
    if (!index || index.w !== w || index.h !== h) {
      index = {
        v: 1, tag: s.tag, kind: it.kind, w, h, codec: init.codec, segs: [], every: s.every, complete: false,
        has: { subject: !!s.subject, plate: !!s.subject },
        models: { depth: depthTag(s.depth), subject: s.subject ? subjectTag(s.subject) : '', fill: s.subject ? s.fill || 'simple' : '', edges: s.edges },
        duration: src.duration, made: Date.now(),
      };
    }
    const idx: TrackIndex = index;
    const save = async (p: Piece) => {
      const bytes = p.bytes instanceof Uint8Array ? p.bytes : new Uint8Array(p.bytes);
      const n = idx.segs.length ? idx.segs[idx.segs.length - 1].n + 1 : 0;
      await api.derivedPut(it.id, 'track', name(`s${n}`), bytes);
      idx.segs.push({ n, t0: p.t0, t1: p.t1, frames: p.frames, bytes: bytes.length });
      idx.made = Date.now();
      idx.codec = init.codec;
      await api.derivedPut(it.id, 'track', name('i'), packIndex(idx));
      trackChanged(it.id);
      savedChanged();
    };
    // Canvases for the models' square copies.
    const pic = new OffscreenCanvas(w, h);
    const pctx = pic.getContext('2d', { willReadFrequently: true })!;
    const squares = new Map<number, OffscreenCanvasRenderingContext2D>();
    const square = (side: number): Uint8Array => {
      let c = squares.get(side);
      if (!c) {
        c = new OffscreenCanvas(side, side).getContext('2d', { willReadFrequently: true })!;
        c.imageSmoothingQuality = 'high';
        squares.set(side, c);
      }
      c.drawImage(pic, 0, 0, side, side);
      const d = c.getImageData(0, 0, side, side).data;
      return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    };
    let info: FrameInfo | null = null;
    const total = src.duration > 0 ? (it.kind === 'gif' ? src.duration : src.duration * src.fps) : 0;
    let skip = 0;
    for (;;) {
      if (stopped()) break;
      const f = await src.next();
      if (!f) {
        const p = await worker.ask<{ segment?: Piece }>({ op: 'end' });
        if (p.segment) await save(p.segment);
        if (!idx.segs.length) throw new Error('no frames came out of it');
        idx.complete = true;
        await api.derivedPut(it.id, 'track', name('i'), packIndex(idx));
        trackChanged(it.id);
        progress(1);
        return;
      }
      // Every second frame only, when set so.
      if (s.every === 2 && skip++ % 2 === 1) continue;
      pctx.putImageData(new ImageData(f.rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
      const ds = s.depth;
      const depth: DepthMap = await api.depthEstimate({ width: ds.side, height: ds.side, model: ds.model, detail: ds.detail, soft: ds.soft ?? 1 }, square(ds.side));
      const mask: SubjectMask | null = s.subject ? await api.subjectEstimate({ width: s.subject.side, height: s.subject.side, model: s.subject.model }, square(s.subject.side)) : null;
      const fillPx = s.fill && s.fillSide ? square(s.fillSide) : null;
      const rgba = f.rgba.buffer as ArrayBuffer;
      const calm = await worker.ask<{ depth: DepthMap; mask: SubjectMask | null; hole: Uint8Array | null; cut: boolean; moving: number }>(
        { op: 'calm', t: f.t, rgba, depth, mask, holeSide: fillPx ? s.fillSide : 0 }, [rgba]);
      const now: FrameInfo = {
        p: pivotOf(calm.depth),
        z: calm.mask ? subjectDepth(calm.depth, calm.mask) : null,
        b: calm.mask ? bgDepthNear(calm.depth, calm.mask) : null,
        st: calm.mask ? maskStats(calm.mask) : null,
        mo: calm.moving,
      };
      info = smoothInfo(info, now, calm.cut);
      let fill: { data: ArrayBuffer; w: number; h: number } | null = null;
      if (fillPx && calm.hole && now.st) {
        const out = await api.inpaintEstimate({ width: s.fillSide, height: s.fillSide, model: s.fill }, fillPx, calm.hole);
        const copy = out.data.slice();
        fill = { data: copy.buffer as ArrayBuffer, w: out.w, h: out.h };
      }
      const r = await worker.ask<{ segment?: Piece }>({ op: 'finish', fill, edges: s.edges, info: roundInfo(info) }, fill ? [fill.data] : []);
      if (r.segment) await save(r.segment);
      if (total > 0) progress(Math.min(0.99, (it.kind === 'gif' ? f.t + 1 : f.t * src.fps) / total));
    }
    // Stopped: what was made so far is kept (the next time carries on from there).
    const p = await worker.ask<{ segment?: Piece }>({ op: 'end' });
    if (p.segment) await save(p.segment);
  } finally {
    worker.close();
    src.close();
  }
}

/** Delete an item's prepared 3D made with this tag (to prepare it again). */
export async function forget3d(id: number, tag: string) {
  await api.derivedRemove([id], [['track', tag]]);
  trackChanged(id);
  savedChanged();
}

export { trackChanged };
export type { TrackIndex };
