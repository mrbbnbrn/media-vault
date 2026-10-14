import { describe, expect, it } from 'vitest';
import { layoutGrid, visibleRange } from './gridlayout';
import {
  averageColour, boxesBetween, loupeSpot, loupeZoom, objectPosition, scrollForStrip, stripRows, tileDraw, tilePoint, viewportBox, wantsMinimap, watchedShare,
} from './tilemaths';

describe('minimap', () => {
  it('shows only for grids longer than three screens', () => {
    expect(wantsMinimap(2999, 1000)).toBe(false);
    expect(wantsMinimap(3001, 1000)).toBe(true);
    expect(wantsMinimap(5000, 0)).toBe(false);
  });

  it('maps the viewport onto the strip', () => {
    expect(viewportBox(0, 1000, 10000, 500)).toEqual({ y: 0, h: 50 });
    expect(viewportBox(9000, 10000, 10000, 500)).toEqual({ y: 450, h: 50 });
    // Never thinner than 6 px, never outside.
    expect(viewportBox(1_999_000, 2_000_000, 2_000_000, 500)).toEqual({ y: 494, h: 6 });
  });

  it('turns a strip point into a scroll position, centred and clamped', () => {
    expect(scrollForStrip(250, 500, 10000, 1000)).toBe(4500);
    expect(scrollForStrip(0, 500, 10000, 1000)).toBe(0);
    expect(scrollForStrip(600, 500, 10000, 1000)).toBe(9000);
  });

  it('samples one tile row per canvas row for huge grids', () => {
    const items = Array.from({ length: 50_000 }, () => ({ width: 400, height: 300, kind: 'image' }));
    const L = layoutGrid(items, 1200, 190, 'grid');
    const t0 = performance.now();
    const rows = stripRows(800, L.height, (y) => visibleRange(L.boxes, y, y));
    const ms = performance.now() - t0;
    expect(rows.length).toBeGreaterThan(600); // some rows fall in the gaps
    expect(rows.length).toBeLessThanOrEqual(800);
    expect(rows[0].to - rows[0].from).toBe(6);
    expect(ms).toBeLessThan(200);
  });

  it('averages colours, ignoring transparent pixels', () => {
    expect(averageColour([255, 0, 0, 255, 0, 0, 255, 255])).toBe('rgb(128, 0, 128)');
    expect(averageColour([255, 255, 255, 0])).toBeNull();
    expect(averageColour([])).toBeNull();
  });

  it('finds the boxes inside a window', () => {
    const L = layoutGrid(Array.from({ length: 40 }, () => ({ width: 4, height: 3, kind: 'image' })), 400, 90, 'grid');
    const ids = boxesBetween(L.boxes, 0, 10, (a, b) => visibleRange(L.boxes, a, b));
    expect(ids).toEqual([0, 1, 2, 3]);
  });
});

describe('magnifier', () => {
  it('zooms with the wheel within 1.5×–6×', () => {
    expect(loupeZoom(3, -100)).toBe(3.6);
    expect(loupeZoom(3, 100)).toBe(2.5);
    expect(loupeZoom(5.9, -1)).toBe(6);
    expect(loupeZoom(1.6, 1)).toBe(1.5);
    expect(loupeZoom(2, 0)).toBe(2);
  });

  it('maps the cursor in a cropped tile to the picture', () => {
    // A 2:1 picture in a 4:3 tile, cropped left and right.
    const d = tileDraw(2000, 1000, 400, 300);
    expect(d).toEqual({ dw: 600, dh: 300, ox: -100, oy: 0 });
    expect(tilePoint(200, 150, d)).toEqual({ u: 0.5, v: 0.5 });
    expect(tilePoint(0, 0, d)).toEqual({ u: 100 / 600, v: 0 });
    // Shifted crop (face-aware tiles): object-position 0% shows the left edge.
    const left = tileDraw(2000, 1000, 400, 300, 'cover', 0, 0.5);
    expect(tilePoint(0, 0, left)).toEqual({ u: 0, v: 0 });
    // Outside the picture (letterboxed) is clamped.
    const c = tileDraw(1000, 1000, 400, 300, 'contain');
    expect(tilePoint(10, 10, c).u).toBe(0);
  });

  it('reads object-position', () => {
    expect(objectPosition('50% 30%')).toEqual({ px: 0.5, py: 0.3 });
    expect(objectPosition('')).toEqual({ px: 0.5, py: 0.5 });
    expect(objectPosition('left top')).toEqual({ px: 0.5, py: 0.5 });
  });

  it('keeps the loupe on screen', () => {
    expect(loupeSpot(500, 400, 240, 1000, 800)).toEqual({ left: 380, top: 280 });
    expect(loupeSpot(10, 10, 240, 1000, 800)).toEqual({ left: 0, top: 0 });
    expect(loupeSpot(995, 795, 240, 1000, 800)).toEqual({ left: 760, top: 560 });
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
