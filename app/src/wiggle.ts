// Save wiggle as GIF (still pictures, 3D ▾ while Wiggle is on): the views the
// 3D picture drew (Depth3D.tsx captureWiggle) written as one looping GIF, in
// the same order and at the same speed as in the viewer. One palette made
// from all views together, so the colours don't flicker between frames.

import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { wiggleSequence, type WiggleOptions } from './depthlook';

/** About how big the GIF will be (bytes): a photo GIF packs to roughly half a byte per pixel per view. */
export function wiggleGifSize(w: number, h: number, views: number): number {
  return Math.round(w * h * Math.max(2, views) * 0.55 + 2000);
}

/** The views as one looping GIF. */
export function wiggleGif(views: Uint8Array[], w: number, h: number, o: WiggleOptions): Uint8Array {
  if (!views.length) throw new Error('Nothing to save.');
  // The shared palette: every few pixels of every view.
  const step = Math.max(1, Math.floor((w * h * views.length) / 400_000));
  const n = Math.ceil((w * h) / step);
  const sample = new Uint8Array(n * views.length * 4);
  let k = 0;
  for (const v of views)
    for (let i = 0; i < w * h; i += step) {
      sample[k++] = v[i * 4];
      sample[k++] = v[i * 4 + 1];
      sample[k++] = v[i * 4 + 2];
      sample[k++] = 255;
    }
  const palette = quantize(sample.subarray(0, k), 256);
  const indexed = views.map((v) => applyPalette(v, palette));
  const gif = GIFEncoder();
  const delay = Math.round(1000 / Math.max(1, o.speed));
  wiggleSequence(Math.min(o.views, views.length), o.order).forEach((vi, i) => {
    gif.writeFrame(indexed[vi], w, h, i === 0 ? { palette, delay } : { delay });
  });
  gif.finish();
  return gif.bytes();
}
