// The picture editor's "Save as copy", away from the window's thread: the
// picture is decoded, drawn turned / straightened / cropped at full size,
// light and colour applied, and encoded here (a 50-megapixel photo is about
// 200 MB of pixels; on the window's thread that froze the app). In memory
// only; the encoded file goes back to the window, which saves it in the vault.
//
// In:  { bytes: ArrayBuffer, name, out: { w, h }, matrix, adjust, W, H }
// Out: { data: ArrayBuffer, mime, ext } or { error }

import { adjustPixels, anySeeThrough, hasAdjust, savedFormat, type Adjust, type Matrix } from './imageedit';

interface Job {
  bytes: ArrayBuffer;
  name: string;
  out: { w: number; h: number };
  matrix: Matrix;
  adjust: Adjust;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Job>) => {
  const j = e.data;
  try {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(new Blob([j.bytes]), { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(new Blob([j.bytes]));
    }
    const c = new OffscreenCanvas(j.out.w, j.out.h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error("the picture couldn't be drawn");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(...j.matrix);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const ext = (j.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
    const jpeg = ext === 'jpg' || ext === 'jpeg';
    let seeThrough = false;
    if (hasAdjust(j.adjust) || (!jpeg && ext !== 'png')) {
      const d = ctx.getImageData(0, 0, j.out.w, j.out.h);
      if (!jpeg && ext !== 'png') seeThrough = anySeeThrough(d.data);
      adjustPixels(d.data, j.out.w, j.out.h, j.adjust);
      ctx.putImageData(d, 0, 0);
    }
    const fmt = savedFormat(j.name, seeThrough);
    const blob = await c.convertToBlob({ type: fmt.mime, quality: fmt.quality });
    const data = await blob.arrayBuffer();
    post({ data, mime: fmt.mime, ext: fmt.ext }, [data]);
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
