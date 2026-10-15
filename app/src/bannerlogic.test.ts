import { describe, expect, it } from 'vitest';
import type { Item } from './api';
import { bannerRank, bannerSpan, dragFocus } from './bannerlogic';

const item = (id: number, kind: Item['kind'], width: number | null, height: number | null) => ({ id, kind, width, height }) as Item;

describe('folder banner', () => {
  it('knows how far a picture can move', () => {
    // 4:3 picture in a 1000×200 banner: 750 px tall, 550 px to move.
    expect(bannerSpan({ w: 4000, h: 3000 }, 1000, 200)).toBeCloseTo(550);
    // A panorama wider than the banner fills its height: nothing to move up or down.
    expect(bannerSpan({ w: 10000, h: 1000 }, 1000, 200)).toBe(0);
    expect(bannerSpan(null, 1000, 200)).toBe(0);
  });

  it('drags the focus within the picture', () => {
    expect(dragFocus(0.5, -55, 550)).toBeCloseTo(0.6);
    expect(dragFocus(0.5, 1000, 550)).toBe(0);
    expect(dragFocus(0.5, -1000, 550)).toBe(1);
    expect(dragFocus(0.3, 40, 0)).toBe(0.3);
  });

  it('offers wide pictures first and leaves out documents', () => {
    const list = [item(1, 'image', 1000, 1500), item(2, 'pdf', 800, 600), item(3, 'video', 1920, 1080), item(4, 'image', 1200, 1000), item(5, 'gif', null, null), item(6, 'image', 3000, 1000)];
    expect(bannerRank(list).map((x) => x.id)).toEqual([3, 6, 4, 1, 5]);
  });
});
