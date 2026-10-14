import { describe, expect, it } from 'vitest';
import { coverInto } from './viewerflip';

/** Where the clipped element ends up on screen. */
function shown(el: { left: number; top: number; width: number; height: number }, c: ReturnType<typeof coverInto>) {
  const [t, r, b, l] = c.clip;
  return {
    left: el.left + c.x + l * c.s,
    top: el.top + c.y + t * c.s,
    right: el.left + c.x + (el.width - r) * c.s,
    bottom: el.top + c.y + (el.height - b) * c.s,
  };
}

describe('grow / shrink between a tile and the viewer', () => {
  it('a wide picture over a square tile: covers it and is clipped to exactly the tile', () => {
    const tile = { left: 100, top: 200, width: 150, height: 150 };
    const el = { left: 0, top: 50, width: 1600, height: 900 };
    const c = coverInto(tile, el);
    // Scaled so the height fits; the sides are cut off.
    expect(c.s).toBeCloseTo(150 / 900);
    const s = shown(el, c);
    expect(s.left).toBeCloseTo(100, 1);
    expect(s.top).toBeCloseTo(200, 1);
    expect(s.right).toBeCloseTo(250, 1);
    expect(s.bottom).toBeCloseTo(350, 1);
    expect(c.clip[0]).toBe(0);
    expect(c.clip[1]).toBeGreaterThan(0);
    expect(c.clip[1]).toBeCloseTo(c.clip[3], 1);
  });

  it('a tall picture over a wide tile cuts top and bottom', () => {
    const tile = { left: 10, top: 10, width: 200, height: 100 };
    const el = { left: 400, top: 0, width: 600, height: 1000 };
    const c = coverInto(tile, el);
    expect(c.clip[1]).toBe(0);
    expect(c.clip[3]).toBe(0);
    expect(c.clip[0]).toBeGreaterThan(0);
    const s = shown(el, c);
    expect(s.left).toBeCloseTo(10, 1);
    expect(s.right).toBeCloseTo(210, 1);
    expect(s.top).toBeCloseTo(10, 1);
    expect(s.bottom).toBeCloseTo(110, 1);
  });

  it('the same shape needs no clip', () => {
    const c = coverInto({ left: 0, top: 0, width: 160, height: 90 }, { left: 0, top: 0, width: 1600, height: 900 });
    expect(c.s).toBeCloseTo(0.1);
    expect(c.clip).toEqual([0, 0, 0, 0]);
  });
});
