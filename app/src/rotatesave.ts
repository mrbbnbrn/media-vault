// "Save rotation" in the viewer: keeps an item turned the way it is shown.
// JPEGs and videos are turned by Rust without re-encoding (rotate.rs,
// videotool.rs). PNG, WebP and GIF are drawn turned here, in memory, and
// the new file is handed over; the old one stays until the undo is gone.

import { api, type Turned } from './api';
import type { PlayItem } from './media';
import { gifFrame, gifLoops, isAnimatedPng, isLosslessWebp, saveWay, turnedSize, turnMatrix, turnPixels, type Quarter } from './rotation';
import { GIFEncoder } from 'gifenc';

export const NO_VIDEO_TOOL =
  "Saving a video's rotation needs the video tool, which isn't installed. It comes with the full Media Vault download (the tools folder next to MediaVault.exe).";

/** Why it can't be saved (said as it is, not as a failure). */
export class RotateNote extends Error {}

async function bytesOf(src: string): Promise<Uint8Array> {
  const r = await fetch(src);
  if (!r.ok) throw new Error(`couldn't read it (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

/** A still picture drawn turned and encoded again (PNG: losslessly). */
export async function turnStill(bytes: Uint8Array, mime: 'image/png' | 'image/webp', r: Quarter): Promise<{ file: Uint8Array; lossless: boolean }> {
  if (mime === 'image/png' && isAnimatedPng(bytes)) throw new RotateNote("Moving PNG pictures can't be saved rotated yet. The rotation stays while you look at it.");
  const blob = new Blob([bytes as BlobPart]);
  let bmp: ImageBitmap;
  try {
    // As the viewer shows it: its own orientation applied, colours as on screen.
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bmp = await createImageBitmap(blob);
  }
  try {
    const t = turnedSize({ w: bmp.width, h: bmp.height }, r);
    const c = document.createElement('canvas');
    c.width = t.w;
    c.height = t.h;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(...turnMatrix(r, 0, 0, t.w, t.h));
    ctx.drawImage(bmp, 0, 0);
    const lossless = mime === 'image/png' || isLosslessWebp(bytes);
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, mime, lossless ? 1 : 0.95));
    c.width = c.height = 0;
    if (!out || out.type !== mime) throw new Error(`this window can't make ${mime === 'image/png' ? 'PNG' : 'WebP'} pictures`);
    return { file: new Uint8Array(await out.arrayBuffer()), lossless };
  } finally {
    bmp.close();
  }
}

type DecoderLike = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  completed: Promise<void>;
  decode: (o: { frameIndex: number }) => Promise<{ image: CanvasImageSource & { duration: number | null; displayWidth: number; displayHeight: number; close: () => void } }>;
  close: () => void;
};

/** Every frame of a GIF turned, with its timing and looping; exact colours where the frame has 256 or fewer. */
export async function turnGif(bytes: Uint8Array, r: Quarter, onProgress?: (f: number) => void): Promise<{ file: Uint8Array; lossless: boolean }> {
  const Dec = (window as unknown as { ImageDecoder?: new (o: { data: Uint8Array; type: string }) => DecoderLike }).ImageDecoder;
  if (!Dec) throw new Error("this window can't take GIFs apart");
  const dec = new Dec({ data: bytes, type: 'image/gif' });
  try {
    await dec.tracks.ready;
    await dec.completed.catch(() => {});
    const n = Math.max(1, dec.tracks.selectedTrack?.frameCount ?? 1);
    const loops = gifLoops(bytes);
    const enc = GIFEncoder();
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    let lossless = true;
    // Frames come whole (already put together); see-through frames must clear the one before.
    const frames: { index: Uint8Array; palette: number[][]; transparent: number; w: number; h: number; delay: number }[] = [];
    let seeThrough = false;
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const w = image.displayWidth;
      const h = image.displayHeight;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0);
      const delay = image.duration && image.duration > 0 ? image.duration / 1000 : 100;
      image.close();
      const px = ctx.getImageData(0, 0, w, h).data;
      const t = turnPixels(px, w, h, r);
      const f = gifFrame(t.data);
      if (!f.exact) lossless = false;
      if (f.transparent >= 0) seeThrough = true;
      frames.push({ index: f.index, palette: f.palette, transparent: f.transparent, w: t.w, h: t.h, delay });
      onProgress?.((i + 1) / n);
    }
    c.width = c.height = 0;
    frames.forEach((f, i) => {
      enc.writeFrame(f.index, f.w, f.h, {
        palette: f.palette,
        delay: f.delay,
        repeat: i === 0 ? (loops ?? -1) : undefined,
        transparent: f.transparent >= 0,
        transparentIndex: Math.max(0, f.transparent),
        dispose: seeThrough ? 2 : 1,
      });
    });
    enc.finish();
    return { file: enc.bytes(), lossless };
  } finally {
    dec.close();
  }
}

/** Keep `item` turned `r` clockwise quarter turns. Throws a short, friendly reason when it can't. */
export async function saveRotation(item: PlayItem, r: Quarter, onProgress?: (f: number) => void): Promise<Turned> {
  if (item.itemId == null) throw new RotateNote('Only items in the vault can be saved rotated.');
  if (!r) throw new RotateNote("It isn't rotated.");
  const how = saveWay(item.kind, item.name);
  switch (how.way) {
    case 'no':
      throw new RotateNote(how.why);
    case 'jpeg':
      return api.rotatePicture(item.itemId, r);
    case 'video': {
      const tool = await api.videoToolInfo().catch(() => undefined);
      if (!tool?.available) throw new RotateNote(NO_VIDEO_TOOL);
      return api.rotateVideo(item.itemId, r);
    }
    case 'pixels': {
      const t = await turnStill(await bytesOf(item.src), how.mime, r);
      return api.rotateReplace({ itemId: item.itemId, quarter: r, lossless: t.lossless }, t.file);
    }
    case 'gif': {
      const t = await turnGif(await bytesOf(item.src), r, onProgress);
      return api.rotateReplace({ itemId: item.itemId, quarter: r, lossless: t.lossless }, t.file);
    }
  }
}

/** "Saved the rotation" with what else happened. */
export function savedText(t: Turned): string {
  const copies = t.copies === 1 ? ' (its free copy shares the file, so it turned too)' : t.copies > 1 ? ` (its ${t.copies} free copies share the file, so they turned too)` : '';
  return `Saved the rotation${copies} · Ctrl+Z undoes it`;
}
