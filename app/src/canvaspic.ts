// Pictures the window makes from a canvas (thumbnails, frame strips): WebP,
// or JPEG where the web engine can't make WebP. In memory only.

/** WebP quality of thumbnails: looks like the JPEG quality 86 they replace, about a third smaller (picture.rs, tools/thumbquality.py). */
export const THUMB_WEBP_QUALITY = 0.83;
export const THUMB_JPEG_QUALITY = 0.86;
/** Frame strips (48 small frames): the WebP quality that looks like the JPEG quality 72 they were made with. */
export const STRIP_WEBP_QUALITY = 0.6;
export const STRIP_JPEG_QUALITY = 0.72;

/**
 * A canvas as WebP, or as JPEG if WebP can't be made (the web engine then
 * hands back a PNG instead, which would be far too big).
 */
export async function canvasPicture(c: HTMLCanvasElement, webpQuality: number, jpegQuality: number): Promise<Blob> {
  const as = (type: string, q: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));
  const b = await as('image/webp', webpQuality);
  if (b && b.type === 'image/webp') return b;
  const j = await as('image/jpeg', jpegQuality);
  if (!j) throw new Error('encode failed');
  return j;
}
