import { describe, expect, it } from 'vitest';
import { budgetBytes, displayScale, Lru } from './picturecache';

const MB = 1024 * 1024;

function lru(n: number, cost = Infinity) {
  const gone: string[] = [];
  const c = new Lru<string>(n, cost, (v) => gone.push(v));
  return { c, gone };
}

describe('decoded picture cache', () => {
  it('keeps the last few, oldest out first, and a look counts as use', () => {
    const { c, gone } = lru(3);
    for (const k of ['a', 'b', 'c']) c.set(k, k, 1);
    c.get('a');
    c.set('d', 'd', 1);
    expect(gone).toEqual(['b']);
    expect(c.keys()).toEqual(['c', 'a', 'd']);
  });

  it('never lets go of the one on screen or the ones about to be shown', () => {
    const { c, gone } = lru(2);
    c.hold('a');
    c.set('a', 'a', 1);
    c.want(['b']);
    c.set('b', 'b', 1);
    c.set('c', 'c', 1);
    c.set('d', 'd', 1);
    expect(gone).toEqual(['c']);
    expect(c.has('a') && c.has('b')).toBe(true);
    // No longer wanted: it can go (the oldest one not on screen goes first).
    c.want([]);
    expect(c.keys()).toEqual(['a', 'd']);
    // Still held: 'd' makes room instead. Once unheld, 'a' is the oldest.
    c.set('e', 'e', 1);
    expect(c.keys()).toEqual(['a', 'e']);
    c.unhold('a');
    c.set('f', 'f', 1);
    expect(c.keys()).toEqual(['e', 'f']);
  });

  it('stays within the memory budget', () => {
    const { c, gone } = lru(10, 100);
    c.set('a', 'a', 60);
    c.set('b', 'b', 30);
    c.set('c', 'c', 30);
    expect(gone).toEqual(['a']);
    expect(c.total).toBe(60);
    // Replacing a value lets go of the old one.
    c.set('b', 'b2', 10);
    expect(gone).toEqual(['a', 'b']);
    expect(c.total).toBe(40);
  });

  it('clear and dropUnheld let go of everything (but the drawn one)', () => {
    const { c, gone } = lru(5);
    c.set('a', 'a', 1);
    c.set('b', 'b', 1);
    c.hold('b');
    c.dropUnheld();
    expect(gone).toEqual(['a']);
    c.clear();
    expect(gone).toEqual(['a', 'b']);
    expect(c.total).toBe(0);
  });

  it('decodes big pictures at screen size only', () => {
    // A 50-megapixel photo on a 2560×1440 screen: about 30% of it.
    const k = displayScale({ w: 8660, h: 5773 }, { w: 2560, h: 1440 })!;
    expect(k).toBeCloseTo(0.2956, 3);
    // Small (or barely bigger) pictures: as they are.
    expect(displayScale({ w: 1600, h: 1200 }, { w: 1920, h: 1080 })).toBeNull();
    expect(displayScale({ w: 2200, h: 1300 }, { w: 1920, h: 1080 })).toBeNull();
    expect(displayScale(null, { w: 1920, h: 1080 })).toBeNull();
    // A wide panorama is decoded tall enough to fill the screen's height.
    expect(displayScale({ w: 20000, h: 2000 }, { w: 1920, h: 1080 })).toBeCloseTo(0.54, 3);
  });

  it('budget: an eighth of memory, between 256 MB and 1 GB', () => {
    expect(budgetBytes(8)).toBe(1024 * MB);
    expect(budgetBytes(4)).toBe(512 * MB);
    expect(budgetBytes(0.5)).toBe(256 * MB);
    expect(budgetBytes(undefined)).toBe(1024 * MB);
  });
});
