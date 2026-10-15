// "Find the best frames": the rules for picking the nicest stills from a
// video, kept apart from the viewer so they can be tested (the dialog that
// seeks through the video is components/BestFrames.tsx). Everything works on
// small grey pictures in memory.

/** Where to look: about every 1–2 s, at most `max` places, never the very first or last moment. */
export function sampleTimes(durationS: number, max = 240): number[] {
  if (!(durationS > 0)) return [];
  if (durationS < 1.2) return [durationS / 2];
  const edge = Math.min(0.5, durationS * 0.04);
  const span = durationS - 2 * edge;
  const step = Math.max(span <= 90 ? 1 : 1.5, span / max);
  const n = Math.max(1, Math.floor(span / step) + 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round((edge + i * step) * 1000) / 1000);
  return out;
}

/** RGBA → grey (0–255), Rec. 601 weights. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return g;
}

/** Sharpness: the variance of the Laplacian (high = crisp edges, low = blur). */
export function laplacianVariance(g: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += l;
      sq += l * l;
      n++;
    }
  }
  const m = sum / n;
  return sq / n - m * m;
}

export interface Exposure {
  mean: number;
  /** Spread of brightness (contrast). */
  std: number;
  /** Share of crushed blacks / blown whites. */
  dark: number;
  bright: number;
}

export function exposureOf(g: Float32Array): Exposure {
  let s = 0;
  let sq = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    s += v;
    sq += v * v;
    if (v < 12) dark++;
    else if (v > 245) bright++;
  }
  const n = Math.max(1, g.length);
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), dark: dark / n, bright: bright / n };
}

/** 0–1: well exposed with some contrast; near 0 for black, white or flat frames (fades, title cards). */
export function exposureScore(e: Exposure): number {
  const centre = 1 - Math.min(1, Math.abs(e.mean - 118) / 118) ** 2;
  const contrast = Math.min(1, e.std / 48);
  const clipped = Math.max(0, 1 - 2.2 * (e.dark + e.bright));
  return Math.max(0, centre * 0.45 + contrast * 0.35 + clipped * 0.2) * (e.mean < 18 || e.mean > 240 || e.std < 6 ? 0.15 : 1);
}

export const SIG = 16;

/** A tiny grey signature (16 × 16, brightness-normalised) to tell frames apart. */
export function signature(g: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(SIG * SIG);
  for (let sy = 0; sy < SIG; sy++) {
    const y0 = Math.floor((sy * h) / SIG);
    const y1 = Math.max(y0 + 1, Math.floor(((sy + 1) * h) / SIG));
    for (let sx = 0; sx < SIG; sx++) {
      const x0 = Math.floor((sx * w) / SIG);
      const x1 = Math.max(x0 + 1, Math.floor(((sx + 1) * w) / SIG));
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += g[y * w + x];
      out[sy * SIG + sx] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  let m = 0;
  for (const v of out) m += v;
  m /= out.length;
  let sd = 0;
  for (const v of out) sd += (v - m) ** 2;
  sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / sd;
  return out;
}

/** 0 = the same picture, ~1 and up = clearly different. */
export function difference(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

export interface FaceHint {
  frameMs: number;
  w: number;
  h: number;
}

/** 0–1: faces seen within a second of this moment (more and bigger = higher). */
export function faceScore(faces: FaceHint[], atS: number): number {
  let best = 0;
  let n = 0;
  for (const f of faces) {
    if (Math.abs(f.frameMs - atS * 1000) > 1000) continue;
    n++;
    best = Math.max(best, Math.sqrt(Math.max(0, f.w * f.h)));
  }
  return n ? Math.min(1, 0.5 + best * 1.6 + (n - 1) * 0.1) : 0;
}

export interface Sample {
  t: number;
  sharp: number;
  exposure: number;
  face: number;
  sig: Float32Array;
}

export interface Scored extends Sample {
  score: number;
}

/** Overall scores (0–1). Sharpness counts relative to this video's sharpest frames. */
export function scoreSamples(samples: Sample[], hasFaces: boolean): Scored[] {
  if (!samples.length) return [];
  const logs = samples.map((s) => Math.log1p(Math.max(0, s.sharp)));
  const sorted = [...logs].sort((a, b) => a - b);
  // Against this video's sharper frames (the top quarter all count as sharp, so a few
  // grainy or busy outliers don't make everything else look soft): 12× less detail scores 0.
  const top = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] || 1;
  return samples.map((s, i) => {
    const sharp = Math.max(0, Math.min(1, 1 - (top - logs[i]) / 2.5));
    const score = hasFaces ? sharp * 0.5 + s.exposure * 0.3 + s.face * 0.2 : sharp * 0.6 + s.exposure * 0.4;
    // A dark or flat frame is never "best", however crisp its noise looks.
    return { ...s, score: s.exposure < 0.2 ? score * 0.3 : score };
  });
}

/** The best `count`, each clearly different from the ones already picked and not right next to them; in time order. */
export function pickBest(scored: Scored[], count: number, o: { minDiff?: number; minGapS?: number; floor?: number } = {}): Scored[] {
  const minDiff = o.minDiff ?? 0.35;
  const minGap = o.minGapS ?? 1.5;
  const chosen: Scored[] = [];
  const order = [...scored].sort((a, b) => b.score - a.score || a.t - b.t);
  // Not padded out with poor frames: each must be at least half as good as the best.
  const floor = Math.max(0.05, (order[0]?.score ?? 0) * (o.floor ?? 0.5));
  for (const s of order) {
    if (chosen.length >= count) break;
    if (s.score < floor) break;
    if (chosen.some((c) => Math.abs(c.t - s.t) < minGap || difference(c.sig, s.sig) < minDiff)) continue;
    chosen.push(s);
  }
  return chosen.sort((a, b) => a.t - b.t);
}

/** How many to show: ~one per 10 s of video, 6 to 12. */
export const wanted = (durationS: number) => Math.max(6, Math.min(12, Math.round(durationS / 10)));

/** 83.4 s → "1:23" (whole seconds, as in the saved name). */
export function clock(atS: number): string {
  const s = Math.max(0, Math.floor(atS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "Holiday.mp4" at 83.4 s → "Holiday · 01m23s.jpg" (hours when needed: "Holiday · 1h02m03s.jpg"). */
export function frameName(videoName: string, atS: number): string {
  const base = videoName.replace(/\.[^.]+$/, '') || 'Frame';
  const s = Math.max(0, Math.floor(atS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${base} · ${h ? `${h}h${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}m${sec}s.jpg`;
}

/** Names for several frames, made unique when two land in the same second. */
export function frameNames(videoName: string, times: number[]): string[] {
  const seen = new Map<string, number>();
  return times.map((t) => {
    const n = frameName(videoName, t);
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : n.replace(/\.jpg$/, ` (${k}).jpg`);
  });
}
