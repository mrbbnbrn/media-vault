import { describe, expect, it } from 'vitest';
import { mosaicPace, chooseMosaic, colourTarget, MAX_CROP, MOSAIC_GAP, normalizeMosaic, orderByColour, packMosaic, polish, swapPiece, type Box, type Chooser } from './mosaic';

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
    expect(normalizeMosaic(undefined)).toEqual({ size: 'normal', speed: 'normal', sound: false, colour: false });
    expect(normalizeMosaic({ size: 'big', speed: 'zoom', sound: true })).toEqual({ size: 'big', speed: 'normal', sound: true, colour: false });
    expect(normalizeMosaic({ size: 'small', colour: true }).colour).toBe(true);
    expect(normalizeMosaic({ colour: 'yes' }).colour).toBe(false);
  });
});

describe('mosaicPace', () => {
  it('keeps every piece about as long as asked, changing several at once when needed', () => {
    for (const [stay, n] of [[3.5, 15], [7, 15], [7, 30], [15, 12], [30, 8], [3.5, 4]]) {
      const { gap, count } = mosaicPace(stay, n);
      expect(gap).toBeGreaterThanOrEqual(0.9);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(n);
      // Each piece's time on screen: n / count changes, gap seconds apart.
      const life = (n / count) * gap;
      expect(life).toBeGreaterThan(stay * 0.6);
      expect(life).toBeLessThan(stay * 1.6);
    }
  });
});

describe('mosaic locks', () => {
  it('locked pieces survive swaps and polish', () => {
    const rnd = seeded(11);
    const pool = mixedPool(rnd);
    const c = chooser(pool, rnd);
    let list = chooseMosaic(c, 1920, 1080, 3);
    const keep = new Set([list[0].key, list[2].key, list[list.length - 1].key]);
    // Swapping a locked piece does nothing.
    expect(swapPiece(list, 0, c, 1920, 1080, 3, keep)).toBe(list);
    for (let t = 0; t < 80; t++) {
      list = swapPiece(list, Math.floor(rnd() * list.length), c, 1920, 1080, 3, keep);
      for (const k of keep) expect(list.some((p) => p.key === k)).toBe(true);
      if (t % 10 === 0) list = polish(list, c, 1920, 1080, 3, rnd, 40, keep);
    }
    for (const k of keep) expect(list.some((p) => p.key === k)).toBe(true);
    // A fresh screenful started from the locked pieces keeps them too.
    const start = pool.filter((p) => keep.has(p.key));
    const again = chooseMosaic(c, 1280, 720, 4, start, keep);
    for (const k of keep) expect(again.some((p) => p.key === k)).toBe(true);
    expect(checkFill(again.map((p) => p.a), 1280, 720, 4).error).toBeLessThan(MAX_CROP);
  });
});

describe('mosaic colour flow', () => {
  // Each piece a place on the rainbow (some still unknown).
  const withColour = (pool: P[], rnd: () => number) => new Map(pool.map((p) => [p.key, rnd() < 0.1 ? null : rnd()] as const));

  it('orders every row by colour without changing the fit', () => {
    const rnd = seeded(5);
    const pool = mixedPool(rnd);
    const col = withColour(pool, rnd);
    const c = { ...chooser(pool, rnd), colour: (p: P) => col.get(p.key) ?? null };
    for (const rows of [2, 3, 4]) {
      const list = chooseMosaic(c, 1920, 1080, rows);
      const fit = checkFill(list.map((p) => p.a), 1920, 1080, rows);
      expect(fit.error).toBeLessThan(0.02);
      const ends = [...fit.rowStarts.slice(1), list.length];
      fit.rowStarts.forEach((s, r) => {
        const known = list.slice(s, ends[r]).map((p) => col.get(p.key)).filter((v): v is number => v != null);
        expect(known).toEqual([...known].sort((a, b) => a - b));
      });
      // Sorting again changes nothing.
      expect(orderByColour(list, c, 1920, 1080, rows)).toEqual(list);
    }
  });

  it('swaps in pieces whose colour suits the spot, and still fills the screen', () => {
    const rnd = seeded(9);
    const pool = mixedPool(rnd, 300);
    const col = new Map(pool.map((p) => [p.key, rnd()] as const));
    const c = { ...chooser(pool, rnd), colour: (p: P) => col.get(p.key) ?? null };
    const plain = chooser(pool, rnd);
    let list = chooseMosaic(c, 1920, 1080, 3);
    let missColour = 0;
    let missPlain = 0;
    let worst = 0;
    for (let t = 0; t < 60; t++) {
      const v = Math.floor(rnd() * list.length);
      const target = colourTarget(list, v, c, 1920, 1080, 3)!;
      const before = new Set(list.map((p) => p.key));
      const next = swapPiece(list, v, c, 1920, 1080, 3);
      const ins = next.filter((p) => !before.has(p.key));
      missColour += ins.reduce((s, p) => s + Math.abs(col.get(p.key)! - target), 0) / Math.max(1, ins.length);
      const other = swapPiece(list, v, plain, 1920, 1080, 3).filter((p) => !before.has(p.key));
      missPlain += other.reduce((s, p) => s + Math.abs(col.get(p.key)! - target), 0) / Math.max(1, other.length);
      list = orderByColour(next, c, 1920, 1080, 3);
      worst = Math.max(worst, checkFill(list.map((p) => p.a), 1920, 1080, 3).error);
    }
    expect(missColour).toBeLessThan(missPlain * 0.6);
    expect(worst).toBeLessThan(MAX_CROP);
  });
});
