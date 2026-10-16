// Pure maths for the picture layers of 3D photos (still pictures only):
//
// - Sharper depth edges: the depth map is made to follow the subject's
//   outline (subject pixels keep the subject's depth, the background right
//   next to it keeps the background's), softened over a pixel or so.
// - Layered 3D: the subject area filled in from its surroundings (push-pull:
//   the known colours averaged down a pyramid and pulled back up into the
//   hole), for the background plate's colours and its depth.
// - A light that stays put: where the light comes from, the shadow's offset
//   and the rim light's direction as the camera moves.
// - Look-ahead: how many pictures to prepare ahead for a slideshow stay.
//
// Everything works on small maps once per picture (never per frame); the
// drawing is in components/Depth3D.tsx.

import type { DepthMap, SubjectMask } from './api';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Bilinear resampling of a one-value-per-pixel map (pixel centres line up). */
export function resample(src: ArrayLike<number>, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  if (sw === dw && sh === dh) {
    for (let i = 0; i < out.length; i++) out[i] = src[i];
    return out;
  }
  const kx = sw / dw;
  const ky = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = fx - x0;
      const a = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const b = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** How far each pixel is from the nearest set pixel (in pixels, chamfer 1 / √2; 0 on set pixels). */
export function distanceTo(set: ArrayLike<number>, w: number, h: number): Float32Array {
  const INF = 1e9;
  const D = Math.SQRT2;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = set[i] ? 0 : INF;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (!v) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  return d;
}

/**
 * Push-pull fill: values (`ch` per pixel) where `weight` is 1 are kept, where
 * it is 0 they are filled in from the surroundings (the known values are
 * averaged down a pyramid, then pulled back up into the gaps, so the fill is
 * smooth and reaches across holes of any size). Weights between blend.
 * Nothing known at all: everything comes back 0.
 */
export function pushPull(values: ArrayLike<number>, weight: ArrayLike<number>, w: number, h: number, ch = 1): Float32Array {
  // Level 0: weighted values (premultiplied) and weights.
  type Level = { w: number; h: number; v: Float32Array; a: Float32Array };
  const n = w * h;
  const l0: Level = { w, h, v: new Float32Array(n * ch), a: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const a = clamp01(weight[i]);
    l0.a[i] = a;
    for (let c = 0; c < ch; c++) l0.v[i * ch + c] = values[i * ch + c] * a;
  }
  const levels: Level[] = [l0];
  // Push: down to one pixel.
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const f = levels[levels.length - 1];
    const cw = Math.max(1, Math.ceil(f.w / 2));
    const chh = Math.max(1, Math.ceil(f.h / 2));
    const c: Level = { w: cw, h: chh, v: new Float32Array(cw * chh * ch), a: new Float32Array(cw * chh) };
    for (let y = 0; y < chh; y++)
      for (let x = 0; x < cw; x++) {
        let A = 0;
        const j = y * cw + x;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const fx = x * 2 + dx;
            const fy = y * 2 + dy;
            if (fx >= f.w || fy >= f.h) continue;
            const i = fy * f.w + fx;
            A += f.a[i];
            for (let k = 0; k < ch; k++) c.v[j * ch + k] += f.v[i * ch + k];
          }
        // Kept as a weight of at most 1 (enough known below counts as fully known).
        if (A > 1) {
          for (let k = 0; k < ch; k++) c.v[j * ch + k] /= A;
          A = 1;
        }
        c.a[j] = A;
      }
    levels.push(c);
  }
  // Pull: from the top, each level's gaps filled from the (filled) level above, bilinearly.
  const up = new Float32Array(ch);
  {
    const top = levels[levels.length - 1];
    for (let k = 0; k < ch; k++) up[k] = top.a[0] > 0 ? top.v[k] / top.a[0] : 0;
  }
  let filled: Float32Array = up;
  let fw = 1;
  let fh = 1;
  for (let li = levels.length - 2; li >= 0; li--) {
    const L = levels[li];
    const out = new Float32Array(L.w * L.h * ch);
    for (let y = 0; y < L.h; y++) {
      const sy = Math.min(fh - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(sy);
      const y1 = Math.min(fh - 1, y0 + 1);
      const ty = sy - y0;
      for (let x = 0; x < L.w; x++) {
        const sx = Math.min(fw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(sx);
        const x1 = Math.min(fw - 1, x0 + 1);
        const tx = sx - x0;
        const i = y * L.w + x;
        const a = L.a[i];
        for (let k = 0; k < ch; k++) {
          const p00 = filled[(y0 * fw + x0) * ch + k];
          const p01 = filled[(y0 * fw + x1) * ch + k];
          const p10 = filled[(y1 * fw + x0) * ch + k];
          const p11 = filled[(y1 * fw + x1) * ch + k];
          const u = (p00 + (p01 - p00) * tx) * (1 - ty) + (p10 + (p11 - p10) * tx) * ty;
          // Premultiplied known part + the rest from above.
          out[i * ch + k] = L.v[i * ch + k] + (1 - a) * u;
        }
      }
    }
    filled = out;
    fw = L.w;
    fh = L.h;
  }
  return filled;
}

/** A light box blur (radius in pixels) of a one-value map. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w) continue;
        s += src[y * w + xx];
        n++;
      }
      tmp[y * w + x] = s / n;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x];
        n++;
      }
      out[y * w + x] = s / n;
    }
  return out;
}

// ---- sharper depth edges ----------------------------------------------------------------------

/** The strength setting read safely (0.2–1; anything else is 0.7). */
export function edgesStrength(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(1, Math.max(0.2, v)) : 0.7;
}

/**
 * The depth map made to follow the subject's outline: subject pixels keep the
 * subject's depth, background pixels right next to the subject keep the
 * background's (no depth bleeding across the outline), blended over a pixel
 * or so so it doesn't alias. `strength` (0–1): how wide a band along the
 * outline is put right, and how fully. Away from the outline the map is
 * unchanged. No clear subject (or a tiny map): the map comes back as it was.
 */
export function refineEdges(depth: DepthMap, mask: SubjectMask, strength: number): DepthMap {
  const { w, h } = depth;
  const k = clamp01(strength);
  if (k <= 0 || w < 8 || h < 8 || !mask.w || !mask.h || depth.data.length < w * h) return depth;
  const n = w * h;
  const m = resample(mask.data, mask.w, mask.h, w, h);
  const subj = new Uint8Array(n);
  const bg = new Uint8Array(n);
  let ns = 0;
  for (let i = 0; i < n; i++) {
    if (m[i] >= 127.5) {
      subj[i] = 1;
      ns++;
    } else bg[i] = 1;
  }
  if (ns === 0 || ns === n) return depth;
  // How wide the band along the outline is (1–8 px at the Fast model's 518 px, more on bigger maps).
  const band = (1 + 7 * k) * Math.max(1, Math.min(w, h) / 518);
  const toBg = distanceTo(bg, w, h);
  const toSubj = distanceTo(subj, w, h);
  const sw = new Float32Array(n);
  const bw = new Float32Array(n);
  let nsw = 0;
  let nbw = 0;
  for (let i = 0; i < n; i++) {
    if (subj[i] && toBg[i] > band) {
      sw[i] = 1;
      nsw++;
    }
    if (bg[i] && toSubj[i] > band) {
      bw[i] = 1;
      nbw++;
    }
  }
  // A subject (or background) thinner than the band: its own pixels are used as they are.
  if (!nsw) for (let i = 0; i < n; i++) sw[i] = subj[i];
  if (!nbw) for (let i = 0; i < n; i++) bw[i] = bg[i];
  const sF = pushPull(depth.data, sw, w, h);
  const bF = pushPull(depth.data, bw, w, h);
  // The outline softened over about a pixel (at 518 px), so the step doesn't alias.
  const soft = new Float32Array(n);
  for (let i = 0; i < n; i++) soft[i] = m[i] / 255;
  const ms = boxBlur(soft, w, h, Math.max(1, Math.round(Math.min(w, h) / 518)));
  const blend = Math.min(1, 0.4 + 0.6 * k);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const near = toBg[i] <= band + 1 || toSubj[i] <= band + 1;
    const d = depth.data[i];
    if (!near && (sw[i] || bw[i])) {
      out[i] = d;
      continue;
    }
    const c = bF[i] + (sF[i] - bF[i]) * ms[i];
    out[i] = Math.round(Math.min(255, Math.max(0, d + (c - d) * blend)));
  }
  return { w, h, data: out };
}

// ---- layered 3D: the background plate --------------------------------------------------------

/**
 * Where the subject is filled in (0–1 per pixel, at the outline's size): the
 * outline, grown by `grow` pixels (so its soft edge is filled too) and fading
 * out over `feather` more.
 */
export function holeMask(mask: SubjectMask, grow: number, feather: number): Float32Array {
  const n = mask.w * mask.h;
  const set = new Uint8Array(n);
  for (let i = 0; i < n; i++) set[i] = mask.data[i] >= 26 ? 1 : 0;
  const d = distanceTo(set, mask.w, mask.h);
  const out = new Float32Array(n);
  const f = Math.max(0.5, feather);
  for (let i = 0; i < n; i++) out[i] = d[i] <= grow ? 1 : clamp01(1 - (d[i] - grow) / f);
  return out;
}

/** The weight of what's known for a fill: anything touched by the hole counts as unknown. */
function knownOf(hole: Float32Array): Float32Array {
  const k = new Float32Array(hole.length);
  for (let i = 0; i < hole.length; i++) k[i] = hole[i] > 0.02 ? 0 : 1;
  return k;
}

/** RGBA pixels with the hole (0–1 per pixel, same size) filled in from the surroundings (Simple). Alpha comes back 255. */
export function fillRgba(rgba: ArrayLike<number>, w: number, h: number, hole: Float32Array): Uint8Array {
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  const f = pushPull(rgb, knownOf(hole), w, h, 3);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = hole[i];
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(rgba[i * 4 + c] + (f[i * 3 + c] - rgba[i * 4 + c]) * a);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** The depth map with the subject area filled with the surrounding background's depth (`hole` at the depth map's size). */
export function fillDepth(depth: DepthMap, hole: Float32Array): DepthMap {
  const f = pushPull(depth.data, knownOf(hole), depth.w, depth.h);
  const out = new Uint8Array(depth.w * depth.h);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(255, Math.max(0, depth.data[i] + (f[i] - depth.data[i]) * hole[i])));
  return { w: depth.w, h: depth.h, data: out };
}

/** The background's depth just around the subject (0–1; null when there's no subject or no background near it). */
export function bgDepthNear(depth: DepthMap, mask: SubjectMask): number | null {
  if (!depth.w || !depth.h || !mask.w || !mask.h) return null;
  const G = 96;
  // The subject's box, grown by a fifth each way.
  let x0 = G;
  let y0 = G;
  let x1 = -1;
  let y1 = -1;
  const mAt = (i: number, j: number) => mask.data[Math.min(mask.h - 1, Math.floor(((j + 0.5) / G) * mask.h)) * mask.w + Math.min(mask.w - 1, Math.floor(((i + 0.5) / G) * mask.w))];
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++)
      if (mAt(i, j) >= 128) {
        x0 = Math.min(x0, i);
        y0 = Math.min(y0, j);
        x1 = Math.max(x1, i);
        y1 = Math.max(y1, j);
      }
  if (x1 < 0) return null;
  const gx = Math.ceil((x1 - x0 + 1) * 0.2);
  const gy = Math.ceil((y1 - y0 + 1) * 0.2);
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, y0 - gy); j <= Math.min(G - 1, y1 + gy); j++)
    for (let i = Math.max(0, x0 - gx); i <= Math.min(G - 1, x1 + gx); i++) {
      if (mAt(i, j) >= 64) continue;
      sum += depth.data[Math.min(depth.h - 1, Math.floor(((j + 0.5) / G) * depth.h)) * depth.w + Math.min(depth.w - 1, Math.floor(((i + 0.5) / G) * depth.w))];
      n++;
    }
  return n ? sum / n / 255 : null;
}

// ---- a light that stays put -------------------------------------------------------------------

/** The light settings read safely: where it comes from (degrees clockwise from the top) and how strong (0.2–2). */
export function lightAngle(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? ((v % 360) + 360) % 360 : 315;
}
export function lightStrength(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(2, Math.max(0.2, v)) : 1;
}

/** "From the top left" for an angle (clockwise from the top). */
export function lightWords(angle: number): string {
  const names = ['the top', 'the top right', 'the right', 'the bottom right', 'the bottom', 'the bottom left', 'the left', 'the top left'];
  return `From ${names[Math.round(lightAngle(angle) / 45) % 8]}`;
}

/** The direction the light comes from (square units: x right, y down; 0° = from the top, clockwise). */
export function lightDir(angle: number): { x: number; y: number } {
  const a = (lightAngle(angle) * Math.PI) / 180;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

/** How much the light seems to turn as the camera moves (per unit of camera shift, square units). */
export const LIGHT_TURN = 14;

export interface LightFrame {
  /** From a background point, where (uv) the subject is that casts its shadow there (towards the light; fixed in the room). */
  offset: { x: number; y: number };
  /** A step (uv) towards the light as seen from where the camera is now: the rim light is on the subject's edge facing it. */
  rim: { x: number; y: number };
  /** How dark the shadow is, how bright the rim, and the shadow's softness (share of the picture's height). */
  shadow: number;
  rimAmount: number;
  blur: number;
}

/**
 * The light for this moment: `angle` and `strength` from the settings, the
 * camera's shift (uv, as drawn), the picture's shape (width / height) and the
 * subject's and background's depths (0–1). The shadow falls away from the
 * light, further the more the subject stands out from the background; it is
 * fixed to the background (the drawing moves it with the background's own
 * parallax), so as the camera moves the gap between the subject and its
 * shadow opens and closes. The rim light slides round the subject's edge the
 * other way from the camera, as if the light stayed where it is in the room.
 */
export function lightFrame(angle: number, strength: number, shift: { x: number; y: number }, asp: number, zSubj: number, zBg: number): LightFrame {
  const a = asp > 0 && Number.isFinite(asp) ? asp : 1;
  const k = lightStrength(strength);
  const L = lightDir(angle);
  const gap = Math.max(0, zSubj - zBg);
  const dist = (0.012 + 0.05 * gap) * Math.sqrt(k);
  // The camera moved right: the light (still in the room) now comes a little more from the left of the view.
  const sx = (Number.isFinite(shift.x) ? shift.x : 0) * a;
  const sy = Number.isFinite(shift.y) ? shift.y : 0;
  let rx = L.x - sx * LIGHT_TURN;
  let ry = L.y - sy * LIGHT_TURN;
  const len = Math.hypot(rx, ry) || 1;
  rx /= len;
  ry /= len;
  const rimW = 0.009 * Math.sqrt(k);
  return {
    offset: { x: (L.x * dist) / a, y: L.y * dist },
    rim: { x: (rx * rimW) / a, y: ry * rimW },
    shadow: Math.min(0.6, 0.38 * k),
    rimAmount: Math.min(0.85, 0.5 * k),
    blur: 0.012 + 0.012 * Math.sqrt(k),
  };
}

// ---- look-ahead by stay time --------------------------------------------------------------------

/** The most pictures prepared ahead. */
export const AHEAD_CAP = 8;

/**
 * How many pictures to prepare ahead (depth and outlines): browsing by hand
 * (`stay` null) or long stays (5 s or more) the next 2; 1–5 s the next 4;
 * under a second the next 8 (never more than AHEAD_CAP).
 */
export function aheadCount(stay: number | null | undefined): number {
  if (stay == null || !Number.isFinite(stay) || stay >= 5) return 2;
  if (stay >= 1) return Math.min(AHEAD_CAP, 4);
  return AHEAD_CAP;
}
