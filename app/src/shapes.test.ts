import { describe, expect, it } from 'vitest';
import { buildShapes, clipToRect, SHAPE_LAYOUTS } from './shapes';

describe('shaped layouts', () => {
  for (const l of SHAPE_LAYOUTS) {
    it(`${l.name} has ${l.count} panels inside the screen`, () => {
      for (const [W, H] of [[1920, 1080], [1280, 800], [800, 1000]]) {
        const ps = buildShapes(l.id, W, H);
        expect(ps).toHaveLength(l.count);
        for (const p of ps) {
          expect(p.box.w).toBeGreaterThan(1);
          expect(p.box.h).toBeGreaterThan(1);
          expect(p.d.startsWith('M')).toBe(true);
          expect(p.d).not.toMatch(/NaN|Infinity/);
          expect(p.anchor.x).toBeGreaterThanOrEqual(-1);
          expect(p.anchor.x).toBeLessThanOrEqual(W + 1);
        }
      }
    });
  }

  it('the whole screen is covered (no empty space)', () => {
    // Sample points; each must fall inside some panel's box at least.
    for (const l of SHAPE_LAYOUTS) {
      const ps = buildShapes(l.id, 1500, 840);
      for (let x = 5; x < 1500; x += 97) {
        for (let y = 5; y < 840; y += 53) {
          const hit = ps.some((p) => x >= p.box.x - 0.5 && x <= p.box.x + p.box.w + 0.5 && y >= p.box.y - 0.5 && y <= p.box.y + p.box.h + 0.5);
          expect(hit, `${l.id} at ${x},${y}`).toBe(true);
        }
      }
    }
  });

  it('clips polygons to the screen', () => {
    const p = clipToRect([[-10, -10], [50, -10], [50, 50], [-10, 50]], 40, 40);
    expect(Math.min(...p.map((q) => q[0]))).toBe(0);
    expect(Math.max(...p.map((q) => q[0]))).toBe(40);
  });
});
