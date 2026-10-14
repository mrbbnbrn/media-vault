import { describe, expect, it } from 'vitest';
import { layoutGrid, visibleRange } from './gridlayout';
import { boxesBetween, ENLARGE, enlargeBox, scrollForStrip, wantsMinimap, watchedShare } from './tilemaths';

describe('scroll preview', () => {
  it('shows only for grids longer than three screens', () => {
    expect(wantsMinimap(2999, 1000)).toBe(false);
    expect(wantsMinimap(3001, 1000)).toBe(true);
    expect(wantsMinimap(5000, 0)).toBe(false);
  });

  it('turns a strip point into a scroll position, centred and clamped', () => {
    expect(scrollForStrip(250, 500, 10000, 1000)).toBe(4500);
    expect(scrollForStrip(0, 500, 10000, 1000)).toBe(0);
    expect(scrollForStrip(600, 500, 10000, 1000)).toBe(9000);
  });

  it('finds the boxes inside a window', () => {
    const L = layoutGrid(Array.from({ length: 40 }, () => ({ width: 4, height: 3, kind: 'image' })), 400, 90, 'grid');
    const ids = boxesBetween(L.boxes, 0, 10, (a, b) => visibleRange(L.boxes, a, b));
    expect(ids).toEqual([0, 1, 2, 3]);
  });
});

describe('Alt enlarge', () => {
  const tile = { left: 400, top: 300, width: 200, height: 150 };

  it('grows the whole picture around the tile centre', () => {
    // A 4000×2000 photo, cropped left and right in a 4:3 tile.
    const r = enlargeBox(tile, 4000, 2000, 1600, 1000);
    expect(r.height).toBeCloseTo(150 * ENLARGE);
    expect(r.width).toBeCloseTo(r.height * 2);
    expect(r.left + r.width / 2).toBeCloseTo(500);
    expect(r.top + r.height / 2).toBeCloseTo(375);
  });

  it('stays inside the window', () => {
    const corner = enlargeBox({ left: 0, top: 0, width: 200, height: 200 }, 1000, 1000, 1200, 800);
    expect(corner.left).toBe(12);
    expect(corner.top).toBe(12);
    const big = enlargeBox({ left: 100, top: 100, width: 600, height: 600 }, 3000, 1000, 1000, 700);
    expect(big.width).toBeLessThanOrEqual(1000 - 24 + 1e-9);
    expect(big.left).toBeGreaterThanOrEqual(12);
    expect(big.left + big.width).toBeLessThanOrEqual(1000 - 12 + 1e-9);
  });

  it('blows small pictures up to twice their size at most', () => {
    const r = enlargeBox(tile, 160, 120, 1600, 1000);
    expect(r.width).toBeCloseTo(320);
    expect(r.height).toBeCloseTo(240);
  });

  it('uses the tile shape when the size is unknown', () => {
    const r = enlargeBox(tile, 0, 0, 1600, 1000);
    expect(r.width / r.height).toBeCloseTo(200 / 150);
    expect(r.width).toBeCloseTo(200 * ENLARGE);
  });
});

describe('progress lines', () => {
  it('only for long videos with a resume point', () => {
    expect(watchedShare('video', 600_000, 150_000)).toBe(0.25);
    expect(watchedShare('video', 100_000, 50_000)).toBeNull(); // short
    expect(watchedShare('video', 600_000, null)).toBeNull();
    expect(watchedShare('image', 600_000, 150_000)).toBeNull();
    expect(watchedShare('video', null, 150_000)).toBeNull();
    expect(watchedShare('video', 600_000, 900_000)).toBe(1);
  });
});
