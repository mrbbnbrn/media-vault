// Video previews in the grid.
//
// Every video gets two small things, made once in the background and kept
// encrypted with the thumbnails:
//  - a frame strip: 48 little frames in one picture (WebP; older ones JPEG) (flip-books, seek-bar
//    previews, smart search), and
//  - a tiny clip: a few seconds of small silent video, made of short pieces
//    spread through the video (tinyclip.ts in the window, or the video tool).
// A tile shows, as each becomes ready: thumbnail → flip-book → tiny clip →
// the real video (when the PC keeps up; previewplan.ts decides). Hover always
// plays the real video.

import { useSyncExternalStore } from 'react';
import { api, jobsApi, mediaUrl } from './api';
import { loopJob } from './jobs';
import { makeVideoPreviews } from './tinyclip';
import { previewsPaused, onPreviewsPaused, whenPreviewsMayRun } from './previewgate';
import { giveWay } from './bgpace';

export const COLS = 8;
export const ROWS = 6;
export const FRAMES = COLS * ROWS;
/** Frames per second of a flip-book. */
export const CLIP_FPS = 8;

// ---- what is taken from where ----------------------------------------------------------------

/** When (seconds) each strip frame is taken: a few short moments spread through the video. */
export function frameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return Array.from({ length: FRAMES }, () => 0);
  const per = FRAMES / 4;
  const step = 1 / CLIP_FPS;
  if (duration >= 4 * per * step * 1.6) {
    const starts = PIECE_AT.map((p) => p * duration);
    return starts.flatMap((s) => Array.from({ length: per }, (_, i) => Math.min(duration - 0.05, s + i * step)));
  }
  // Short videos: frames spread over the whole video.
  return Array.from({ length: FRAMES }, (_, i) => Math.min(duration - 0.05, (i * duration) / FRAMES));
}

/** Where the pieces start, as parts of the video's length (the same moments as the strip). */
const PIECE_AT = [0.1, 0.33, 0.56, 0.79];
/** Length of one piece of a tiny clip (s): the strip's 12 frames at 8 a second. */
export const TINY_PIECE = (FRAMES / 4) / CLIP_FPS;
/** Longest tiny clip of a short video (s). */
export const TINY_MAX = 6;

/** The pieces a tiny clip is made of: four 1.5 s pieces of a long video, or its start. */
export function tinyPieces(duration: number): { starts: number[]; piece: number } {
  if (!Number.isFinite(duration) || duration <= 0) return { starts: [0], piece: 1 };
  if (duration >= 4 * TINY_PIECE * 1.6) return { starts: PIECE_AT.map((p) => Math.round(p * duration * 1000) / 1000), piece: TINY_PIECE };
  return { starts: [0], piece: Math.max(0.2, Math.min(TINY_MAX, duration - 0.05)) };
}

/** Where in the real video a moment of the tiny clip comes from (to carry on from there). */
export function tinyToSource(tinyTime: number, duration: number): number {
  const { starts, piece } = tinyPieces(duration);
  const total = starts.length * piece;
  const t = ((tinyTime % total) + total) % total;
  const k = Math.min(starts.length - 1, Math.floor(t / piece));
  return Math.min(Math.max(0, duration - 0.1), starts[k] + (t - k * piece));
}

/** Size of a tiny clip: 426 on the long side, even numbers, never bigger than the video. */
export function tinySize(w: number, h: number): { w: number; h: number } {
  const long = Math.min(426, Math.max(w, h));
  const s = long / Math.max(w, h, 1);
  const even = (x: number) => Math.max(2, Math.round((x * s) / 2) * 2);
  return { w: even(w), h: even(h) };
}

// ---- background maker -----------------------------------------------------------------------

let running = false;
let stopFn: (() => void) | null = null;
let wake: (() => void) | null = null;
let prefer: number[] = [];
export type PreviewKind = 'strip' | 'tiny';
const madeListeners = new Set<(id: number, kind: PreviewKind) => void>();

/** Videos on screen that need a strip or tiny clip now (made first). */
export function preferPreviews(ids: number[]) {
  const fresh = ids.some((id) => !prefer.includes(id));
  prefer = ids.slice(0, 64);
  if (fresh) wake?.();
}

export function onPreviewMade(cb: (id: number, kind: PreviewKind) => void): () => void {
  madeListeners.add(cb);
  return () => madeListeners.delete(cb);
}

export function kickPreviews() {
  wake?.();
}

/** Make the frame strip of one video, in memory (WebP bytes, or JPEG where WebP can't be made). */
export async function makePreviewStrip(id: number): Promise<Uint8Array> {
  const m = await makeVideoPreviews(mediaUrl(id), { strip: true, tiny: false });
  return m.strip!;
}

/** The last few makes, for the measurements (Settings → About → self-test, dev tools). */
export const makerLog: { id: number; ms: number; how: string }[] = [];

let noTool = false;

/** Make what one video is missing. */
async function makeFor(t: { id: number; durationMs: number | null; needStrip: boolean; needTiny: boolean }, stopped: () => boolean) {
  const t0 = performance.now();
  let needTiny = t.needTiny;
  let how = '';
  // The video tool makes tiny clips outside the window (and in H.264) when it is installed.
  if (needTiny && !noTool && t.durationMs) {
    const plan = tinyPieces(t.durationMs / 1000);
    try {
      if (await api.makeTinyWithTool(t.id, plan.starts, plan.piece)) {
        needTiny = false;
        how = 'tool';
        madeListeners.forEach((l) => l(t.id, 'tiny'));
      } else noTool = true;
    } catch {
      // The window tries instead.
    }
  }
  if (stopped() || (!t.needStrip && !needTiny)) return how;
  let made;
  try {
    made = await makeVideoPreviews(mediaUrl(t.id), { strip: t.needStrip, tiny: needTiny });
  } catch {
    if (stopped()) return how;
    if (t.needStrip) await api.previewFailed(t.id).catch(() => {});
    if (needTiny) await api.tinyFailed(t.id).catch(() => {});
    return how + ' failed';
  }
  if (stopped()) return how;
  if (made.strip) {
    await api.savePreview(t.id, made.strip);
    madeListeners.forEach((l) => l(t.id, 'strip'));
  }
  if (needTiny) {
    if (made.tiny) {
      await api.saveTiny(t.id, made.tiny);
      madeListeners.forEach((l) => l(t.id, 'tiny'));
    } else {
      // No video encoder here: the flip-book stands in.
      await api.tinyFailed(t.id).catch(() => {});
    }
  }
  return `${how ? how + '+' : ''}window ${Math.round(performance.now() - t0)} ms`;
}

/** Makes strips and tiny clips one video at a time in the background. Stops on lock. */
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
      let tasks: { id: number; durationMs: number | null; needStrip: boolean; needTiny: boolean }[] = [];
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
        // Not while the window is minimised or hidden (nothing would be drawn).
        await whenPreviewsMayRun(() => stopped);
        // Nor while you are using it (bgpace.ts).
        await giveWay(() => stopped);
        if (stopped) break;
        const t0 = performance.now();
        try {
          const how = await makeFor(t, () => stopped);
          makerLog.push({ id: t.id, ms: Math.round(performance.now() - t0), how });
          if (makerLog.length > 50) makerLog.shift();
        } catch {
          // Saving failed (locked?): the next round tries again.
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

// ---- flip-books (frame strips played by one shared timer) ------------------------------------

const clipEls = new Set<HTMLElement>();
let ticker: ReturnType<typeof setInterval> | null = null;

function frameAt(): number {
  return Math.floor(performance.now() / (1000 / CLIP_FPS)) % FRAMES;
}

export function framePosition(i: number): string {
  const c = i % COLS;
  const r = Math.floor(i / COLS);
  return `${(c * 100) / (COLS - 1)}% ${(r * 100) / (ROWS - 1)}%`;
}

function ensureTicker() {
  if (ticker || previewsPaused()) return;
  ticker = setInterval(() => {
    if (!clipEls.size || previewsPaused()) {
      clearInterval(ticker!);
      ticker = null;
      return;
    }
    const pos = framePosition(frameAt());
    for (const el of clipEls) {
      if (el.isConnected) el.style.backgroundPosition = pos;
      else clipEls.delete(el);
    }
  }, 1000 / CLIP_FPS);
}
onPreviewsPaused((paused) => {
  if (!paused && clipEls.size) ensureTicker();
});

/** Ref callback for a flip-book element: one shared timer moves every flip-book on screen. */
export function playClip(el: HTMLElement | null) {
  if (!el) return;
  clipEls.add(el);
  el.style.backgroundPosition = framePosition(frameAt());
  ensureTicker();
}
export function stopClip(el: HTMLElement) {
  clipEls.delete(el);
}

// ---- which stand-ins exist (also those made while browsing) ----------------------------------

let madeNow = new Map<number, Set<PreviewKind>>();
const madeSubs = new Set<() => void>();
onPreviewMade((id, kind) => {
  const next = new Map(madeNow);
  next.set(id, new Set([...(next.get(id) ?? []), kind]));
  madeNow = next;
  madeSubs.forEach((s) => s());
});

/** Strips and tiny clips made since the lists were loaded. */
export function useMadePreviews(): Map<number, Set<PreviewKind>> {
  return useSyncExternalStore(
    (cb) => {
      madeSubs.add(cb);
      return () => madeSubs.delete(cb);
    },
    () => madeNow,
  );
}
