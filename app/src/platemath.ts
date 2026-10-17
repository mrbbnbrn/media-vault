// The 3D picture layers' pixel maths (run in layerworker.ts, tested directly):
// - the background plate: the picture with the subject filled in (Simple:
//   pushed and pulled in from the surroundings on a small copy; or a fill
//   model's result), with the depth filled the same way (a little wider) in alpha;
// - the subject's own layer: its colours with a clean rim, its own depth in alpha.

import type { DepthMap, SubjectMask } from './api';
import { fillDepth, fillRgba, holeMask, resample, subjectColours, subjectOwnDepth } from './layers';

/** Simple fills on a copy this big (longest side), then enlarges. */
export const SIMPLE_SIDE = 256;

/** RGBA pixels resized (bilinear, per channel). */
export function resizeRgba(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const n = sw * sh;
  const ch = new Float32Array(n);
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < n; i++) ch[i] = src[i * 4 + c];
    const r = resample(ch, sw, sh, dw, dh);
    for (let i = 0; i < dw * dh; i++) out[i * 4 + c] = r[i];
  }
  return out;
}

/** What a fill replaces: the outline grown a little (its soft edge too), fading out at the rim. */
function colourHole(mask: SubjectMask): Float32Array {
  const side = Math.min(mask.w, mask.h);
  return holeMask(mask, side * 0.004, side * 0.004);
}

/** The hole for a fill model at its square input size (0 / 255). */
export function holeSquare(mask: SubjectMask, s: number): Uint8Array {
  const hs = resample(colourHole(mask), mask.w, mask.h, s, s);
  const mb = new Uint8Array(s * s);
  for (let i = 0; i < mb.length; i++) mb[i] = hs[i] > 0.02 ? 255 : 0;
  return mb;
}

/**
 * The background plate (RGBA, `w` × `h`): colour with the subject filled in (by `fill`,
 * any size, or Simple when null), alpha = the depth with the subject filled in.
 */
export function composePlate(orig: Uint8ClampedArray, w: number, h: number, mask: SubjectMask, depth: DepthMap, fill: { data: ArrayLike<number>; w: number; h: number } | null): Uint8Array {
  const hole = colourHole(mask);
  let F: Uint8ClampedArray;
  if (fill) F = resizeRgba(fill.data, fill.w, fill.h, w, h);
  else {
    const ks = Math.min(1, SIMPLE_SIDE / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * ks));
    const sh = Math.max(1, Math.round(h * ks));
    const small = resizeRgba(orig, w, h, sw, sh);
    const filled = fillRgba(small, sw, sh, resample(hole, mask.w, mask.h, sw, sh));
    F = resizeRgba(filled, sw, sh, w, h);
  }
  const hf = resample(hole, mask.w, mask.h, w, h);
  // The depth: a wider area than the colour's (the depth model blurs the subject's depth a
  // little way out into the background, which would otherwise swim along with the subject).
  const side = Math.min(mask.w, mask.h);
  const depthHole = holeMask(mask, side * 0.015, side * 0.006);
  const pd = fillDepth(depth, resample(depthHole, mask.w, mask.h, depth.w, depth.h));
  const df = resample(pd.data, pd.w, pd.h, w, h);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = hf[i];
    const j = i * 4;
    data[j] = orig[j] + (F[j] - orig[j]) * a;
    data[j + 1] = orig[j + 1] + (F[j + 1] - orig[j + 1]) * a;
    data[j + 2] = orig[j + 2] + (F[j + 2] - orig[j + 2]) * a;
    data[j + 3] = df[i];
  }
  return data;
}

/** The subject's own layer (RGBA, `w` × `h`): its colours with the rim cleaned, alpha = its own depth. */
export function composeFore(orig: Uint8ClampedArray, w: number, h: number, mask: SubjectMask, depth: DepthMap): Uint8Array {
  const m = resample(mask.data, mask.w, mask.h, w, h);
  const rgb = subjectColours(orig, m, w, h);
  const own = subjectOwnDepth(depth, mask);
  const od = resample(own.data, own.w, own.h, w, h);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = Math.round(od[i]);
  }
  return data;
}
