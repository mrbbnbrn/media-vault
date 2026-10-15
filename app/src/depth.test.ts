import { describe, expect, it } from 'vitest';
import { parseDepth } from './api';
import { cropScale, DOLLY, pickPath, pivotOf, poseAt, progress, SHIFT, shiftUv, type DepthPath } from './depth';
import { normalize } from './presets';

const paths: DepthPath[] = [
  { kind: 'orbit', angle: 0.3, turn: 1 },
  { kind: 'orbit', angle: Math.PI, turn: -1 },
  { kind: 'swing', angle: -0.2, turn: 1 },
  { kind: 'dolly', angle: 2.5, turn: 1 },
];

describe('3D photos: camera path', () => {
  it('starts and ends exactly as the still picture, with no speed', () => {
    for (const p of paths) {
      for (const u of [0, 1, -0.5, 1.5]) expect(poseAt(u, p)).toEqual({ x: expect.closeTo(0, 9), y: expect.closeTo(0, 9), dolly: expect.closeTo(0, 9) });
      const a = poseAt(0.002, p);
      expect(Math.hypot(a.x, a.y)).toBeLessThan(SHIFT * 0.001);
    }
  });

  it('moves only a few per cent, and smoothly', () => {
    for (const p of paths) {
      let prev = poseAt(0, p);
      let most = 0;
      for (let i = 1; i <= 400; i++) {
        const q = poseAt(i / 400, p);
        most = Math.max(most, Math.hypot(q.x, q.y));
        expect(Math.hypot(q.x - prev.x, q.y - prev.y)).toBeLessThan(SHIFT * 0.05);
        expect(q.dolly).toBeGreaterThanOrEqual(-1e-9);
        expect(q.dolly).toBeLessThanOrEqual(DOLLY + 1e-9);
        prev = q;
      }
      expect(most).toBeLessThan(0.04);
      expect(most + poseAt(0.5, p).dolly).toBeGreaterThan(0.005);
    }
  });

  it('picks every kind of path, mostly sideways', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = pickPath(rand);
      kinds.add(p.kind);
      expect(Math.abs(Math.cos(p.angle))).toBeGreaterThan(0.85);
    }
    expect([...kinds].sort()).toEqual(['dolly', 'orbit', 'swing']);
  });

  it('moves the same in pixels both ways', () => {
    const s = shiftUv({ x: 0.02, y: 0.02, dolly: 0 }, 2000, 1000);
    expect(s.x * 2000).toBeCloseTo(s.y * 1000);
    expect(s.y).toBeCloseTo(0.02);
  });

  it('enlarges just enough that the edges never show', () => {
    expect(cropScale({ x: 0, y: 0 }, 0, 0.5)).toBe(1);
    const k = cropScale({ x: 0.02, y: 0.01 }, 0.05, 0.7);
    // The furthest any sample moves: (0.02 + 0.05 / 2) × 0.7 = 0.0315, on each side.
    expect(k).toBeCloseTo(1 / (1 - 2 * 0.0315));
    expect(k).toBeLessThan(1.08);
  });

  it('keeps the middle of the picture still', () => {
    const w = 64;
    const data = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data[y * w + x] = x > 16 && x < 48 && y > 16 && y < 48 ? 204 : 20;
    expect(pivotOf({ w, h: w, data })).toBeCloseTo(0.8, 1);
    expect(pivotOf({ w, h: w, data: new Uint8Array(w * w) })).toBe(0.25);
    expect(pivotOf({ w: 0, h: 0, data: new Uint8Array() })).toBe(0.5);
  });

  it('times the movement to the picture', () => {
    expect(progress(500, 0, 1000)).toBe(0.5);
    expect(progress(1500, 500, 2500)).toBe(0.5);
    expect(progress(5, 10, 10)).toBe(1);
  });
});

describe('3D photos: depth maps and the setting', () => {
  it('reads what the app sends back', () => {
    const b = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 7, 9]);
    const m = parseDepth(b.buffer);
    expect([m.w, m.h, [...m.data]]).toEqual([2, 1, [7, 9]]);
    expect(() => parseDepth(new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 7]))).toThrow();
    expect(() => parseDepth(new Uint8Array(3))).toThrow();
  });

  it('is off unless chosen', () => {
    expect(normalize({}).depth3d).toBe(false);
    expect(normalize({ depth3d: true }).depth3d).toBe(true);
    expect(normalize({ depth3d: 'yes' as unknown as boolean }).depth3d).toBe(false);
  });
});
