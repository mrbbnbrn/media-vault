// Decodes pictures for the viewer away from the window's main thread
// (picturecache.ts). Even createImageBitmap, which decodes in the
// background, does its high-quality resize on the thread that called it, so
// shrinking a 50-megapixel photo to screen size there would freeze the
// window for a moment. Here it doesn't matter.
//
// In: { id, bytes: ArrayBuffer (transferred), resizeWidth?, resizeHeight? }
// Out: { id, bmp, bytes } (both transferred back) or { id, error, bytes }

interface Job {
  id: number;
  bytes: ArrayBuffer;
  resizeWidth?: number;
  resizeHeight?: number;
}

const post = (msg: unknown, transfer: Transferable[]) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bytes, resizeWidth, resizeHeight } = e.data;
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
    post({ id, bmp, bytes }, [bmp, bytes]);
  } catch (err) {
    post({ id, error: String(err), bytes }, [bytes]);
  }
};
