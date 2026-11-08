import { describe, expect, it } from 'vitest';
import { echoAmounts, echoLook, foldPoint, lookArea, lookCanvasSize, mirrorLook, mirrorMotion, mirrorSource, reflect, unturn } from './looks';

describe('looks', () => {
  it('reads saved values safely', () => {
    expect(mirrorLook('six')).toBe('six');
    expect(mirrorLook('nope')).toBe('off');
    expect(mirrorLook(undefined)).toBe('off');
    expect(echoLook('strong')).toBe('strong');
    expect(echoLook(3)).toBe('off');
  });

  it('folds two sides and four ways', () => {
    expect(foldPoint('two', -3, 4)).toEqual([3, 4]);
    expect(foldPoint('four', -3, -4)).toEqual([3, 4]);
    expect(foldPoint('off', -3, -4)).toEqual([-3, -4]);
  });

  it('folds six slices into the first slice, mirrored alike', () => {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * 2 * Math.PI + 0.01;
      const [x, y] = foldPoint('six', 5 * Math.cos(a), 5 * Math.sin(a));
      const fa = Math.atan2(y, x);
      expect(Math.hypot(x, y)).toBeCloseTo(5);
      expect(fa).toBeGreaterThanOrEqual(-1e-9);
      expect(fa).toBeLessThanOrEqual(Math.PI / 3 + 1e-9);
    }
    // Mirror images either side of a slice edge land on the same point.
    const e = Math.PI / 3;
    const p = foldPoint('six', Math.cos(e + 0.2), Math.sin(e + 0.2));
    const q = foldPoint('six', Math.cos(e - 0.2), Math.sin(e - 0.2));
    expect(p[0]).toBeCloseTo(q[0]);
    expect(p[1]).toBeCloseTo(q[1]);
  });

  it('bounces values back inside a range', () => {
    expect(reflect(5, 0, 10)).toBe(5);
    expect(reflect(12, 0, 10)).toBe(8);
    expect(reflect(-3, 0, 10)).toBe(3);
    expect(reflect(23, 0, 10)).toBe(3);
    expect(reflect(4, 2, 2)).toBe(2);
  });

  it('keeps every source point inside the picture, moving slowly', () => {
    for (const mode of ['two', 'four', 'six'] as const) {
      for (let t = 0; t < 200; t += 7.3) {
        for (const [x, y] of [[-400, -300], [400, 300], [0, 0], [123, -45]]) {
          const [sx, sy] = mirrorSource(mode, x, y, t, 400, 300);
          expect(Math.abs(sx)).toBeLessThanOrEqual(400);
          expect(Math.abs(sy)).toBeLessThanOrEqual(300);
        }
      }
      // Slow: a twentieth of a second moves the window by under a pixel or two.
      const a = mirrorMotion(mode, 10, 400, 300);
      const b = mirrorMotion(mode, 10.05, 400, 300);
      expect(Math.abs(a.dx - b.dx)).toBeLessThan(2);
      expect(Math.abs(a.angle - b.angle)).toBeLessThan(0.01);
    }
  });

  it('has a gentler trail for Light than for Strong', () => {
    expect(echoAmounts('light').take).toBeGreaterThan(echoAmounts('strong').take);
    expect(echoAmounts('off')).toEqual({ take: 1, show: 0 });
  });

  it('maps a turned video box back to the frame', () => {
    expect(unturn(0, 0.2, 0.3)).toEqual([0.2, 0.3]);
    // The frame's top left shows at the top right after a quarter turn clockwise.
    expect(unturn(1, 1, 0)).toEqual([0, 0]);
    expect(unturn(2, 1, 1)).toEqual([0, 0]);
    expect(unturn(3, 0, 1)).toEqual([0, 0]);
  });

  it('covers the shown part of the media only', () => {
    expect(lookArea({ left: 100, top: 0, width: 400, height: 300 }, 600, 300)).toEqual({ left: 100, top: 0, width: 400, height: 300 });
    expect(lookArea({ left: -50, top: -20, width: 700, height: 340 }, 600, 300)).toEqual({ left: 0, top: 0, width: 600, height: 300 });
    expect(lookArea({ left: 0, top: 0, width: 1, height: 300 }, 600, 300)).toBeNull();
  });

  it('caps the canvas size', () => {
    expect(lookCanvasSize(800, 600, 2)).toEqual({ w: 1600, h: 1200 });
    expect(lookCanvasSize(3840, 2160, 1.5)).toEqual({ w: 2560, h: 1440 });
  });
});
