// Small rules of the upscaler's before/after line (components/UpscaleCompare.tsx),
// kept apart so they can be tested.

/** Keep the line on the visible picture. */
export function clampLine(x: number, left: number, right: number): number {
  if (!(right > left)) return left;
  return Math.min(right, Math.max(left, x));
}

/** −1 / +1 for the keys that nudge the line ([ ] and Shift+arrows), else 0. */
export function compareKeyStep(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): -1 | 0 | 1 {
  if (e.ctrlKey || e.altKey || e.metaKey) return 0;
  if (e.key === '[' || (e.shiftKey && e.key === 'ArrowLeft')) return -1;
  if (e.key === ']' || (e.shiftKey && e.key === 'ArrowRight')) return 1;
  return 0;
}

/**
 * Preview only (no upscaler in a plain browser): a visibly different
 * "upscaled" picture — 2× bigger, more contrast and colour, a fine grid — so
 * the before/after line and its alignment can be checked by eye.
 */
export async function mockUpscaled(src: string): Promise<string> {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob);
  const f = Math.max(1, Math.min(2, 4096 / Math.max(bmp.width, bmp.height)));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * f);
  c.height = Math.round(bmp.height * f);
  const ctx = c.getContext('2d')!;
  ctx.filter = 'contrast(1.35) saturate(1.8) hue-rotate(-20deg)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  ctx.filter = 'none';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = Math.max(1, f);
  const step = Math.max(16, Math.round(Math.min(c.width, c.height) / 12));
  ctx.beginPath();
  for (let x = step; x < c.width; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, c.height);
  }
  for (let y = step; y < c.height; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y);
  }
  ctx.stroke();
  bmp.close();
  const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!out) throw new Error('mock upscale failed');
  return URL.createObjectURL(out);
}
