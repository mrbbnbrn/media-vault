import { describe, expect, it } from 'vitest';
import { chooseMosaic, MAX_CROP, MOSAIC_GAP, normalizeMosaic, packMosaic, swapPiece, type Box, type Chooser } from './mosaic';

/** Small seeded random, so the tests are the same every run. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Checks every box: inside the screen, no overlaps, rows span the full width, and the rows fill the height. */
function checkFill(aspects: number[], W: number, H: number, rows: number, maxCrop = MAX_CROP) {
  const fit = packMosaic(aspects, W, H, rows);
  expect(fit.boxes).toHaveLength(aspects.length);
  for (const b of fit.boxes) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(W);
    expect(b.y + b.h).toBeLessThanOrEqual(H);
  }
  for (let i = 0; i < fit.boxes.length; i++)
    for (let j = i + 1; j < fit.boxes.length; j++) expect(overlap(fit.boxes[i], fit.boxes[j])).toBe(false);
  // Shapes kept (up to the small trim).
  fit.boxes.forEach((b, i) => expect(Math.abs(b.w / b.h / aspects[i] - 1)).toBeLessThan(maxCrop + 0.012)); // + pixel rounding
  // Each row: starts at 0, ends at W, gaps of MOSAIC_GAP (±1 for rounding).
  const ends = [...fit.rowStarts.slice(1), aspects.length];
  fit.rowStarts.forEach((s, k) => {
    const row = fit.boxes.slice(s, ends[k]);
    expect(row[0].x).toBe(0);
    expect(row[row.length - 1].x + row[row.length - 1].w).toBe(W);
    row.slice(1).forEach((b, i) => expect(Math.abs(b.x - (row[i].x + row[i].w) - MOSAIC_GAP)).toBeLessThanOrEqual(1));
    row.forEach((b) => { expect(b.y).toBe(row[0].y); expect(b.h).toBe(row[0].h); });
  });
  // Rows stack from top to bottom with even gaps.
  const tops = fit.rowStarts.map((s) => fit.boxes[s]);
  expect(tops[0].y).toBe(0);
  expect(tops[tops.length - 1].y + tops[tops.length - 1].h).toBe(H);
  tops.slice(1).forEach((b, i) => expect(Math.abs(b.y - (tops[i].y + tops[i].h) - MOSAIC_GAP)).toBeLessThanOrEqual(1));
  // The covered area is everything but the gaps.
  const area = fit.boxes.reduce((s, b) => s + b.w * b.h, 0);
  const gapArea = (fit.rowStarts.length - 1) * MOSAIC_GAP * W + fit.boxes.length * MOSAIC_GAP * (H / fit.rowStarts.length);
  expect(area).toBeGreaterThan(W * H - gapArea - W * 4);
  return fit;
}

interface P { key: string; a: number; w?: number }
const chooser = (pool: P[], rnd: () => number): Chooser<P> => ({
  key: (p) => p.key,
  aspect: (p) => p.a,
  rnd,
  pick: (ex) => {
    const list = pool.filter((p) => !ex.has(p.key) && (p.w ?? 1) > 0);
    return list.length ? list[Math.floor(rnd() * list.length)] : null;
  },
});
const mixedPool = (rnd: () => number, n = 120): P[] =>
  Array.from({ length: n }, (_, i) => ({ key: `k${i}`, a: [9 / 16, 1, 16 / 9, 4 / 3, 3 / 4, 2.35, 2 / 3][Math.floor(rnd() * 7)] * (0.9 + rnd() * 0.2) }));

describe('mosaic packing', () => {
  it('fills exactly when the pieces fit perfectly (equal squares)', () => {
    // 3 rows of 4 squares: row height = (W - 3 gaps) / 4.
    const W = 1204;
    const h = (W - 3 * MOSAIC_GAP) / 4;
    const H = Math.round(3 * h + 2 * MOSAIC_GAP);
    const fit = checkFill(new Array(12).fill(1), W, H, 3, 0.005);
    expect(fit.rowStarts).toEqual([0, 4, 8]);
    expect(fit.error).toBeLessThan(0.002);
  });

  it('keeps every piece in its own shape, no overlaps, at several screen sizes', () => {
    const rnd = seeded(7);
    for (const [W, H] of [[1920, 1080], [1280, 720], [2560, 1080], [1080, 1920]] as const)
      for (const rows of [2, 3, 4]) {
        const c = chooser(mixedPool(rnd), rnd);
        const list = chooseMosaic(c, W, H, rows);
        const fit = checkFill(list.map((p) => p.a), W, H, rows);
        expect(fit.rowStarts).toHaveLength(rows);
        expect(fit.error).toBeLessThan(0.02); // chosen pieces fit almost perfectly
      }
  });

  it('still fills after many swaps', () => {
    const rnd = seeded(42);
    const pool = mixedPool(rnd);
    const c = chooser(pool, rnd);
    let list = chooseMosaic(c, 1920, 1080, 3);
    let worst = 0;
    for (let t = 0; t < 60; t++) {
      list = swapPiece(list, Math.floor(rnd() * list.length), c, 1920, 1080, 3);
      expect(new Set(list.map((p) => p.key)).size).toBe(list.length); // no repeats on screen
      worst = Math.max(worst, checkFill(list.map((p) => p.a), 1920, 1080, 3).error);
    }
    expect(worst).toBeLessThan(MAX_CROP);
  });

  it('never picks weight 0 and copes with very few pieces', () => {
    const rnd = seeded(3);
    const c = chooser([{ key: 'a', a: 1 }, { key: 'b', a: 0.5 }, { key: 'z', a: 1, w: 0 }], rnd);
    const list = chooseMosaic(c, 1920, 1080, 3);
    expect(list.map((p) => p.key).sort()).toEqual(['a', 'b']);
    const fit = packMosaic(list.map((p) => p.a), 1920, 1080, 3);
    expect(fit.crop).toBeLessThanOrEqual(MAX_CROP + 1e-9); // never trims more than allowed, even when it cannot fill
    expect(packMosaic([], 100, 100, 3).boxes).toEqual([]);
  });

  it('old or odd saved settings fall back to the default', () => {
    expect(normalizeMosaic(undefined)).toEqual({ size: 'normal', speed: 'normal', sound: false });
    expect(normalizeMosaic({ size: 'big', speed: 'zoom', sound: true })).toEqual({ size: 'big', speed: 'normal', sound: true });
  });
});
