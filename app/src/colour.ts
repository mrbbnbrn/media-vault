// "Colour flow" maths (Mosaic and Wall in Multi-screen): each item's average
// colour and main hue, from a tiny copy of its thumbnail, turned into one
// number along a rainbow (0 … 1) so pieces can be laid out from one side of
// the screen to the other by colour. Greys, near-black and near-white go
// together at the end of the rainbow (dark to light). Pure, so it can be
// tested; the measuring in the browser is colourcache.ts.

export interface Colour {
  /** Average colour (0–255). */
  r: number;
  g: number;
  b: number;
  /** Main hue (degrees, 0–360), from the most colourful pixels. */
  hue: number;
  /** How colourful it is overall (0 = grey … 1). */
  sat: number;
  /** Lightness of the average (0–1). */
  light: number;
}

/** The rainbow starts at this hue (pinks), so reds are never split in two. */
export const HUE_START = 320;
/** Below this colourfulness an item counts as grey (with black and white). */
export const GREY_SAT = 0.12;
/** The share of the rainbow line kept for the greys (at its end). */
const GREY_SHARE = 0.16;

function hueOf(r: number, g: number, b: number): { hue: number; chroma: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  if (c <= 0) return { hue: 0, chroma: 0 };
  let h: number;
  if (max === r) h = ((g - b) / c) % 6;
  else if (max === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return { hue: h < 0 ? h + 360 : h, chroma: c };
}

/**
 * Colour of a small RGBA picture (e.g. 16×16): the average, and the main hue
 * from a histogram of hues weighted by how colourful each pixel is (so a red
 * flower on grey counts as red, not as a muddy average).
 */
export function measureColour(data: ArrayLike<number>): Colour | null {
  const BINS = 24;
  const hist = new Float64Array(BINS);
  const sx = new Float64Array(BINS);
  const sy = new Float64Array(BINS);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  let chromaSum = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3] / 255;
    if (a < 0.5) continue;
    const pr = data[i];
    const pg = data[i + 1];
    const pb = data[i + 2];
    r += pr;
    g += pg;
    b += pb;
    n++;
    const { hue, chroma } = hueOf(pr / 255, pg / 255, pb / 255);
    chromaSum += chroma;
    if (chroma < 0.06) continue;
    const w = chroma * chroma;
    const k = Math.min(BINS - 1, Math.floor((hue / 360) * BINS));
    hist[k] += w;
    const rad = (hue * Math.PI) / 180;
    sx[k] += Math.cos(rad) * w;
    sy[k] += Math.sin(rad) * w;
  }
  if (!n) return null;
  r /= n;
  g /= n;
  b /= n;
  // The strongest hue band, with its neighbours (a hue on a band's edge isn't split).
  let best = -1;
  let bestW = 0;
  for (let k = 0; k < BINS; k++) {
    const w = hist[k] + 0.5 * (hist[(k + 1) % BINS] + hist[(k + BINS - 1) % BINS]);
    if (w > bestW) {
      bestW = w;
      best = k;
    }
  }
  let hue = hueOf(r / 255, g / 255, b / 255).hue;
  if (best >= 0) {
    let x = 0;
    let y = 0;
    for (const k of [best - 1, best, best + 1]) {
      const j = (k + BINS) % BINS;
      x += sx[j];
      y += sy[j];
    }
    const h = (Math.atan2(y, x) * 180) / Math.PI;
    hue = h < 0 ? h + 360 : h;
  }
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const light = (max + min) / 2;
  // Colourful: the pixels' own colourfulness (a picture half red, half green averages to brown, but is colourful).
  const sat = Math.min(1, (chromaSum / n) * 1.6);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), hue: Math.round(hue * 10) / 10, sat: Math.round(sat * 1000) / 1000, light: Math.round(light * 1000) / 1000 };
}

/** Grey, black or white (no clear colour), or very dark / very light. */
export const isNeutral = (c: Colour) => c.sat < GREY_SAT || c.light < 0.09 || c.light > 0.93;

/**
 * Where on the rainbow line (0 … 1) an item goes: the hues from pink through
 * red, orange, yellow, green, cyan and blue to violet, then the greys from
 * near-black to near-white.
 */
export function rainbowPos(c: Colour): number {
  if (isNeutral(c)) return 1 - GREY_SHARE + GREY_SHARE * Math.max(0, Math.min(1, c.light));
  const h = (((c.hue - HUE_START) % 360) + 360) % 360;
  return (h / 360) * (1 - GREY_SHARE - 0.02);
}

/** The `f` quantile (0 … 1) of some rainbow positions (null when there are none). */
export function quantile(values: number[], f: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const x = Math.max(0, Math.min(1, f)) * (s.length - 1);
  const i = Math.floor(x);
  const t = x - i;
  return s[i] + (s[Math.min(s.length - 1, i + 1)] - s[i]) * t;
}

/**
 * Sort the items at `slots` (in this order) by their rainbow position; items
 * whose colour isn't known yet stay where they are. Returns a new array.
 */
export function sortSlots<T>(list: T[], slots: number[], pos: (t: T) => number | null): T[] {
  const out = [...list];
  const known = slots.filter((i) => i >= 0 && i < list.length && pos(list[i]) != null);
  const vals = known.map((i) => list[i]).sort((a, b) => pos(a)! - pos(b)!);
  known.forEach((i, k) => {
    out[i] = vals[k];
  });
  return out;
}

/** A grid's slots column by column (top to bottom, then the next column): a rainbow from left to right. */
export function columnOrder(cols: number, rows: number, n = cols * rows): number[] {
  const out: number[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const i = r * cols + c;
    if (i < n) out.push(i);
  }
  return out;
}

/**
 * From a few candidates (in weighted-random order: likelier first), the one
 * whose colour best matches `target`. Candidates of unknown colour count as a
 * middling match; earlier ones win near-ties, so the weights still count.
 */
export function bestMatch<T>(cands: T[], target: number | null, pos: (t: T) => number | null): T | null {
  if (!cands.length) return null;
  if (target == null) return cands[0];
  let best = cands[0];
  let bestS = Infinity;
  cands.forEach((t, k) => {
    const p = pos(t);
    const s = (p == null ? 0.35 : Math.abs(p - target)) + k * 0.004;
    if (s < bestS) {
      bestS = s;
      best = t;
    }
  });
  return best;
}

// ---- remembering (numbers only, never pictures) ----------------------------------------------

/** A colour as a short string for storage: "r,g,b,hue,sat,light". */
export const packColour = (c: Colour) => `${c.r},${c.g},${c.b},${c.hue},${c.sat},${c.light}`;

export function unpackColour(s: unknown): Colour | null {
  if (typeof s !== 'string') return null;
  const v = s.split(',').map(Number);
  if (v.length !== 6 || v.some((x) => !Number.isFinite(x))) return null;
  const [r, g, b, hue, sat, light] = v;
  if ([r, g, b].some((x) => x < 0 || x > 255) || hue < 0 || hue > 360 || sat < 0 || sat > 1 || light < 0 || light > 1) return null;
  return { r, g, b, hue, sat, light };
}
