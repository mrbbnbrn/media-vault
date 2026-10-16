import { describe, expect, it } from 'vitest';
import { edgeZoneAt, edgeZoneWidth, followPx, isSideways, onPicture, swipeEnd } from './swipe';

describe('swiping between items', () => {
  it('has wide edge zones, at least 80 px', () => {
    expect(edgeZoneWidth(1000)).toBe(120);
    expect(edgeZoneWidth(400)).toBe(80);
    expect(edgeZoneWidth(150)).toBe(50);
    expect(edgeZoneAt(10, 1000)).toBe('prev');
    expect(edgeZoneAt(990, 1000)).toBe('next');
    expect(edgeZoneAt(500, 1000)).toBeNull();
    expect(edgeZoneAt(5, 0)).toBeNull();
  });

  it('knows the picture from the space around it', () => {
    const d = { left: 100, top: 50, width: 300, height: 200 };
    expect(onPicture(200, 100, d)).toBe(true);
    expect(onPicture(50, 100, d)).toBe(false);
    expect(onPicture(200, 260, d)).toBe(false);
    expect(onPicture(200, 100, null)).toBe(false);
  });

  it('starts only on a sideways drag', () => {
    expect(isSideways(3, 0)).toBe(false);
    expect(isSideways(20, 4)).toBe(true);
    expect(isSideways(10, 30)).toBe(false);
  });

  it('moves on after a long drag or a flick, otherwise springs back', () => {
    expect(swipeEnd(-200, 10, 400, 1000)).toBe('next');
    expect(swipeEnd(200, 10, 400, 1000)).toBe('prev');
    expect(swipeEnd(-40, 0, 400, 1000)).toBe('back');
    expect(swipeEnd(-40, 0, 40, 1000)).toBe('next'); // a quick flick
    expect(swipeEnd(-200, 300, 400, 1000)).toBe('back'); // more up and down than sideways
    expect(swipeEnd(-70, 0, 900, 400)).toBe('next');
  });

  it('follows the mouse a bit, and only a little past the last item', () => {
    expect(followPx(100, true)).toBe(60);
    expect(Math.abs(followPx(1000, false))).toBe(40);
    expect(followPx(-20, false)).toBeLessThan(0);
  });
});
