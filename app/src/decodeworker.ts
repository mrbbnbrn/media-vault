// Decodes pictures for the viewer away from the window's main thread
// (picturecache.ts). Even createImageBitmap, which decodes in the
// background, does its high-quality resize on the thread that called it, so
// shrinking a 50-megapixel photo to screen size there would freeze the
// window for a moment. Here it doesn't matter.
//
// In: { id, bytes: ArrayBuffer (transferred), resizeWidth?, resizeHeight?, pixels? }
// Out: { id, bmp, bytes } (both transferred back) or { id, error, bytes };
// with `pixels`: { id, data: ArrayBuffer (RGBA), w, h, bytes } instead of the bitmap
// (the 3D models' input and the 3D layers: no picture work on the window's thread at all).

interface Job {
  id: number;
  bytes: ArrayBuffer;
  resizeWidth?: number;
  resizeHeight?: number;
  pixels?: boolean;
}

const post = (msg: unknown, transfer: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bytes, resizeWidth, resizeHeight, pixels } = e.data;
  try {
    const blob = new Blob([bytes]);
    const opts: ImageBitmapOptions = { imageOrientation: 'from-image' };
    if (resizeWidth) Object.assign(opts, { resizeWidth, resizeQuality: 'high' });
    if (resizeWidth && resizeHeight) opts.resizeHeight = resizeHeight;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob, opts);
    } catch {
      bmp = await createImageBitmap(blob, resizeWidth ? { resizeWidth } : undefined);
    }
    if (pixels) {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('No canvas.');
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data.buffer;
      const w = bmp.width;
      const h = bmp.height;
      bmp.close();
      post({ id, data, w, h, bytes }, [data, bytes]);
      return;
    }
    post({ id, bmp, bytes }, [bmp, bytes]);
  } catch (err) {
    post({ id, error: String(err), bytes }, [bytes]);
  }
};
