import { describe, expect, it } from 'vitest';
import {
  adjustPixels, anySeeThrough, apply, aspectRatio, dragCrop, editMatrix, editedName, fitAspect, frameSize, FULL, invert, isRotationOnly, isUnchanged,
  NO_ADJUST, NO_EDIT, outputSize, savedFormat, straightenScale, turnEdit, type Edit,
} from './imageedit';

const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], -Math.log10(eps)));

describe('turning, flipping and straightening', () => {
  it('leaves an unedited picture as it is', () => {
    close(editMatrix(400, 300, NO_EDIT), [1, 0, 0, 1, 0, 0]);
    expect(outputSize(400, 300, NO_EDIT)).toEqual({ w: 400, h: 300 });
    expect(isUnchanged(NO_EDIT)).toBe(true);
  });

  it('turns by quarter turns (the shape swaps) and flips in place', () => {
    const e: Edit = { ...NO_EDIT, quarter: 1 };
    expect(outputSize(200, 100, e)).toEqual({ w: 100, h: 200 });
    // A clockwise quarter turn: the top-left corner goes to the top right.
    close(apply(editMatrix(200, 100, e), 0, 0), [100, 0]);
    close(apply(editMatrix(200, 100, { ...NO_EDIT, flipH: true }), 0, 0), [200, 0]);
    close(apply(editMatrix(200, 100, { ...NO_EDIT, flipV: true }), 0, 0), [0, 100]);
    expect(isRotationOnly(e)).toBe(true);
    expect(isUnchanged(e)).toBe(false);
    expect(isRotationOnly({ ...e, flipH: true })).toBe(false);
  });

  it('shrinks a straightened picture just enough to hide the corners', () => {
    expect(straightenScale(400, 300, 0)).toBe(1);
    const k = straightenScale(400, 300, 10);
    expect(k).toBeLessThan(1);
    expect(straightenScale(400, 300, -10)).toBeCloseTo(k);
    expect(straightenScale(400, 300, 15)).toBeLessThan(k);
    expect(straightenScale(400, 300, 40)).toBeCloseTo(straightenScale(400, 300, 15), 9); // at most 15°
    for (const angle of [-15, -7.5, 3, 15]) {
      for (const quarter of [0, 1] as const) {
        const e: Edit = { ...NO_EDIT, angle, quarter };
        const out = outputSize(400, 300, e);
        const back = invert(editMatrix(400, 300, e));
        // Every corner of the result comes from inside the picture: no empty corner.
        for (const [x, y] of [[0, 0], [out.w, 0], [0, out.h], [out.w, out.h]]) {
          const [sx, sy] = apply(back, x, y);
          expect(sx).toBeGreaterThanOrEqual(-0.6);
          expect(sx).toBeLessThanOrEqual(400.6);
          expect(sy).toBeGreaterThanOrEqual(-0.6);
          expect(sy).toBeLessThanOrEqual(300.6);
        }
        // …and it is as big as it can be: one corner touches the edge.
        const touches = [[0, 0], [out.w, 0]].some(([x, y]) => {
          const [sx, sy] = apply(back, x, y);
          return Math.min(sx, sy, 400 - sx, 300 - sy) < 1;
        });
        expect(touches).toBe(true);
      }
    }
  });

  it('crops a part of the frame at full resolution', () => {
    const e: Edit = { ...NO_EDIT, crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 } };
    expect(outputSize(400, 300, e)).toEqual({ w: 200, h: 150 });
    close(apply(editMatrix(400, 300, e), 100, 150), [0, 0]);
    // Scaled down for the preview.
    close(apply(editMatrix(400, 300, e, 0.5), 300, 300), [100, 75]);
  });
});

describe('crop shapes', () => {
  const frame = { w: 400, h: 300 };
  it('fits each shape in the middle', () => {
    expect(fitAspect(null, frame)).toEqual(FULL);
    const sq = fitAspect(aspectRatio('1:1', frame), frame);
    expect(sq.w * 400).toBeCloseTo(300);
    expect(sq.h).toBeCloseTo(1);
    expect(sq.x).toBeCloseTo(0.125);
    const tall = fitAspect(aspectRatio('9:16', frame), frame);
    expect((tall.w * 400) / (tall.h * 300)).toBeCloseTo(9 / 16);
    expect(aspectRatio('original', frame)).toBeCloseTo(4 / 3);
    expect(aspectRatio('free', frame)).toBeNull();
    expect(fitAspect(aspectRatio('original', frame), frame)).toEqual(FULL);
  });

  it('drags corners, edges and the whole crop, inside the frame', () => {
    const c = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const moved = dragCrop(c, 'move', 1000, -1000, null, frame);
    expect(moved.x).toBeCloseTo(0.5);
    expect(moved.y).toBeCloseTo(0);
    expect(moved.w).toBeCloseTo(0.5);
    const se = dragCrop(c, 'se', 40, 30, null, frame);
    expect(se.w * 400).toBeCloseTo(240);
    expect(se.h * 300).toBeCloseTo(180);
    // Never smaller than the minimum, never outside.
    const tiny = dragCrop(c, 'w', 5000, 0, null, frame, 16);
    expect(tiny.w * 400).toBeCloseTo(16);
    const out = dragCrop(c, 'nw', -5000, -5000, null, frame);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it('keeps a fixed shape while dragging', () => {
    const ratio = 16 / 9;
    const c = fitAspect(ratio, frame);
    for (const [h, dx, dy] of [['se', -50, 0], ['nw', 30, 10], ['e', -60, 0], ['n', 0, 40], ['sw', 500, 500]] as const) {
      const d = dragCrop(c, h, dx, dy, ratio, frame);
      expect((d.w * 400) / (d.h * 300)).toBeCloseTo(ratio, 5);
      expect(d.x).toBeGreaterThanOrEqual(-1e-9);
      expect(d.y).toBeGreaterThanOrEqual(-1e-9);
      expect(d.x + d.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(d.y + d.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('fits the shape again after a quarter turn', () => {
    const e = turnEdit({ ...NO_EDIT, aspect: '16:9', crop: fitAspect(16 / 9, frameSize(400, 300, NO_EDIT)) }, 1, 400, 300);
    expect(e.quarter).toBe(1);
    const f = frameSize(400, 300, e);
    expect((e.crop.w * f.w) / (e.crop.h * f.h)).toBeCloseTo(16 / 9);
    expect(turnEdit(NO_EDIT, -1, 10, 10).quarter).toBe(3);
  });
});

describe('light and colour', () => {
  const pixels = () => new Uint8ClampedArray([200, 100, 50, 255, 10, 20, 30, 128, 128, 128, 128, 0]);
  it('changes nothing at zero', () => {
    const p = pixels();
    adjustPixels(p, 3, 1, NO_ADJUST);
    expect([...p]).toEqual([...pixels()]);
  });
  it('brightens, adds contrast, takes colour away, warms, and keeps see-through', () => {
    const p = pixels();
    adjustPixels(p, 3, 1, { ...NO_ADJUST, brightness: 50 });
    expect(p[0]).toBeGreaterThan(200);
    expect(p[4]).toBeGreaterThan(10);
    expect(p[7]).toBe(128);
    const c = pixels();
    adjustPixels(c, 3, 1, { ...NO_ADJUST, contrast: 60 });
    expect(c[0]).toBeGreaterThan(200);
    expect(c[4]).toBeLessThan(10);
    const g = pixels();
    adjustPixels(g, 3, 1, { ...NO_ADJUST, saturation: -100 });
    expect(Math.abs(g[0] - g[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(g[1] - g[2])).toBeLessThanOrEqual(1);
    const w = pixels();
    adjustPixels(w, 3, 1, { ...NO_ADJUST, warmth: 100 });
    expect(w[8]).toBeGreaterThan(128);
    expect(w[10]).toBeLessThan(128);
    expect(w[11]).toBe(0);
  });
  it('sharpens edges and leaves flat areas alone', () => {
    const flat = new Uint8ClampedArray(5 * 5 * 4).fill(100);
    adjustPixels(flat, 5, 5, { ...NO_ADJUST, sharpness: 100 });
    expect(flat.every((v) => v === 100)).toBe(true);
    const edge = new Uint8ClampedArray(4 * 3 * 4);
    for (let i = 0; i < 12; i++) {
      const v = i % 4 < 2 ? 50 : 200;
      edge.set([v, v, v, 255], i * 4);
    }
    adjustPixels(edge, 4, 3, { ...NO_ADJUST, sharpness: 100 });
    expect(edge[4 * 4 + 4]).toBeLessThan(50); // the dark side of the edge gets darker
    expect(edge[4 * 4 + 8]).toBeGreaterThan(200);
  });
});

describe('saving', () => {
  it('keeps JPEG as JPEG and PNG / see-through as PNG', () => {
    expect(savedFormat('a.JPG', false)).toMatchObject({ mime: 'image/jpeg', ext: 'jpg', quality: 0.95 });
    expect(savedFormat('a.png', false)).toMatchObject({ mime: 'image/png', ext: 'png' });
    expect(savedFormat('a.webp', true).ext).toBe('png');
    expect(savedFormat('a.webp', false).ext).toBe('jpg');
    expect(editedName('Beach day.jpeg', 'jpg')).toBe('Beach day (edited).jpg');
    expect(anySeeThrough(new Uint8ClampedArray([1, 2, 3, 255]))).toBe(false);
    expect(anySeeThrough(new Uint8ClampedArray([1, 2, 3, 255, 0, 0, 0, 254]))).toBe(true);
  });
});
