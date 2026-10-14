import { describe, expect, it } from 'vitest';
import { FRAMES, framePosition, frameTimes } from './previews';

describe('preview clips', () => {
  it('takes 48 frames from four moments of a long video', () => {
    const t = frameTimes(600);
    expect(t).toHaveLength(FRAMES);
    expect(t[0]).toBeCloseTo(60);
    expect(t[1] - t[0]).toBeCloseTo(0.125);
    expect(t[12]).toBeCloseTo(198);
    expect(Math.max(...t)).toBeLessThan(600);
  });
  it('spreads frames over a short video', () => {
    const t = frameTimes(3);
    expect(t).toHaveLength(FRAMES);
    expect(t[0]).toBe(0);
    expect(Math.max(...t)).toBeLessThan(3);
    expect(t[47]).toBeGreaterThan(t[46]);
  });
  it('finds each frame in the strip', () => {
    expect(framePosition(0)).toBe('0% 0%');
    expect(framePosition(7)).toBe('100% 0%');
    expect(framePosition(47)).toBe('100% 100%');
  });
});
