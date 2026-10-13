import { describe, expect, it } from 'vitest';
import { layoutGrid, monthGroups, visibleRange } from './gridlayout';

const pic = (w: number, h: number) => ({ width: w, height: h, kind: 'image' });

describe('grid layout', () => {
  it('equal tiles in grid mode', () => {
    const l = layoutGrid(Array.from({ length: 7 }, () => pic(100, 100)), 410, 100, 'grid');
    expect(l.boxes[0]).toMatchObject({ x: 0, y: 0 });
    expect(l.boxes[3]).toMatchObject({ x: 0 }); // 3 columns, the fourth wraps
    expect(l.boxes[3].y).toBeGreaterThan(0);
    expect(l.boxes[2].x + l.boxes[2].w).toBeCloseTo(410);
  });

  it('true shapes fill each row exactly, keeping each aspect ratio', () => {
    const items = [pic(400, 300), pic(300, 400), pic(1600, 900), pic(500, 500), pic(800, 600), pic(200, 600)];
    const l = layoutGrid(items, 800, 200, 'shape');
    const rows = new Map<number, number[]>();
    l.boxes.forEach((b, i) => rows.set(b.y, [...(rows.get(b.y) ?? []), i]));
    for (const [, idx] of [...rows].slice(0, -1)) {
      const last = l.boxes[idx[idx.length - 1]];
      expect(last.x + last.w).toBeCloseTo(800, 0);
    }
    l.boxes.forEach((b, i) => expect(b.w / b.h).toBeCloseTo(items[i].width! / items[i].height!, 3));
  });

  it('month headers and visible range', () => {
    const d = (y: number, m: number) => Date.UTC(y, m, 15) / 1000;
    const g = monthGroups([d(2026, 9), d(2026, 9), d(2026, 8), d(2025, 0)]);
    expect(g.map((x) => x.start)).toEqual([0, 2, 3]);
    const l = layoutGrid(Array.from({ length: 4 }, () => pic(4, 3)), 1000, 200, 'grid', g);
    expect(l.headers).toHaveLength(3);
    expect(l.boxes[2].y).toBeGreaterThan(l.headers[1].y);
    const many = layoutGrid(Array.from({ length: 1000 }, () => pic(4, 3)), 1000, 200, 'grid');
    const [a, b] = visibleRange(many.boxes, 5000, 5800);
    expect(a).toBeGreaterThan(0);
    expect(b - a).toBeLessThan(40);
    expect(many.boxes[a].y + many.boxes[a].h).toBeGreaterThanOrEqual(5000);
  });
});
