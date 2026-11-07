import { describe, expect, it } from 'vitest';
import { buildShapes } from './shapes';
import { fitRectInOutline, fitRectInShape, insideOutline, outlineOf, type Outline } from './shapefit';
import { drawnRect, fitScale } from './flip';
import { normalize } from './presets';

const corners = (r: { x: number; y: number; w: number; h: number }) => [
  [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
  [r.x + r.w / 2, r.y], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h / 2], [r.x + r.w, r.y + r.h / 2],
];

describe('fit inside a shape', () => {
  it('a circle holds a square of side r·√2, centred', () => {
    const o: Outline = { kind: 'circle', cx: 50, cy: 50, r: 50 };
    const r = fitRectInOutline(o, 100, 100, 1)!;
    expect(r.w).toBeCloseTo(100 / Math.SQRT2, 0);
    expect(r.x + r.w / 2).toBeCloseTo(50, 3);
    for (const [x, y] of corners(r)) expect(insideOutline(o, x, y)).toBe(true);
  });

  it('a diamond holds a centred rectangle of half its size', () => {
    const o: Outline = { kind: 'poly', pts: [[50, 0], [100, 50], [50, 100], [0, 50]] };
    const r = fitRectInOutline(o, 100, 100, 1)!;
    expect(r.w).toBeCloseTo(50, 0);
    for (const [x, y] of corners(r)) expect(insideOutline(o, x, y)).toBe(true);
  });

  it('a tall video in a wide rectangle keeps its full height', () => {
    const o: Outline = { kind: 'rect', w: 400, h: 100 };
    const r = fitRectInOutline(o, 400, 100, 9 / 16)!;
    expect(r.h).toBeCloseTo(100, 5);
    expect(r.x).toBeCloseTo((400 - 56.25) / 2, 5);
  });

  it('a tall video in a wide polygon keeps its full height', () => {
    const o: Outline = { kind: 'poly', pts: [[0, 0], [400, 0], [400, 100], [0, 100]] };
    const r = fitRectInOutline(o, 400, 100, 9 / 16)!;
    expect(r.h).toBeGreaterThan(99);
  });

  it('every panel of every shaped layout gets a rectangle inside its outline', () => {
    for (const id of ['bullseye', 'diamond', 'wideDiamond', 'sunburst', 'waves', 'kaleidoscope', 'slices', 'pearls', 'foam']) {
      for (const sp of buildShapes(id, 1500, 840)) {
        const o = outlineOf(sp);
        for (const aspect of [16 / 9, 1, 9 / 16]) {
          const r = fitRectInShape(sp, aspect);
          if (!r) continue;
          expect(r.w / r.h).toBeCloseTo(aspect, 3);
          for (const [x, y] of corners(r)) expect(insideOutline(o, x, y, 1)).toBe(true);
        }
      }
    }
  });

  it('reads circles and polygons from the panel path', () => {
    const [circle, quad] = buildShapes('bullseye', 1500, 840);
    expect(outlineOf(circle).kind).toBe('circle');
    expect(outlineOf(quad).kind).toBe('poly');
  });
});

describe('original size', () => {
  it('never enlarges, but shrinks to fit', () => {
    expect(fitScale(1000, 1000, 200, 100, 'original')).toBe(1);
    expect(fitScale(100, 100, 200, 100, 'original')).toBe(0.5);
    const d = drawnRect(1000, 800, 200, 100, 'original');
    expect(d).toEqual({ left: 400, top: 350, width: 200, height: 100 });
  });

  it('old saved settings load with safe defaults', () => {
    const s = normalize({ fit: 'bogus' as never });
    expect(s.fit).toBe('contain');
    expect(s.blurBg).toBe(false);
    expect(s.repeatThis).toBe(false);
    expect(normalize({ fit: 'original', blurBg: true }).blurBg).toBe(true);
  });
});
