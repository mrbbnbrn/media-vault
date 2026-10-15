// Making a video's preview pictures in one pass, in memory (nothing decrypted
// ever reaches the disk):
//  - the frame strip (48 small frames in one JPEG: flip-books, seek-bar
//    previews, smart search), and
//  - the tiny clip (a few seconds of small silent video that grid tiles play
//    straight away), encoded with WebCodecs and written as WebM (webm.ts).
//
// The video is seeked once per piece and then played (muted, at double speed)
// while frames are picked up as they are shown — far quicker than seeking to
// each of the 48 strip frames, which made the decoder start again from the
// keyframe before every single one.

import { COLS, ROWS, FRAMES, frameTimes, tinyPieces, tinySize } from './previews';
import { writeWebm, type WebmFrame } from './webm';

const CELL = 240;
export const TINY_FPS = 24;
const TINY_BITRATE = 350_000;
/** How fast the pieces are played while their frames are picked up. */
const PLAY_RATE = 2;

const timeout = <T,>(p: Promise<T>, ms: number, what = 'timeout') =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);

export interface Made {
  strip?: Uint8Array;
  /** null = this window can't encode video (no WebCodecs encoder for VP9/VP8). */
  tiny?: Uint8Array | null;
  /** How long it took (ms), for the measurements in the notes. */
  ms: number;
}

let codecChoice: Promise<{ codec: string; webm: 'V_VP9' | 'V_VP8' } | null> | null = null;

/** The video encoder this window has: VP9, else VP8 (both play everywhere in Chromium). */
export function tinyEncoder(): Promise<{ codec: string; webm: 'V_VP9' | 'V_VP8' } | null> {
  if (!codecChoice) {
    codecChoice = (async () => {
      if (typeof VideoEncoder === 'undefined') return null;
      for (const [codec, webm] of [['vp09.00.21.08', 'V_VP9'], ['vp8', 'V_VP8']] as const) {
        try {
          const s = await VideoEncoder.isConfigSupported({ codec, width: 426, height: 240, bitrate: TINY_BITRATE, framerate: TINY_FPS });
          if (s.supported) return { codec, webm };
        } catch {
          // try the next one
        }
      }
      return null;
    })();
  }
  return codecChoice;
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return timeout(
    new Promise<void>((res, rej) => {
      v.onseeked = () => res();
      v.onerror = () => rej(new Error('unreadable'));
      v.currentTime = t;
    }),
    15_000,
  );
}

/** Wait until the window is shown again (pictures aren't drawn while it is hidden). */
function whenVisible(): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return Promise.resolve();
  return new Promise((res) => {
    const on = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', on);
        res();
      }
    };
    document.addEventListener('visibilitychange', on);
  });
}

/**
 * Plays `v` from where it is until `end` (seconds), calling `frame` with the
 * time of each frame as it is shown. Resolves at `end`, at the video's end,
 * or after a generous timeout.
 */
function playThrough(v: HTMLVideoElement, end: number, frame: (t: number) => void): Promise<void> {
  return new Promise<void>((res) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      v.pause();
      res();
    };
    const guard = setTimeout(finish, ((end - v.currentTime) / PLAY_RATE) * 1000 * 3 + 4000);
    v.onended = finish;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const cb = (_now: number, m: VideoFrameCallbackMetadata) => {
        if (done) return;
        frame(m.mediaTime);
        if (m.mediaTime >= end - 0.001) finish();
        else v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    } else {
      const tick = () => {
        if (done) return;
        frame(v.currentTime);
        if (v.currentTime >= end - 0.001) finish();
        else setTimeout(tick, 1000 / (TINY_FPS * PLAY_RATE * 2));
      };
      setTimeout(tick, 0);
    }
    v.playbackRate = PLAY_RATE;
    v.play().catch(finish);
  });
}

/** Make what `want` asks for from one video. Throws when the video can't be read. */
export async function makeVideoPreviews(src: string, want: { strip: boolean; tiny: boolean }): Promise<Made> {
  const started = performance.now();
  const enc = want.tiny ? await tinyEncoder() : null;
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  let encoder: VideoEncoder | null = null;
  try {
    v.src = src;
    await timeout(
      new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('unsupported'));
      }),
      30_000,
    );
    if (!v.videoWidth) throw new Error('no picture');
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;

    // The strip.
    const a = v.videoWidth / v.videoHeight;
    const cw = Math.round(a >= 1 ? CELL : CELL * a);
    const ch = Math.round(a >= 1 ? CELL / a : CELL);
    const strip = want.strip ? document.createElement('canvas') : null;
    const sg = strip?.getContext('2d') ?? null;
    if (strip && sg) {
      strip.width = cw * COLS;
      strip.height = ch * ROWS;
      sg.imageSmoothingQuality = 'high';
    }
    const stripTimes = want.strip ? frameTimes(dur) : [];
    const filled = new Array<boolean>(FRAMES).fill(false);
    const cell = (i: number) => {
      sg!.drawImage(v, (i % COLS) * cw, Math.floor(i / COLS) * ch, cw, ch);
      filled[i] = true;
    };

    // The tiny clip.
    const plan = tinyPieces(dur);
    const size = tinySize(v.videoWidth, v.videoHeight);
    const chunks: WebmFrame[] = [];
    let encodeError: unknown = null;
    let small: HTMLCanvasElement | null = null;
    let sx: CanvasRenderingContext2D | null = null;
    if (enc) {
      encoder = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          chunks.push({ data, timestampUs: chunk.timestamp, key: chunk.type === 'key' });
        },
        error: (e) => {
          encodeError = e;
        },
      });
      encoder.configure({ codec: enc.codec, width: size.w, height: size.h, bitrate: TINY_BITRATE, framerate: TINY_FPS, latencyMode: 'quality' });
      small = document.createElement('canvas');
      small.width = size.w;
      small.height = size.h;
      sx = small.getContext('2d', { alpha: false });
      if (sx) sx.imageSmoothingQuality = 'high';
    }

    // Pieces to play: the tiny clip's pieces, stretched to cover the strip's frames.
    const runs = plan.starts.map((s) => ({ start: s, tinyEnd: s + plan.piece, end: s + plan.piece }));
    if (want.strip) {
      for (let i = 0; i < FRAMES; i++) {
        const t = stripTimes[i];
        const r = runs.find((x) => t >= x.start - 0.001 && t <= x.end + 2) ?? runs[runs.length - 1];
        if (t > r.end) r.end = Math.min(dur, t + 0.05);
      }
    }
    if (!enc) for (const r of runs) r.tinyEnd = r.start;

    let base = 0;
    const step = 1 / TINY_FPS;
    for (const run of runs) {
      await whenVisible();
      await seek(v, Math.min(run.start, Math.max(0, dur - 0.05)));
      let nextTiny = run.start;
      let first = true;
      const take = (t: number) => {
        if (strip) {
          for (let i = 0; i < FRAMES; i++) if (!filled[i] && stripTimes[i] <= t + 0.02 && stripTimes[i] >= run.start - 0.001) cell(i);
        }
        if (encoder && sx && small && t < run.tinyEnd && t >= nextTiny - step / 2 && encoder.state === 'configured') {
          // Too much waiting to be encoded: skip a frame rather than pile up.
          if (encoder.encodeQueueSize > 12) return;
          sx.drawImage(v, 0, 0, size.w, size.h);
          const ts = Math.round((base + Math.max(0, t - run.start)) * 1e6);
          const f = new VideoFrame(small, { timestamp: ts, duration: Math.round(step * 1e6) });
          encoder.encode(f, { keyFrame: first });
          f.close();
          first = false;
          while (nextTiny <= t + step / 2) nextTiny += step;
        }
      };
      take(v.currentTime);
      if (run.end > v.currentTime + 0.01) await playThrough(v, run.end, take);
      base += Math.max(step, run.tinyEnd - run.start);
    }

    // Any strip frames the playing skipped: one seek each.
    if (strip) {
      for (let i = 0; i < FRAMES; i++) {
        if (filled[i]) continue;
        await seek(v, stripTimes[i]);
        cell(i);
      }
    }

    const out: Made = { ms: 0 };
    if (strip) {
      const blob = await new Promise<Blob | null>((res) => strip.toBlob(res, 'image/jpeg', 0.72));
      if (!blob) throw new Error('could not encode');
      out.strip = new Uint8Array(await blob.arrayBuffer());
    }
    if (want.tiny) {
      if (encoder && enc) {
        await encoder.flush();
        if (encodeError) throw encodeError instanceof Error ? encodeError : new Error('could not encode');
        out.tiny = chunks.length ? writeWebm({ codec: enc.webm, width: size.w, height: size.h }, chunks, Math.round(base * 1e6)) : null;
      } else {
        out.tiny = null;
      }
    }
    out.ms = Math.round(performance.now() - started);
    return out;
  } finally {
    if (encoder && encoder.state !== 'closed') encoder.close();
    v.removeAttribute('src');
    v.load();
  }
}
