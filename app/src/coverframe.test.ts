import { describe, expect, it } from 'vitest';
import { clampPos, dragBy, fromPlacement, placement, samePos, zoomAround, ZOOM_MAX } from './coverframe';
import { coverFit } from './facealign';

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('cover framing', () => {
  it('with no framing, is centred like object-fit: cover', () => {
    // A wide picture in a square card: full height, spills out left and right equally.
    const p = placement(2, 1, null);
    near(p.w, 2);
    near(p.h, 1);
    near(p.left, -0.5);
    near(p.top, 0);
    // A tall one in a wide card.
    const q = placement(0.5, 2, null);
    near(q.w, 1);
    near(q.h, 4);
    near(q.top, -1.5);
  });

  it('matches the CSS: picture point x sits at card point x, at any zoom', () => {
    for (const pos of [{ x: 0.2, y: 0.9, zoom: 1 }, { x: 0.7, y: 0.1, zoom: 2.5 }]) {
      const pl = placement(1.5, 1, pos);
      near(pl.left + pos.x * pl.w, pos.x);
      near(pl.top + pos.y * pl.h, pos.y);
    }
  });

  it('always covers the whole card', () => {
    for (const x of [0, 0.3, 1]) {
      for (const zoom of [1, 3]) {
        const pl = placement(0.7, 1, { x, y: x, zoom });
        expect(pl.left).toBeLessThanOrEqual(1e-9);
        expect(pl.top).toBeLessThanOrEqual(1e-9);
        expect(pl.left + pl.w).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(pl.top + pl.h).toBeGreaterThanOrEqual(1 - 1e-9);
      }
    }
  });

  it('keeps values in range', () => {
    expect(clampPos({ x: -1, y: 2, zoom: 99 })).toEqual({ x: 0, y: 1, zoom: ZOOM_MAX });
    expect(clampPos({ x: NaN, y: 0.5, zoom: 0 })).toEqual({ x: 0.5, y: 0.5, zoom: 1 });
  });

  it('drags the picture along with the mouse, and stops at its edges', () => {
    const start = { x: 0.5, y: 0.5, zoom: 1 };
    const moved = dragBy(start, 0.25, 0, 2, 1); // wide picture, 1 spare card width
    near(placement(2, 1, moved).left, -0.25);
    near(moved.y, 0.5);
    // Nothing spills over top to bottom, so dragging down does nothing.
    near(dragBy(start, 0, 0.3, 2, 1).y, 0.5);
    // Far past the edge: the left edge of the picture stays on the card's left edge.
    near(dragBy(start, 5, 0, 2, 1).x, 0);
  });

  it('zooms around the mouse', () => {
    const start = { x: 0.5, y: 0.5, zoom: 1 };
    const pl0 = placement(1, 1, start);
    const z = zoomAround(start, 2, 0.25, 0.25, 1, 1);
    near(z.zoom, 2);
    const pl1 = placement(1, 1, z);
    // The picture point under (0.25, 0.25) is the same before and after.
    near((0.25 - pl0.left) / pl0.w, (0.25 - pl1.left) / pl1.w);
    near((0.25 - pl0.top) / pl0.h, (0.25 - pl1.top) / pl1.h);
    // Zooming back out to 1 gives a framing that still covers the card.
    const back = zoomAround(z, 1, 0.9, 0.9, 1, 1);
    near(back.zoom, 1);
  });

  it('turns the automatic face close-up into a framing that looks the same', () => {
    const face = { x: 0.6, y: 0.2, w: 0.1, h: 0.12 };
    const auto = coverFit(1.5, face, true);
    const pos = fromPlacement(1.5, 1, { w: auto.w, h: auto.h, left: auto.left, top: auto.top });
    const pl = placement(1.5, 1, pos);
    near(pl.w, auto.w);
    near(pl.h, auto.h);
    near(pl.left, auto.left);
    near(pl.top, auto.top);
  });

  it('compares framings', () => {
    expect(samePos(null, undefined)).toBe(true);
    expect(samePos(null, { x: 0.5, y: 0.5, zoom: 1 })).toBe(false);
    expect(samePos({ x: 0.5, y: 0.5, zoom: 1 }, { x: 0.50001, y: 0.5, zoom: 1 })).toBe(true);
  });
});
