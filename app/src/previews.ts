// Smooth grid previews.
//
// With few videos on screen the grid plays the originals. When playback
// can't keep up (dropped video frames or a stuttering window), every
// previewing tile switches together to a small preview clip: a strip of 48
// little frames made once per video and kept encrypted with the thumbnails.
// If it still stutters, the clips are shown with fewer frames per second.
// When there are clearly fewer videos on screen again, the originals return.

import { useSyncExternalStore } from 'react';
import { api, jobsApi, mediaUrl } from './api';
import { loopJob } from './jobs';

export const COLS = 8;
export const ROWS = 6;
export const FRAMES = COLS * ROWS;
/** Frames per second of a preview clip at full smoothness. */
export const CLIP_FPS = 8;
const CELL = 240;

// ---- making a clip ------------------------------------------------------------------------

/** When (seconds) each frame is taken: a few short moments spread through the video. */
export function frameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return Array.from({ length: FRAMES }, () => 0);
  const per = FRAMES / 4;
  const step = 1 / CLIP_FPS;
  if (duration >= 4 * per * step * 1.6) {
    const starts = [0.1, 0.33, 0.56, 0.79].map((p) => p * duration);
    return starts.flatMap((s) => Array.from({ length: per }, (_, i) => Math.min(duration - 0.05, s + i * step)));
  }
  // Short videos: frames spread over the whole video.
  return Array.from({ length: FRAMES }, (_, i) => Math.min(duration - 0.05, (i * duration) / FRAMES));
}

const timeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** Make the frame strip of one video, in memory (JPEG bytes). */
export async function makePreviewStrip(id: number): Promise<Uint8Array> {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  try {
    v.src = mediaUrl(id);
    await timeout(
      new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('unsupported'));
      }),
      30_000,
    );
    if (!v.videoWidth) throw new Error('no picture');
    const a = v.videoWidth / v.videoHeight;
    const cw = Math.round(a >= 1 ? CELL : CELL * a);
    const ch = Math.round(a >= 1 ? CELL / a : CELL);
    const c = document.createElement('canvas');
    c.width = cw * COLS;
    c.height = ch * ROWS;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    const times = frameTimes(v.duration);
    for (let i = 0; i < FRAMES; i++) {
      const t = times[i];
      if (Math.abs(v.currentTime - t) > 0.01) {
        await timeout(
          new Promise<void>((res) => {
            v.onseeked = () => res();
            v.currentTime = t;
          }),
          10_000,
        );
      }
      g.drawImage(v, (i % COLS) * cw, Math.floor(i / COLS) * ch, cw, ch);
    }
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.72));
    if (!blob) throw new Error('could not encode');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

// ---- background maker -----------------------------------------------------------------------

let running = false;
let stopFn: (() => void) | null = null;
let wake: (() => void) | null = null;
let prefer: number[] = [];
const madeListeners = new Set<(id: number) => void>();

/** Videos on screen that need a clip now (made first). */
export function preferPreviews(ids: number[]) {
  const fresh = ids.some((id) => !prefer.includes(id));
  prefer = ids.slice(0, 64);
  if (fresh) wake?.();
}

export function onPreviewMade(cb: (id: number) => void): () => void {
  madeListeners.add(cb);
  return () => madeListeners.delete(cb);
}

export function kickPreviews() {
  wake?.();
}

/** Makes preview clips one at a time in the background. Stops on lock. */
export function startPreviewMaker(): () => void {
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
  const job = loopJob('previews', { label: 'Making preview clips', unit: '', left: () => jobsApi.backgroundLeft().then((l) => l.previews) });
  (async () => {
    while (!stopped) {
      let tasks: { id: number }[] = [];
      try {
        tasks = await api.previewsNeeded(4, prefer);
      } catch {
        break; // locked
      }
      if (!tasks.length) {
        job.idle();
        await sleep(15_000);
        continue;
      }
      job.batch();
      for (const t of tasks) {
        if (stopped) break;
        try {
          const bytes = await makePreviewStrip(t.id);
          if (stopped) break;
          await api.savePreview(t.id, Array.from(bytes));
          madeListeners.forEach((l) => l(t.id));
        } catch {
          if (stopped) break;
          await api.previewFailed(t.id).catch(() => {});
        }
        job.step();
        // A short rest so the window stays smooth.
        await new Promise((r) => setTimeout(r, 150));
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

// ---- watching for lag ---------------------------------------------------------------------------

export interface PreviewMode {
  /** Every previewing tile shows its preview clip instead of the original. */
  clips: boolean;
  /** Frames per second for the clips (8, 4 or 2). */
  fps: number;
}

let mode: PreviewMode = { clips: false, fps: CLIP_FPS };
const subs = new Set<() => void>();
const setMode = (m: PreviewMode) => {
  if (m.clips === mode.clips && m.fps === mode.fps) return;
  mode = m;
  subs.forEach((s) => s());
};

export function usePreviewMode(): PreviewMode {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      startMonitor();
      return () => subs.delete(cb);
    },
    () => mode,
  );
}

const videos = new Set<HTMLVideoElement>();
const lastQuality = new WeakMap<HTMLVideoElement, { total: number; dropped: number }>();
let wanted = 0;
/** How many videos were playing when it started to lag. */
let threshold = Infinity;

/** The grid says how many tiles want to play a video right now. */
export function setWantedVideos(n: number) {
  wanted = n;
  if (mode.clips && n <= Math.max(2, Math.floor(threshold * 0.6))) {
    setMode({ clips: false, fps: CLIP_FPS });
  }
}

/** Ref callback for grid videos: they are watched for dropped frames. */
export function watchVideo(v: HTMLVideoElement | null) {
  if (v) videos.add(v);
}
export function unwatchVideo(v: HTMLVideoElement) {
  videos.delete(v);
}

let monitoring = false;
function startMonitor() {
  if (monitoring) return;
  monitoring = true;
  let last = performance.now();
  let frames = 0;
  let slow = 0;
  let sum = 0;
  let windowStart = last;
  let lagStreak = 0;
  let calm = 0;
  const loop = (now: number) => {
    const dt = now - last;
    last = now;
    if (dt < 1000 && document.visibilityState === 'visible') {
      frames++;
      sum += dt;
      if (dt > 50) slow++;
    }
    if (now - windowStart >= 2000) {
      evaluate(frames ? slow / frames : 0, frames ? sum / frames : 16);
      frames = 0;
      slow = 0;
      sum = 0;
      windowStart = now;
    }
    requestAnimationFrame(loop);
  };
  const evaluate = (slowShare: number, avg: number) => {
    if (wanted === 0) {
      lagStreak = 0;
      return;
    }
    const jank = slowShare > 0.15 || avg > 34;
    if (!mode.clips) {
      // Dropped video frames since the last look, over all grid videos.
      let total = 0;
      let dropped = 0;
      for (const v of videos) {
        if (!v.isConnected) {
          videos.delete(v);
          continue;
        }
        const q = v.getVideoPlaybackQuality?.();
        if (!q) continue;
        const prev = lastQuality.get(v) ?? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames };
        total += Math.max(0, q.totalVideoFrames - prev.total);
        dropped += Math.max(0, q.droppedVideoFrames - prev.dropped);
        lastQuality.set(v, { total: q.totalVideoFrames, dropped: q.droppedVideoFrames });
      }
      const droppy = total > 30 && dropped / total > 0.12;
      lagStreak = wanted >= 3 && (droppy || jank) ? lagStreak + 1 : 0;
      if (lagStreak >= 2) {
        lagStreak = 0;
        calm = 0;
        threshold = wanted;
        setMode({ clips: true, fps: CLIP_FPS });
      }
      return;
    }
    // Already on clips: fewer frames if it still stutters, more after a long calm.
    if (jank) {
      lagStreak++;
      calm = 0;
      if (lagStreak >= 2 && mode.fps > 2) {
        lagStreak = 0;
        setMode({ clips: true, fps: mode.fps / 2 });
      }
    } else {
      lagStreak = 0;
      calm++;
      if (calm >= 15 && mode.fps < CLIP_FPS) {
        calm = 0;
        setMode({ clips: true, fps: mode.fps * 2 });
      }
    }
  };
  requestAnimationFrame(loop);
}

// ---- playing clips ----------------------------------------------------------------------------

const clipEls = new Set<HTMLElement>();
let ticker: ReturnType<typeof setInterval> | null = null;
let tickerFps = 0;

function frameAt(fps: number): number {
  const step = CLIP_FPS / fps;
  return (Math.floor(performance.now() / (1000 / fps)) * step) % FRAMES;
}

export function framePosition(i: number): string {
  const c = i % COLS;
  const r = Math.floor(i / COLS);
  return `${(c * 100) / (COLS - 1)}% ${(r * 100) / (ROWS - 1)}%`;
}

function ensureTicker() {
  const fps = mode.fps;
  if (ticker && tickerFps === fps) return;
  if (ticker) clearInterval(ticker);
  tickerFps = fps;
  ticker = setInterval(() => {
    if (!clipEls.size) {
      clearInterval(ticker!);
      ticker = null;
      return;
    }
    const pos = framePosition(frameAt(tickerFps));
    for (const el of clipEls) {
      if (el.isConnected) el.style.backgroundPosition = pos;
      else clipEls.delete(el);
    }
  }, 1000 / fps);
}

/** Ref callback for a clip element: one shared timer moves every clip on screen. */
export function playClip(el: HTMLElement | null) {
  if (!el) return;
  clipEls.add(el);
  el.style.backgroundPosition = framePosition(frameAt(mode.fps));
  ensureTicker();
}
export function stopClip(el: HTMLElement) {
  clipEls.delete(el);
}
/** The frame rate changed: restart the timer. */
export function clipFpsChanged() {
  if (clipEls.size) ensureTicker();
}
