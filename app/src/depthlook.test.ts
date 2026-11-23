import { describe, expect, it } from 'vitest';
import {
  borderPx, borderRoom, depthAtPoint, depthSpread, depthTexture, FLAT_SPREAD, focusPullAt, focusPullMoving, leanOfShift, lightDir,
  wiggleOptions, wigglePose, wiggleSequence, wiggleViewPose,
} from './depthlook';
import { cropScale, framePose, SHIFT } from './depth';

const map = (w: number, h: number, f: (x: number, y: number) => number) => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(f(x, y));
  return { w, h, data };
};

describe('depth light texture', () => {
  it('keeps the depth in red and faces a flat picture to the camera', () => {
    const t = depthTexture(map(20, 10, () => 90));
    expect(t[0]).toBe(90);
    for (let i = 0; i < 200; i++) {
      expect(Math.abs(t[i * 4 + 1] - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(t[i * 4 + 2] - 128)).toBeLessThanOrEqual(1);
      expect(t[i * 4 + 3]).toBe(0);
    }
  });
  it('a slope nearer on the right faces left; a cliff counts as no surface', () => {
    const slope = depthTexture(map(40, 20, (x) => 60 + x * 0.8));
    const mid = (20 * 10 + 20) * 4;
    expect(slope[mid + 1]).toBeLessThan(118);
    expect(Math.abs(slope[mid + 2] - 128)).toBeLessThanOrEqual(1);
    const cliff = depthTexture(map(40, 20, (x) => (x < 20 ? 40 : 220)));
    const at = (10 * 40 + 20) * 4;
    expect(Math.abs(cliff[at + 1] - 128)).toBeLessThanOrEqual(2);
  });
  it('a smooth hollow (farther than around it) is a crease; a hard step is not (no halo round near things)', () => {
    const t = depthTexture(map(400, 400, (x, y) => 130 - 20 * Math.exp(-((x - 200) ** 2 + (y - 200) ** 2) / (2 * 15 * 15))));
    expect(t[(200 * 400 + 200) * 4 + 3]).toBeGreaterThan(30);
    expect(t[(20 * 400 + 20) * 4 + 3]).toBe(0);
    const step = depthTexture(map(200, 200, (x) => (x < 100 ? 40 : 220)));
    for (const x of [90, 95, 99]) expect(step[(100 * 200 + x) * 4 + 3]).toBe(0);
  });
});

describe('flat pictures and the depth under a point', () => {
  it('a flat map has no spread, a real one does', () => {
    expect(depthSpread(map(30, 30, () => 120))).toBeLessThan(FLAT_SPREAD);
    expect(depthSpread(map(30, 30, (x) => x * 8))).toBeGreaterThan(0.5);
  });
  it('averages a small spot', () => {
    const m = map(100, 100, (x) => (x < 50 ? 0 : 255));
    expect(depthAtPoint(m, 0.1, 0.5)).toBe(0);
    expect(depthAtPoint(m, 0.9, 0.5)).toBe(1);
    const edge = depthAtPoint(m, 0.5, 0.5);
    expect(edge).toBeGreaterThan(0.3);
    expect(edge).toBeLessThan(0.7);
  });
});

describe('focus pull', () => {
  it('stays on the target when off; pulls from far to near at the start', () => {
    expect(focusPullAt('off', 0, 1.5, 0.8, 0.1)).toBe(0.8);
    expect(focusPullAt('start', 0, 1.5, 0.8, 0.1)).toBeCloseTo(0.1);
    expect(focusPullAt('start', 5000, 1.5, 0.8, 0.1)).toBeCloseTo(0.8);
    expect(focusPullMoving('start', 5000, 1.5)).toBe(false);
    expect(focusPullMoving('start', 500, 1.5)).toBe(true);
  });
  it('swings back and forth', () => {
    expect(focusPullAt('swing', 1500, 1.5, 0.8, 0.1)).toBeCloseTo(0.8);
    expect(focusPullAt('swing', 4500, 1.5, 0.8, 0.1)).toBeCloseTo(0.1);
    expect(focusPullMoving('swing', 99999, 1.5)).toBe(true);
  });
});

describe('depth light direction', () => {
  it('comes from the camera when it is in the middle', () => {
    const [x, y, z] = lightDir('camera', { x: 0, y: 0 }, 'left', 0);
    expect([x, y]).toEqual([0, 0]);
    expect(z).toBeCloseTo(1);
  });
  it('a fixed side, unit length', () => {
    const [x, y, z] = lightDir('fixed', { x: 0, y: 0 }, 'left', 0);
    expect(x).toBeLessThan(-0.5);
    expect(y).toBe(0);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1);
  });
  it('the camera is opposite to the picture shift', () => {
    expect(leanOfShift({ x: SHIFT, y: 0 }, 1).x).toBeLessThan(0);
    expect(leanOfShift({ x: 0, y: -SHIFT }, 1).y).toBeGreaterThan(0);
  });
});

describe('wiggle', () => {
  it('orders the views back and forth or round', () => {
    expect(wiggleSequence(3, 'bounce')).toEqual([0, 1, 2, 1]);
    expect(wiggleSequence(4, 'bounce')).toEqual([0, 1, 2, 3, 2, 1]);
    expect(wiggleSequence(3, 'round')).toEqual([0, 1, 2]);
    expect(wiggleSequence(2, 'bounce')).toEqual([0, 1]);
  });
  it('reads the settings safely and caps the speed', () => {
    const o = wiggleOptions({ depthWiggleViews: 9, depthWiggleSpeed: 40, depthWiggleOrder: 'x', depthWiggleDir: 'updown' });
    expect(o).toEqual({ views: 4, speed: 8, order: 'bounce', dir: 'updown', smooth: false });
  });
  it('views spread evenly around the middle; jumps on time', () => {
    const o = wiggleOptions({ depthWiggleViews: 3, depthWiggleSpeed: 5 });
    expect(wiggleViewPose(1, o, 1).x).toBeCloseTo(0);
    expect(wiggleViewPose(0, o, 1).x).toBeCloseTo(-wiggleViewPose(2, o, 1).x);
    expect(wigglePose(0, o, 1)).toEqual(wiggleViewPose(0, o, 1));
    expect(wigglePose(210, o, 1)).toEqual(wiggleViewPose(1, o, 1));
    expect(wigglePose(610, o, 1)).toEqual(wiggleViewPose(1, o, 1));
    expect(wigglePose(810, o, 1)).toEqual(wiggleViewPose(0, o, 1));
  });
  it('glides with smooth step', () => {
    const o = { ...wiggleOptions({ depthWiggleViews: 2 }), smooth: true };
    const a = wiggleViewPose(0, o, 1).x;
    const b = wiggleViewPose(1, o, 1).x;
    const mid = wigglePose(200 + 20, o, 1).x;
    expect(mid).toBeGreaterThan(Math.min(a, b));
    expect(mid).toBeLessThan(Math.max(a, b));
  });
});

describe('border fill room', () => {
  it('measures the border on the short side', () => {
    expect(borderPx(1000, 500, 0.08)).toBe(40);
    expect(borderRoom(1000, 500, 0.08)).toEqual({ x: 0.04, y: 0.08 });
    expect(borderPx(1000, 500, 99)).toBe(75);
  });
  it('less zoom: the picture is enlarged less (never below its size)', () => {
    const shift = { x: 0.03, y: 0 };
    expect(cropScale(shift, 0, 0.5, 0.04)).toBeLessThan(cropScale(shift, 0, 0.5));
    expect(cropScale(shift, 0, 0.5, 0.2)).toBe(1);
    const pose = { x: SHIFT, y: 0, dolly: 0 };
    const plain = framePose(pose, 800, 600, 0.5);
    const room = framePose(pose, 800, 600, 0.5, { x: 0.08, y: 0.08, use: 'zoom' });
    expect(room.shift).toEqual(plain.shift);
    expect(room.scale).toBeLessThan(plain.scale);
  });
  it('bigger moves: the camera goes further', () => {
    const pose = { x: SHIFT, y: 0, dolly: 0 };
    const plain = framePose(pose, 800, 600, 0.5);
    const moves = framePose(pose, 800, 600, 0.5, { x: 0.08, y: 0.08, use: 'moves' });
    expect(moves.shift.x).toBeCloseTo(plain.shift.x * 3);
  });
});
