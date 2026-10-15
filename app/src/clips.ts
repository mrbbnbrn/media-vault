// Making new files from what is playing: a still frame from a video, or a
// GIF from part of a video. All in memory; the result goes straight into
// the vault (encrypted), never to disk.

import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { turnedSize, turnMatrix, type Quarter } from './rotation';

/** "Holiday.mp4" + 83.4 s → "Holiday – 1m23s.jpg" */
export function derivedName(name: string, seconds: number | null, ext: string, label = ''): string {
  const base = name.replace(/\.[^.]+$/, '');
  let t = '';
  if (seconds != null && Number.isFinite(seconds)) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    t = h ? `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s` : `${m}m${String(sec).padStart(2, '0')}s`;
  }
  return `${base} – ${[label, t].filter(Boolean).join(' ')}.${ext}`;
}

export function canvasBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the picture.'))), type, quality));
}

/** The video's current frame at full size, as a JPEG. */
export async function captureVideoFrame(v: HTMLVideoElement, r: Quarter = 0): Promise<Blob> {
  if (!v.videoWidth) throw new Error('The video has no picture yet.');
  const c = document.createElement('canvas');
  // Turned as the viewer shows it.
  const t = turnedSize({ w: v.videoWidth, h: v.videoHeight }, r);
  c.width = t.w;
  c.height = t.h;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(...turnMatrix(r, 0, 0, t.w, t.h));
  ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight);
  return canvasBlob(c, 'image/jpeg', 0.95);
}

export const GIF_MAX_SECONDS = 20;
export const GIF_MAX_FRAMES = 400;

export interface GifOptions {
  start: number;
  end: number;
  fps: number;
  width: number;
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res, rej) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      v.removeEventListener('error', fail);
      res();
    };
    const fail = () => {
      v.removeEventListener('seeked', done);
      v.removeEventListener('error', fail);
      rej(new Error('The video could not be read.'));
    };
    v.addEventListener('seeked', done);
    v.addEventListener('error', fail);
    v.currentTime = t;
  });
}

/**
 * Make a GIF from part of a video. Uses its own hidden copy of the video so
 * the one on screen keeps playing. Each frame gets its own 256-colour palette.
 */
export async function makeGif(src: string, o: GifOptions, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<Uint8Array> {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = src;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error('The video could not be read.'));
    });
    const len = Math.min(GIF_MAX_SECONDS, Math.max(0.1, o.end - o.start));
    const total = Math.min(GIF_MAX_FRAMES, Math.max(1, Math.round(len * o.fps)));
    const w = Math.max(16, Math.min(Math.round(o.width), v.videoWidth));
    const h = Math.max(16, Math.round((w * v.videoHeight) / v.videoWidth));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    const gif = GIFEncoder();
    const delay = Math.round(1000 / o.fps);
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      await seek(v, o.start + i / o.fps);
      ctx.drawImage(v, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, w, h, { palette, delay });
      onProgress(i + 1, total);
    }
    gif.finish();
    return gif.bytes();
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}
