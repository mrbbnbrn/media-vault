import { describe, expect, it } from 'vitest';
import { collide, hallAt, layoutWing, pictureSize, planWings, yawOf, type MuseumItem, type Rect, type WingLayout } from './layout';

const item = (id: number, extra: Partial<MuseumItem> = {}): MuseumItem => ({
  id, name: `pic ${id}`, kind: 'image', width: id % 3 ? 1600 : 900, height: id % 3 ? 1000 : 1400, favourite: false, weight: 1, ...extra,
});
const many = (n: number, from = 1) => Array.from({ length: n }, (_, i) => item(from + i));

const overlap = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.01 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.01;

function wing(n: number, opts: Partial<{ hasPrev: boolean; hasNext: boolean }> = {}): WingLayout {
  const { featured, wings } = planWings(many(n).map((it) => (it.id % 10 === 0 ? { ...it, favourite: true } : it)));
  return layoutWing(wings[0], { featured, hasPrev: false, hasNext: false, ...opts });
}

describe('museum layout', () => {
  it('sizes pictures from their shape', () => {
    const land = pictureSize({ width: 1920, height: 1080 }, false);
    const port = pictureSize({ width: 1000, height: 1500 }, false);
    expect(land.w / land.h).toBeCloseTo(1920 / 1080, 2);
    expect(port.w / port.h).toBeCloseTo(1000 / 1500, 2);
    expect(port.h).toBeGreaterThan(port.w);
    const big = pictureSize({ width: 1920, height: 1080 }, true);
    expect(big.w).toBeGreaterThan(land.w);
    // Unknown size: a sensible landscape default; extreme panoramas are capped.
    expect(pictureSize({ width: null, height: null }, false).w).toBeGreaterThan(1);
    expect(pictureSize({ width: 10000, height: 100 }, false).w).toBeLessThanOrEqual(2.4);
  });

  it('hangs every item exactly once', () => {
    for (const n of [1, 5, 8, 9, 30, 119]) {
      const l = wing(n);
      const ids = l.frames.map((f) => f.item.id).sort((a, b) => a - b);
      expect(ids).toEqual(many(n).map((i) => i.id));
    }
  });

  it('puts favourites in the grand hall behind ropes', () => {
    const l = wing(40);
    const grand = l.frames.filter((f) => f.hall === 0);
    expect(grand.length).toBe(4);
    expect(grand.every((f) => f.item.favourite && f.featured && f.rope)).toBe(true);
    expect(l.ropes.length).toBe(4);
    expect(l.halls[0].grand).toBe(true);
  });

  it('small folders fit in the grand hall alone', () => {
    const l = wing(6);
    expect(l.halls.length).toBe(1);
    expect(l.frames.length).toBe(6);
    expect(l.doors.length).toBe(0);
  });

  it('halls never overlap and every frame is inside its hall', () => {
    const l = wing(119);
    expect(l.halls.length).toBeGreaterThan(5);
    for (let i = 0; i < l.halls.length; i++) for (let j = i + 1; j < l.halls.length; j++) expect(overlap(l.halls[i].rect, l.halls[j].rect)).toBe(false);
    for (const f of l.frames) {
      const r = l.halls[f.hall].rect;
      expect(f.at.x).toBeGreaterThanOrEqual(r.x0 - 0.01);
      expect(f.at.x).toBeLessThanOrEqual(r.x1 + 0.01);
      expect(f.at.y).toBeGreaterThanOrEqual(r.y0 - 0.01);
      expect(f.at.y).toBeLessThanOrEqual(r.y1 + 0.01);
      // Bottom of the frame above the panelling.
      expect(f.z - f.h / 2 - f.border).toBeGreaterThanOrEqual(1.19);
    }
  });

  it('frames on the same wall do not overlap and keep clear of doors', () => {
    const l = wing(119);
    const key = (f: (typeof l.frames)[number]) => `${f.normal.x},${f.normal.y},${f.normal.x ? f.at.x.toFixed(2) : f.at.y.toFixed(2)}`;
    const groups = new Map<string, typeof l.frames>();
    for (const f of l.frames) groups.set(key(f), [...(groups.get(key(f)) ?? []), f]);
    for (const list of groups.values()) {
      const along = (f: (typeof list)[number]) => (f.normal.x ? f.at.y : f.at.x);
      const sorted = [...list].sort((a, b) => along(a) - along(b));
      for (let i = 1; i < sorted.length; i++) {
        const gap = along(sorted[i]) - along(sorted[i - 1]) - (sorted[i].w / 2 + sorted[i].border + sorted[i - 1].w / 2 + sorted[i - 1].border);
        expect(gap).toBeGreaterThan(0.5);
      }
    }
    for (const d of l.doors) {
      for (const f of l.frames) {
        const dx = f.at.x - d.at.x;
        const dy = f.at.y - d.at.y;
        const sameWall = Math.abs(dx * d.inward.x + dy * d.inward.y) < 0.3;
        if (!sameWall) continue;
        const along = Math.abs(dx * d.along.x + dy * d.along.y);
        expect(along).toBeGreaterThan(d.width / 2 + f.w / 2);
      }
    }
  });

  it('connects halls with doors and adds wing doors when asked', () => {
    const l = wing(60, { hasPrev: true, hasNext: true });
    expect(l.doors.filter((d) => d.kind === 'pass').length).toBe(l.halls.length - 1);
    expect(l.doors.filter((d) => d.kind === 'prev').length).toBe(1);
    expect(l.doors.filter((d) => d.kind === 'next').length).toBe(1);
    // Coming back from the next wing you stand inside the last hall, facing away from the door.
    expect(hallAt(l, l.spawnBack)?.index).toBe(l.halls.length - 1);
    const next = l.doors.find((d) => d.kind === 'next')!;
    expect(l.spawnBack.yaw).toBeCloseTo(yawOf(next.inward), 5);
  });

  it('splits big folders into wings', () => {
    const items = many(1000);
    const { featured, wings } = planWings(items, 120);
    expect(wings.length).toBe(9);
    expect(featured.length + wings.reduce((s, w) => s + w.length, 0)).toBe(1000);
    expect(Math.max(...wings.map((w) => w.length))).toBeLessThanOrEqual(150);
  });

  it('picks the highest weighted when nothing is a favourite', () => {
    const items = many(40).map((it) => (it.id === 7 || it.id === 21 ? { ...it, weight: 5 } : it));
    const { featured } = planWings(items);
    expect(featured.map((i) => i.id).sort()).toEqual([21, 7]);
  });

  it('collision keeps the visitor out of walls but lets them through doors', () => {
    const l = wing(40);
    // Walking into the west wall of the grand hall.
    const p = collide({ x: -7.95, y: -10 }, 0.35, l);
    expect(p.x).toBeGreaterThanOrEqual(-8 + 0.15 + 0.35 - 1e-6);
    // Standing in the north doorway is fine.
    const door = l.doors.find((d) => d.kind === 'pass')!;
    const q = collide({ x: door.at.x, y: door.at.y }, 0.35, l);
    expect(Math.hypot(q.x - door.at.x, q.y - door.at.y)).toBeLessThan(1e-6);
    // Columns push you aside.
    const c = l.columns[0];
    const r = collide({ x: c.x + 0.1, y: c.y }, 0.35, l);
    expect(Math.hypot(r.x - c.x, r.y - c.y)).toBeGreaterThanOrEqual(c.r + 0.35 - 1e-6);
  });
});
