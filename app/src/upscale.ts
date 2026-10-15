// The upscaler's small rules, kept apart so they can be tested (the viewer
// side is components/Upscale.tsx; the work happens in Rust, upscale.rs).

import type { UpscaleModel } from './api';

export const MODELS: { id: UpscaleModel; label: string; hint: string }[] = [
  { id: 'realesrgan', label: 'Real-ESRGAN', hint: 'The whole picture, faces left as they are (most faithful)' },
  { id: 'gfpgan', label: 'GFPGAN', hint: 'Also rebuilds faces (sharpest faces; needs the faces download)' },
];

export const modelLabel = (m: UpscaleModel) => MODELS.find((x) => x.id === m)?.label ?? m;

/** Same limits as the Rust side (upscale_img.rs: plan). */
const MAX_OUT_PX = 4096 * 4096;
const MAX_OUT_SIDE = 16384;
const MIN_FACTOR = 1.5;

/** How much bigger a w × h picture gets (4, or less for bigger pictures), or why it can't. */
export function upscaleFactor(w: number, h: number): { factor: number } | { error: string } {
  if (!(w > 0 && h > 0)) return { error: 'This picture is empty.' };
  const f = Math.min(4, Math.sqrt(MAX_OUT_PX / (w * h)), MAX_OUT_SIDE / Math.max(w, h));
  if (f < MIN_FACTOR) return { error: `This picture is already big (${w} × ${h}). Upscaling is for smaller pictures.` };
  return { factor: Math.round(f * 10) / 10 };
}

export const factorText = (f: number) => `×${Number.isInteger(f) ? f : f.toFixed(1)}`;

type Pt = [number, number];

/** The 5 points GFPGAN lines faces up by (the face finder of the faces pack
 * gives exactly these): the eye on the picture's left, the other eye, nose
 * tip, mouth corner left, mouth corner right. Anything else is left out. */
export function fivePoints(pts: Pt[]): Pt[] | null {
  if (pts.length !== 5) return null;
  return pts.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) ? pts : null;
}

const KEY = 'mv-upscale-model';

/** The model picked last time (remembered on this computer). */
export function savedModel(): UpscaleModel {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'gfpgan' || v === 'realesrgan' ? v : 'realesrgan';
  } catch {
    return 'realesrgan';
  }
}

export function saveModel(m: UpscaleModel) {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    /* only a convenience */
  }
}

export const NO_PACK =
  'The upscaler is a separate download: get MediaVault-upscaler-windows.zip from the Releases page and unzip it next to the app.';
