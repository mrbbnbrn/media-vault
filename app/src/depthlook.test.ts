import { describe, expect, it } from 'vitest';
import {
  borderPx, borderRoom, depthAtPoint, depthSpread, FLAT_SPREAD, focusPullAt, focusPullMoving,
  wiggleOptions, wigglePose, wiggleSequence, wiggleViewPose,
} from './depthlook';
import { cropScale, framePose, SHIFT } from './depth';

const map = (w: number, h: number, f: (x: number, y: number) => number) => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(f(x, y));
  return { w, h, data };
};

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
