import { describe, expect, it } from 'vitest';
import type { DepthMap, SubjectMask } from './api';
import { composeFore, composePlate, holeSquare, resizeRgba } from './platemath';

const W = 48;
const inSq = (x: number, y: number) => x >= 16 && x < 32 && y >= 16 && y < 32;
const mask: SubjectMask = { w: W, h: W, data: Uint8Array.from({ length: W * W }, (_, i) => (inSq(i % W, Math.floor(i / W)) ? 255 : 0)) };
const depth: DepthMap = { w: W, h: W, data: Uint8Array.from({ length: W * W }, (_, i) => (inSq(i % W, Math.floor(i / W)) ? 220 : 50)) };
const orig = new Uint8ClampedArray(W * W * 4);
for (let i = 0; i < W * W; i++) orig.set(inSq(i % W, Math.floor(i / W)) ? [200, 0, 0, 255] : [0, 0, 200, 255], i * 4);

describe('3D picture layers maths', () => {
  it('the plate fills the subject in from around it, colour and depth', () => {
    const p = composePlate(orig, W, W, mask, depth, null);
    const mid = (24 * W + 24) * 4;
    expect(p[mid]).toBeLessThan(60); // no red left in the middle
    expect(p[mid + 2]).toBeGreaterThan(140); // the blue around it
    expect(p[mid + 3]).toBeLessThan(80); // the background's depth
    const out = (4 * W + 4) * 4;
    expect([p[out], p[out + 1], p[out + 2]]).toEqual([0, 0, 200]); // outside untouched
  });
  it('a fill model’s result is used when given', () => {
    const fill = { data: new Uint8ClampedArray(8 * 8 * 4).fill(255), w: 8, h: 8 };
    const p = composePlate(orig, W, W, mask, depth, fill);
    expect(p[(24 * W + 24) * 4 + 1]).toBe(255);
  });
  it('the subject layer keeps the subject and its depth', () => {
    const f = composeFore(orig, W, W, mask, depth);
    const mid = (24 * W + 24) * 4;
    expect([f[mid], f[mid + 1], f[mid + 2]]).toEqual([200, 0, 0]);
    expect(f[mid + 3]).toBe(220);
  });
  it('helpers', () => {
    expect(holeSquare(mask, 16).filter((v) => v === 255).length).toBeGreaterThan(16);
    expect(resizeRgba(orig, W, W, 4, 4).length).toBe(64);
  });
});
