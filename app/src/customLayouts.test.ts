import { describe, expect, it } from 'vitest';
import {
  boxesFromLayout, buildCustomShapes, cleanBoxes, duplicate, forSaving, makeSquare, makeTall, makeWide, registerFree, setCorner, setFreeLayouts,
  savedFreeLayouts, snapRect, toBack, toFront, type FreeBox,
} from './customLayouts';
import { buildShapes, layoutDef } from './shapes';

const W = 1600;
const H = 900;

describe('buildCustomShapes', () => {
  it('turns fractions into stage boxes with a rectangle outline', () => {
    const [p] = buildCustomShapes([{ x: 0.5, y: 0, w: 0.25, h: 0.5 }], W, H);
    expect(p.box).toEqual({ x: 800, y: 0, w: 400, h: 450 });
    expect(p.d).toBe('M0 0 L400 0 L400 450 L0 450 Z');
    expect(p.anchor).toEqual({ x: 1000, y: 225 });
    expect(p.outline).toBeUndefined();
    expect(p.z).toBe(0);
  });

  it('draws rounded corners with arcs sized from the smaller side', () => {
    const [p] = buildCustomShapes([{ x: 0, y: 0, w: 0.25, h: 0.5, corner: 'rounded', r: 0.1 }], W, H);
    // smaller side 400 → radius 40
    expect(p.d.startsWith('M40 0 H360 A40 40 0 0 1 400 40')).toBe(true);
    expect(p.d.match(/A/g)).toHaveLength(4);
    // and a polygon outline for "Fit inside the shape"
    expect(p.outline?.pts).toHaveLength(12);
    expect(p.outline?.pts[2]).toEqual([388.28, 11.72]);
  });

  it('makes a true circle centred in its box', () => {
    const [p] = buildCustomShapes([{ x: 0, y: 0, w: 0.5, h: 0.5, corner: 'circle' }], W, H);
    // box 800 × 450 → circle 450 wide, centred
    expect(p.box).toEqual({ x: 175, y: 0, w: 450, h: 450 });
    expect(p.d).toBe('M0 225 A225 225 0 1 0 450 225 A225 225 0 1 0 0 225 Z');
  });

  it('keeps the z order', () => {
    const s = buildCustomShapes([{ x: 0, y: 0, w: 1, h: 1, z: 1 }, { x: 0, y: 0, w: 0.2, h: 0.2, z: 0 }], W, H);
    expect(s.map((p) => p.z)).toEqual([1, 0]);
  });
});

describe('snapRect', () => {
  it('snaps a moved box to the screen edge and shows a guide', () => {
    const s = snapRect({ x: 5, y: 300, w: 200, h: 200 }, 'move', [], W, H);
    expect(s.rect.x).toBe(0);
    expect(s.guides.x).toContain(0);
  });

  it('snaps to another box edge and centre', () => {
    const other = { x: 400, y: 100, w: 300, h: 300 };
    const s = snapRect({ x: 706, y: 103, w: 100, h: 100 }, 'move', [other], W, H);
    expect(s.rect.x).toBe(700); // left edge to its right edge
    expect(s.rect.y).toBe(100); // top to its top
    expect(s.guides.x).toContain(700);
    const c = snapRect({ x: 497, y: 600, w: 100, h: 100 }, 'move', [other], W, H);
    expect(c.rect.x + c.rect.w / 2).toBe(550); // centres line up
  });

  it('leaves the box alone when nothing is near', () => {
    const s = snapRect({ x: 300, y: 300, w: 100, h: 100 }, 'move', [], W, H);
    expect(s.rect).toEqual({ x: 300, y: 300, w: 100, h: 100 });
    expect(s.guides).toEqual({ x: [], y: [] });
  });

  it('when resizing, only the dragged edges move', () => {
    const s = snapRect({ x: 100, y: 100, w: 1495, h: 300 }, { r: true }, [], W, H);
    expect(s.rect).toEqual({ x: 100, y: 100, w: 1500, h: 300 });
    const t = snapRect({ x: 100, y: 4, w: 300, h: 296 }, { t: true, l: true }, [], W, H);
    expect(t.rect).toEqual({ x: 100, y: 0, w: 300, h: 300 });
    expect(t.guides.y).toEqual([0]);
  });
});

describe('box helpers', () => {
  it('a tall box on the left and squares on the right are easy', () => {
    const tall = makeTall({ x: 0, y: 0, w: 0.3, h: 1 }, W, H);
    expect((tall.w * W) / (tall.h * H)).toBeCloseTo(9 / 16);
    const sq = makeSquare({ x: 0.5, y: 0, w: 0.3, h: 0.5 }, W, H);
    expect(sq.w * W).toBeCloseTo(sq.h * H);
    const wide = makeWide({ x: 0, y: 0, w: 0.5, h: 0.2 }, W, H);
    expect((wide.w * W) / (wide.h * H)).toBeCloseTo(16 / 9);
  });

  it('duplicates next to the box, on top', () => {
    const b: FreeBox[] = [{ x: 0.5, y: 0, w: 0.25, h: 0.25, z: 0 }];
    const d = duplicate(b, 0);
    expect(d).toHaveLength(2);
    expect(d[1]).toMatchObject({ x: 0.75, y: 0, z: 1 });
    // Again from the first: the right is taken, so it goes below.
    const d2 = duplicate(d, 0);
    expect(d2[2]).toMatchObject({ x: 0.5, y: 0.25 });
  });

  it('brings to front and sends to back', () => {
    const b: FreeBox[] = [{ x: 0, y: 0, w: 1, h: 1, z: 0 }, { x: 0, y: 0, w: 1, h: 1, z: 1 }, { x: 0, y: 0, w: 1, h: 1, z: 2 }];
    expect(toFront(b, 0).map((x) => x.z)).toEqual([2, 0, 1]);
    expect(toBack(b, 2).map((x) => x.z)).toEqual([1, 2, 0]);
  });

  it('a circle makes its box square', () => {
    const c = setCorner({ x: 0, y: 0, w: 0.5, h: 0.5 }, 'circle', W, H);
    expect(c.w * W).toBeCloseTo(c.h * H);
    expect(c.corner).toBe('circle');
  });

  it('cleans what it loads', () => {
    expect(cleanBoxes('nope')).toEqual([]);
    const [b] = cleanBoxes([{ x: -1, y: 0.5, w: 3, h: 0.8, corner: 'odd' }]);
    expect(b).toMatchObject({ x: 0, y: 0.5, w: 1, corner: 'square' });
    expect(b.h).toBeCloseTo(0.5);
    expect(forSaving([{ x: 1 / 3, y: 0, w: 0.123456, h: 0.5, corner: 'rounded' }]).boxes[0]).toMatchObject({ x: 0.3333, w: 0.1235, r: 0.12 });
  });
});

describe('the registry', () => {
  it('makes free-form layouts play like shaped ones', () => {
    setFreeLayouts([{ id: 7, name: 'Tall + squares', settings: { v: 1, boxes: [{ x: 0, y: 0, w: 0.3, h: 1 }, { x: 0.3, y: 0, w: 0.2, h: 0.4 }] } }]);
    expect(layoutDef('free:7')).toMatchObject({ id: 'free:7', name: 'Tall + squares', count: 2, kind: 'shape' });
    expect(buildShapes('free:7', W, H)).toHaveLength(2);
    expect(savedFreeLayouts()).toEqual([{ id: 'free:7', name: 'Tall + squares', dbId: 7, count: 2 }]);
    registerFree('free:draft', 'Unsaved layout', [{ x: 0, y: 0, w: 1, h: 1 }]);
    setFreeLayouts([]);
    expect(layoutDef('free:7').id).toBe('4'); // gone: falls back
    expect(layoutDef('free:draft').count).toBe(1); // drafts stay
  });

  it('starts from grid and shaped layouts', () => {
    const g = boxesFromLayout('6', W, H);
    expect(g).toHaveLength(6);
    expect(g[4]).toMatchObject({ x: 1 / 3, y: 0.5 });
    const b = boxesFromLayout('bullseye', W, H);
    expect(b[0].corner).toBe('circle');
    expect(b[1].corner).toBe('square');
    expect(b[0].z).toBeGreaterThan(b[1].z ?? 0);
  });
});

describe('saved multi-screen layouts', () => {
  it('play their free-form layout, or their own copy when it is gone', async () => {
    const { freeSnapshot, restoreFree } = await import('./customLayouts');
    setFreeLayouts([{ id: 3, name: 'Mine', settings: { v: 1, boxes: [{ x: 0, y: 0, w: 0.5, h: 1 }] } }]);
    const snap = freeSnapshot('free:3');
    expect(snap?.boxes).toHaveLength(1);
    expect(restoreFree('free:3', snap, 9)).toBe('free:3');
    setFreeLayouts([]);
    const id = restoreFree('free:3', snap, 9);
    expect(id).toBe('free:restored-9');
    expect(layoutDef(id)).toMatchObject({ name: 'Mine', count: 1 });
    expect(restoreFree('4', snap, 9)).toBe('4');
  });
});
