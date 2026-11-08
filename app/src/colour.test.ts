import { describe, expect, it } from 'vitest';
import { bestMatch, columnOrder, isNeutral, measureColour, packColour, quantile, rainbowPos, sortSlots, unpackColour } from './colour';

/** A 16×16 picture, every pixel from `f(x, y)`. */
const pic = (f: (x: number, y: number) => [number, number, number]) => {
  const d = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const [r, g, b] = f(x, y);
    d.set([r, g, b, 255], (y * 16 + x) * 4);
  }
  return d;
};

describe('colour flow maths', () => {
  it('measures the average and the main hue', () => {
    const red = measureColour(pic(() => [220, 30, 30]))!;
    expect(red.r).toBe(220);
    expect(Math.min(red.hue, 360 - red.hue)).toBeLessThan(2);
    expect(isNeutral(red)).toBe(false);
    expect(measureColour(pic(() => [40, 200, 60]))!.hue).toBeGreaterThan(110);
    expect(measureColour(pic(() => [40, 200, 60]))!.hue).toBeLessThan(135);
    // A blue flower on grey is blue, not a muddy average.
    const flower = measureColour(pic((x, y) => (Math.hypot(x - 8, y - 8) < 4 ? [30, 60, 230] : [128, 128, 128])))!;
    expect(flower.hue).toBeGreaterThan(220);
    expect(flower.hue).toBeLessThan(235);
    expect(measureColour(new Uint8ClampedArray(16))).toBeNull(); // see-through only
  });

  it('greys, near-black and near-white go together at the end of the rainbow, dark to light', () => {
    const grey = measureColour(pic(() => [120, 120, 124]))!;
    const black = measureColour(pic(() => [8, 6, 10]))!;
    const white = measureColour(pic(() => [250, 248, 245]))!;
    expect([grey, black, white].every(isNeutral)).toBe(true);
    const hues = [[240, 60, 150], [230, 40, 30], [240, 150, 30], [230, 220, 40], [40, 200, 60], [40, 200, 210], [40, 70, 230], [150, 50, 220]]
      .map(([r, g, b]) => rainbowPos(measureColour(pic(() => [r, g, b]))!));
    // Pink, red, orange, yellow, green, cyan, blue, violet: in order along the line.
    expect(hues).toEqual([...hues].sort((a, b) => a - b));
    expect(Math.max(...hues)).toBeLessThan(rainbowPos(black));
    expect(rainbowPos(black)).toBeLessThan(rainbowPos(grey));
    expect(rainbowPos(grey)).toBeLessThan(rainbowPos(white));
    expect(rainbowPos(white)).toBeLessThanOrEqual(1);
  });

  it('quantiles, sorting slots (unknown ones stay) and column order', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([0.9, 0.1, 0.5], 0.5)).toBe(0.5);
    expect(quantile([0, 1], 0.25)).toBe(0.25);
    const pos = new Map<string, number | null>([['a', 0.9], ['b', null], ['c', 0.1], ['d', 0.5]]);
    expect(sortSlots(['a', 'b', 'c', 'd'], [0, 1, 2, 3], (k) => pos.get(k) ?? null)).toEqual(['c', 'b', 'd', 'a']);
    expect(sortSlots(['a', 'b', 'c', 'd'], [3, 2, 1, 0], (k) => pos.get(k) ?? null)).toEqual(['a', 'b', 'd', 'c']);
    expect(columnOrder(3, 2)).toEqual([0, 3, 1, 4, 2, 5]);
    expect(columnOrder(3, 2, 4)).toEqual([0, 3, 1, 2]);
  });

  it('picks the candidate that matches, likelier ones winning near-ties', () => {
    const pos = new Map<string, number | null>([['a', 0.1], ['b', 0.603], ['c', 0.6], ['d', null]]);
    const p = (k: string) => pos.get(k) ?? null;
    expect(bestMatch(['a', 'b', 'c'], 0.6, p)).toBe('b'); // a little further but picked first
    expect(bestMatch(['a', 'c', 'b'], 0.6, p)).toBe('c');
    expect(bestMatch(['d', 'a'], 0.12, p)).toBe('a');
    expect(bestMatch(['d', 'a'], null, p)).toBe('d');
    expect(bestMatch([], 0.5, p)).toBeNull();
  });

  it('stores numbers only, and refuses odd ones', () => {
    const c = measureColour(pic(() => [200, 100, 20]))!;
    expect(unpackColour(packColour(c))).toEqual(c);
    expect(unpackColour('1,2,3')).toBeNull();
    expect(unpackColour('300,0,0,10,0.5,0.5')).toBeNull();
    expect(unpackColour(42)).toBeNull();
  });
});
