// Mosaic maths: justified rows (like a photo site) that fill the screen exactly.
// Every piece keeps its own shape. Rows always span the full width; the row
// breaks are chosen so the rows together are as close to the full height as
// possible, and the items on screen are chosen so that "close" is very close.
// Whatever is left (usually well under 1%) is taken up by trimming every
// piece by the same tiny amount, never more than MAX_CROP, never by gaps.

export const MOSAIC_GAP = 4;
/** At most this many videos actually play at once; the rest show a still. */
export const MOSAIC_MAX_VIDEOS = 8;
/** Largest trim allowed to make the rows fill the screen exactly. */
export const MAX_CROP = 0.03;

export type MosaicSize = 'big' | 'normal' | 'small';
export type MosaicSpeed = 'calm' | 'normal' | 'fast' | 'veryFast';

export const MOSAIC_SIZES: { id: MosaicSize; label: string; rows: number }[] = [
  { id: 'big', label: 'Fewer, bigger', rows: 2 },
  { id: 'normal', label: 'Normal size', rows: 3 },
  { id: 'small', label: 'More, smaller', rows: 4 },
];
/** About how long each piece stays on screen (seconds). Several change at once when needed. */
export const MOSAIC_SPEEDS: { id: MosaicSpeed; label: string; stay: number }[] = [
  { id: 'calm', label: 'Calm', stay: 30 },
  { id: 'normal', label: 'Normal', stay: 15 },
  { id: 'fast', label: 'Fast', stay: 7 },
  { id: 'veryFast', label: 'Very fast', stay: 3.5 },
];

/**
 * How often to change pieces and how many each time, so every piece stays about
 * `stay` seconds: changes come no closer than `minGap` (the glide needs time), and
 * then several pieces change together.
 */
export function mosaicPace(stay: number, pieces: number, minGap = 0.9): { gap: number; count: number } {
  const n = Math.max(1, pieces);
  const gap = Math.max(minGap, Math.min(stay / n, 4));
  return { gap, count: Math.max(1, Math.min(n, Math.round((n * gap) / stay))) };
}

export interface MosaicSettings {
  size: MosaicSize;
  speed: MosaicSpeed;
  /** Play the sound of the piece under the mouse. */
  sound: boolean;
}
export const DEFAULT_MOSAIC: MosaicSettings = { size: 'normal', speed: 'normal', sound: false };

/** Settings from a saved layout (anything missing or odd falls back to the default). */
export function normalizeMosaic(x: unknown): MosaicSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<MosaicSettings>;
  return {
    size: MOSAIC_SIZES.some((s) => s.id === o.size) ? o.size! : DEFAULT_MOSAIC.size,
    speed: MOSAIC_SPEEDS.some((s) => s.id === o.speed) ? o.speed! : DEFAULT_MOSAIC.speed,
    sound: typeof o.sound === 'boolean' ? o.sound : DEFAULT_MOSAIC.sound,
  };
}
export const mosaicRows = (size: MosaicSize) => MOSAIC_SIZES.find((s) => s.id === size)?.rows ?? 3;

export interface Box { x: number; y: number; w: number; h: number }

export interface MosaicFit {
  /** One box per aspect, same order. */
  boxes: Box[];
  /** Index of the first piece of each row. */
  rowStarts: number[];
  /** How far from a perfect fill the rows were before trimming (0 = perfect). */
  error: number;
  /** How much each piece is trimmed (0 … MAX_CROP). */
  crop: number;
}

const clampAspect = (a: number) => (Number.isFinite(a) && a > 0 ? Math.min(10, Math.max(0.1, a)) : 1);

/**
 * Lay out pieces (in this order) in `rows` justified rows filling W×H.
 * Row breaks come from a small dynamic program that keeps every row close to
 * the same height; then one shared scale makes the total exactly H.
 */
export function packMosaic(aspectsIn: number[], W: number, H: number, rowsWanted: number, gap = MOSAIC_GAP): MosaicFit {
  const a = aspectsIn.map(clampAspect);
  const n = a.length;
  if (!n || W <= 0 || H <= 0) return { boxes: [], rowStarts: [], error: n ? 1 : 0, crop: 0 };
  const R = Math.max(1, Math.min(rowsWanted, n));
  const pre = [0];
  for (const x of a) pre.push(pre[pre.length - 1] + x);
  const rowH = (i: number, j: number) => (W - gap * (j - i - 1)) / (pre[j] - pre[i]);
  const target = (H - gap * (R - 1)) / R;
  const cost = (i: number, j: number) => {
    const h = rowH(i, j);
    return h > 0 ? Math.log(h / target) ** 2 : 1e9;
  };
  // dp[r][j]: best cost for the first j pieces in r rows.
  const dp: number[][] = Array.from({ length: R + 1 }, () => new Array(n + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: R + 1 }, () => new Array(n + 1).fill(-1));
  dp[0][0] = 0;
  for (let r = 1; r <= R; r++)
    for (let j = r; j <= n - (R - r); j++)
      for (let i = r - 1; i < j; i++) {
        if (dp[r - 1][i] === Infinity) continue;
        const c = dp[r - 1][i] + cost(i, j);
        if (c < dp[r][j]) { dp[r][j] = c; from[r][j] = i; }
      }
  const rowStarts: number[] = [];
  for (let r = R, j = n; r > 0; r--) {
    const i = from[r][j];
    rowStarts.unshift(i);
    j = i;
  }
  const ends = [...rowStarts.slice(1), n];
  const heights = rowStarts.map((s, k) => rowH(s, ends[k]));
  const sum = heights.reduce((x, y) => x + y, 0);
  const avail = H - gap * (R - 1);
  const s = avail / sum;
  const error = Math.abs(s - 1);
  // Trim by at most MAX_CROP; if even that is not enough (very few pieces), centre what fits.
  const sc = Math.min(1 + MAX_CROP, Math.max(1 - MAX_CROP, s));
  const used = sum * sc + gap * (R - 1);
  const top = (H - used) / 2;
  const boxes: Box[] = new Array(n);
  let yf = top;
  rowStarts.forEach((st, k) => {
    const h = heights[k] * sc;
    const y0 = Math.round(yf);
    const y1 = k === R - 1 && Math.abs(top) < 0.5 ? H : Math.round(yf + h);
    let xf = 0;
    for (let i = st; i < ends[k]; i++) {
      const w = a[i] * heights[k];
      const x0 = Math.round(xf);
      const x1 = i === ends[k] - 1 ? W : Math.round(xf + w);
      boxes[i] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      xf += w + gap;
    }
    yf += h + gap;
  });
  return { boxes, rowStarts, error, crop: Math.abs(1 - sc) };
}

// ---- choosing what is on screen ------------------------------------------------------------

export interface Chooser<T> {
  key: (t: T) => string;
  aspect: (t: T) => number;
  /** A random pick (by weight), avoiding these keys when there is anything else. */
  pick: (exclude: Set<string>) => T | null;
  rnd?: () => number;
}

const errorOf = <T,>(list: T[], c: Chooser<T>, W: number, H: number, rows: number) =>
  list.length ? packMosaic(list.map(c.aspect), W, H, rows).error : Infinity;

/** About how many pieces fill the screen at this many rows (for the count penalty). */
function idealCount<T>(list: T[], c: Chooser<T>, W: number, H: number, rows: number): number {
  const avg = list.length ? list.reduce((s, t) => s + clampAspect(c.aspect(t)), 0) / list.length : 1;
  const rowAspect = W / ((H - MOSAIC_GAP * (rows - 1)) / rows);
  return Math.max(rows, rows * Math.max(1, rowAspect / avg));
}

function score<T>(list: T[], c: Chooser<T>, W: number, H: number, rows: number, ideal: number): number {
  // Mostly the fill error; a little push towards a sensible number of pieces.
  return errorOf(list, c, W, H, rows) + 0.004 * Math.abs(list.length - ideal) / Math.max(1, ideal) * 10;
}

/** Candidate pieces in weighted-random order, none of them already on screen. */
function candidates<T>(on: T[], c: Chooser<T>, k: number): T[] {
  const ex = new Set(on.map(c.key));
  const out: T[] = [];
  for (let i = 0; i < k; i++) {
    const t = c.pick(ex);
    if (!t || ex.has(c.key(t))) break;
    ex.add(c.key(t));
    out.push(t);
  }
  return out;
}

/**
 * Swap the piece at `victim` for something new. Tries one-for-one, one-for-two
 * and two-for-one with a handful of weighted picks and keeps whichever fills the
 * screen best (earlier, i.e. likelier, picks win ties). `keep` keys are never
 * taken out (the piece under the mouse).
 */
export function swapPiece<T>(list: T[], victim: number, c: Chooser<T>, W: number, H: number, rows: number, keep = new Set<string>()): T[] {
  const cand = candidates(list, c, 10);
  const ideal = idealCount(list, c, W, H, rows);
  const options: { list: T[]; s: number }[] = [];
  const add = (l: T[], bias: number) => options.push({ list: l, s: score(l, c, W, H, rows, ideal) + bias });
  const rep = (i: number, ins: T[], drop = 1) => [...list.slice(0, i), ...ins, ...list.slice(i + drop)];
  cand.forEach((x, k) => add(rep(victim, [x]), k * 0.0004));
  for (let p = 0; p < Math.min(4, cand.length); p++)
    for (let q = p + 1; q < Math.min(5, cand.length); q++) add(rep(victim, [cand[p], cand[q]]), (p + q) * 0.0004 + 0.001);
  // Two-for-one: also take out a neighbour (not one we must keep).
  const nb = [victim + 1, victim - 1].find((j) => j >= 0 && j < list.length && !keep.has(c.key(list[j])));
  if (nb != null && list.length > rows + 1)
    cand.slice(0, 5).forEach((x, k) => add(rep(Math.min(victim, nb), [x], 2), k * 0.0004 + 0.001));
  if (!options.length) return list;
  options.sort((x, y) => x.s - y.s);
  return options[0].list;
}

/** Pick a fresh screenful: add pieces until the rows are full, then polish the fit. */
export function chooseMosaic<T>(c: Chooser<T>, W: number, H: number, rows: number, start: T[] = []): T[] {
  const rnd = c.rnd ?? Math.random;
  let list = [...start];
  const rowAspect = W / ((H - MOSAIC_GAP * (rows - 1)) / rows);
  const need = rows * rowAspect;
  let sum = list.reduce((s, t) => s + clampAspect(c.aspect(t)), 0);
  while (sum < need * 0.97 || list.length < rows) {
    const t = candidates(list, c, 1)[0];
    if (!t) break;
    list.push(t);
    sum += clampAspect(c.aspect(t));
  }
  return polish(list, c, W, H, rows, rnd);
}

/** Small random swaps that make the fill better, until it is all but perfect. */
export function polish<T>(listIn: T[], c: Chooser<T>, W: number, H: number, rows: number, rnd = c.rnd ?? Math.random, tries = 40): T[] {
  let list = listIn;
  if (!list.length) return list;
  const ideal = idealCount(list, c, W, H, rows);
  let best = score(list, c, W, H, rows, ideal);
  for (let t = 0; t < tries && errorOf(list, c, W, H, rows) > 0.002; t++) {
    const next = swapPiece(list, Math.floor(rnd() * list.length), c, W, H, rows);
    const s = score(next, c, W, H, rows, ideal);
    if (s < best) { best = s; list = next; }
  }
  return list;
}
