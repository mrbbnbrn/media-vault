import { describe, expect, it } from 'vitest';
import { buildShapes, clipToRect, LAYOUTS, MAX_PANELS, SHAPE_GROUPS, SHAPE_LAYOUTS } from './shapes';

// Area of a flat polygon outline ("M x y L x y … Z").
const polyArea = (d: string) => {
  const pts = d.replace(/[MZ]/g, '').split('L').map((q) => q.trim().split(/\s+/).map(Number));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

describe('shaped layouts', () => {
  for (const l of SHAPE_LAYOUTS) {
    it(`${l.name} has ${l.count} panels inside the screen`, () => {
      for (const [W, H] of [[1920, 1080], [1280, 720], [2560, 1080], [1280, 800], [800, 1000]]) {
        const ps = buildShapes(l.id, W, H);
        expect(ps).toHaveLength(l.count);
        for (const p of ps) {
          expect(p.box.w).toBeGreaterThan(1);
          expect(p.box.h).toBeGreaterThan(1);
          expect(p.d.startsWith('M')).toBe(true);
          expect(p.d).not.toMatch(/NaN|Infinity/);
          expect(p.anchor.x).toBeGreaterThanOrEqual(-1);
          expect(p.anchor.x).toBeLessThanOrEqual(W + 1);
          expect(p.box.x).toBeGreaterThanOrEqual(-0.5);
          expect(p.box.y).toBeGreaterThanOrEqual(-0.5);
          expect(p.box.x + p.box.w).toBeLessThanOrEqual(W + 0.5);
          expect(p.box.y + p.box.h).toBeLessThanOrEqual(H + 0.5);
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

  it('tiled layouts cover the screen exactly once (areas add up)', () => {
    // Layouts made only of flat polygons on one level don't overlap, so their areas sum to the screen.
    let tiled = 0;
    for (const l of SHAPE_LAYOUTS) {
      for (const [W, H] of [[1920, 1080], [1280, 720], [2560, 1080]]) {
        const ps = buildShapes(l.id, W, H);
        if (!ps.every((p) => /^M[-\d. L]+Z$/.test(p.d) && p.z === ps[0].z)) continue;
        tiled++;
        const sum = ps.reduce((t, p) => t + polyArea(p.d), 0);
        expect(Math.abs(sum - W * H) / (W * H), `${l.id} at ${W}x${H}`).toBeLessThan(0.002);
      }
    }
    expect(tiled).toBeGreaterThan(40);
  });

  it('overlapping layouts have a full screen of panels underneath', () => {
    for (const l of SHAPE_LAYOUTS) {
      const ps = buildShapes(l.id, 1920, 1080);
      if (ps.every((p) => p.z === ps[0].z)) continue;
      const low = Math.min(...ps.map((p) => p.z));
      const under = ps.filter((p) => p.z === low);
      expect(under.every((p) => /^M[-\d. L]+Z$/.test(p.d)), l.id).toBe(true);
      expect(Math.abs(under.reduce((t, p) => t + polyArea(p.d), 0) - 1920 * 1080), l.id).toBeLessThan(1920 * 1080 * 0.002);
    }
  });

  it('groups list every shape layout once, with sensible counts', () => {
    const ids = SHAPE_GROUPS.flatMap((g) => g.layouts.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(SHAPE_LAYOUTS.map((l) => l.id));
    expect(new Set(LAYOUTS.map((l) => l.id)).size).toBe(LAYOUTS.length);
    for (const g of SHAPE_GROUPS) expect(g.layouts.length, g.name).toBeGreaterThan(0);
    for (const l of SHAPE_LAYOUTS) expect(l.count).toBeLessThanOrEqual(14);
    expect(MAX_PANELS).toBe(Math.max(...LAYOUTS.map((l) => l.count)));
  });

  it('rounded windows use arcs and stay inside their box', () => {
    for (const id of ['pip1', 'pip4', 'roundTiles', 'capsules']) {
      for (const p of buildShapes(id, 1920, 1080).filter((q) => q.d.includes('A'))) {
        const nums = p.d.replace(/[MLAZ]/g, ' ').trim().split(/\s+/).map(Number);
        expect(Math.max(...nums)).toBeLessThanOrEqual(Math.max(p.box.w, p.box.h) + 0.01);
      }
    }
  });

  it('clips polygons to the screen', () => {
    const p = clipToRect([[-10, -10], [50, -10], [50, 50], [-10, 50]], 40, 40);
    expect(Math.min(...p.map((q) => q[0]))).toBe(0);
    expect(Math.max(...p.map((q) => q[0]))).toBe(40);
  });
});
