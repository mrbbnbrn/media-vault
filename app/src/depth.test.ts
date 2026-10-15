import { describe, expect, it } from 'vitest';
import { parseDepth } from './api';
import {
  advancePhase, DOLLY, LOOP_MS, MOTION_LABELS, MOTION_SHAPES, SHAPE_REACH, SHIFT, cropScale, easeToward, framePose, loopMs, loopOf, motionChoice,
  mouseLean, mousePose, pickShape, pivotOf, progress, scalePose, shapeOutline, shapePose, shiftUv, slideLoops, slidePhase, type MotionLoop, type Pose,
} from './depth';
import { depthToCarryOver, normalize } from './presets';

let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** Every shape, a few loops each (each loop goes its own way round). */
const loops: MotionLoop[] = MOTION_SHAPES.flatMap((s) => [0, 1, 2, 3].map((i) => loopOf(s, 12345, i)));
const near0 = { x: expect.closeTo(0, 9), y: expect.closeTo(0, 9), dolly: expect.closeTo(0, 9) };
const dist = (a: Pose, b: Pose) => Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(a.dolly - b.dolly);

describe('3D photos: motion shapes', () => {
  it('every loop starts and ends exactly as the still picture, with no speed', () => {
    for (const l of loops) {
      for (const v of [0, 1, -0.5, 1.5]) expect(shapePose(v, l)).toEqual(near0);
      for (const v of [0.002, 0.998]) expect(dist(shapePose(v, l), shapePose(Math.round(v), l))).toBeLessThan(SHIFT * 0.001);
    }
  });

  it('stays within the amount, and moves smoothly', () => {
    for (const l of loops) {
      let prev = shapePose(0, l);
      let most = 0;
      for (let i = 1; i <= 400; i++) {
        const q = shapePose(i / 400, l);
        most = Math.max(most, Math.hypot(q.x, q.y) + q.dolly);
        expect(Math.hypot(q.x, q.y)).toBeLessThanOrEqual(SHIFT * SHAPE_REACH + 1e-12);
        expect(q.dolly).toBeGreaterThanOrEqual(-1e-12);
        expect(q.dolly).toBeLessThanOrEqual(DOLLY + 1e-12);
        expect(dist(q, prev)).toBeLessThan(SHIFT * 0.08);
        prev = q;
      }
      // …and every shape really moves.
      expect(most).toBeGreaterThan(SHIFT * 0.5);
      // Scaled by the amount: twice the amount, twice as far.
      const half = shapePose(0.3, l);
      const two = scalePose(half, 2);
      expect(Math.hypot(two.x, two.y)).toBeCloseTo(2 * Math.hypot(half.x, half.y), 12);
    }
  });

  it('each shape moves its own way', () => {
    const at = (s: (typeof MOTION_SHAPES)[number], v: number) => shapePose(v, { shape: s, turn: 1, angle: 0 });
    // Side to side: only sideways; up and down: only up and down; zoom: only nearer.
    for (let v = 0; v <= 1; v += 0.05) {
      expect(at('side', v).y).toBe(0);
      expect(at('updown', v).x).toBe(0);
      expect(at('zoom', v).x + at('zoom', v).y).toBe(0);
      expect(Math.abs(at('diagonal', v).x)).toBeCloseTo(Math.abs(at('diagonal', v).y), 12);
      // The pendulum hangs: it rises (y up = negative) as it swings out.
      expect(at('pendulum', v).y).toBeLessThanOrEqual(0);
    }
    expect(at('zoom', 0.5).dolly).toBeCloseTo(DOLLY);
    expect(at('spiral', 0.5).dolly).toBeGreaterThan(0);
    // The figure of eight crosses the still pose halfway, the circle is furthest from it there.
    expect(Math.hypot(at('infinity', 0.5).x, at('infinity', 0.5).y)).toBeLessThan(1e-12);
    expect(Math.hypot(at('circle', 0.5).x, at('circle', 0.5).y)).toBeCloseTo(SHIFT * 1.2);
    // The pendulum slows at its ends: less ground covered near a turn than through the middle.
    const step = (v: number) => Math.abs(at('pendulum', v + 0.005).x - at('pendulum', v - 0.005).x);
    let turnAt = 0;
    for (let v = 0; v <= 0.5; v += 0.001) if (at('pendulum', v).x > at('pendulum', turnAt).x) turnAt = v;
    expect(step(turnAt)).toBeLessThan(step(0.5) * 0.1);
    // All shapes differ from each other.
    const sig = MOTION_SHAPES.map((s) => [0.15, 0.3, 0.45, 0.6].map((v) => Object.values(at(s, v)).map((n) => n.toFixed(5)).join()).join('|'));
    expect(new Set(sig).size).toBe(MOTION_SHAPES.length);
  });

  it('a new loop goes a new way, but is the same when asked again', () => {
    const ways = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const l = loopOf('circle', 7, i); return `${l.turn}:${l.angle.toFixed(3)}`; }));
    expect(ways.size).toBeGreaterThan(4);
    expect(loopOf('spiral', 99, 3)).toEqual(loopOf('spiral', 99, 3));
    // Mostly sideways for the circle and spiral.
    for (let i = 0; i < 50; i++) expect(Math.abs(Math.cos(loopOf('circle', 5, i).angle))).toBeGreaterThan(0.8);
  });

  it('Random picks only real shapes, and all of them', () => {
    const got = new Set<string>();
    for (let i = 0; i < 400; i++) got.add(pickShape('random', rand));
    expect([...got].sort()).toEqual([...MOTION_SHAPES].sort());
    expect(pickShape('random', () => 0.999999999)).toBe(MOTION_SHAPES[MOTION_SHAPES.length - 1]);
    expect(pickShape('random', () => 1)).toBe(MOTION_SHAPES[MOTION_SHAPES.length - 1]);
    expect(pickShape('pendulum', rand)).toBe('pendulum');
    // Saved choices read back safely.
    expect(motionChoice('spiral')).toBe('spiral');
    expect(motionChoice('wobble')).toBe('random');
    expect(motionChoice(undefined)).toBe('random');
    for (const s of MOTION_SHAPES) expect(MOTION_LABELS[s]).toBeTruthy();
  });

  it('draws each shape small for the chooser, inside its box', () => {
    for (const s of MOTION_SHAPES) {
      const pts = shapeOutline(s, 34, 22);
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(34);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(22);
      }
      // A closed loop: it ends where it starts.
      expect(pts[0].x).toBeCloseTo(pts[pts.length - 1].x, 9);
      expect(pts[0].y).toBeCloseTo(pts[pts.length - 1].y, 9);
    }
  });
});

describe('3D photos: timing of the movement', () => {
  it('a faster speed means more whole loops in a slideshow picture', () => {
    expect([0.25, 0.5, 1, 1.4, 2, 3, 4].map(slideLoops)).toEqual([1, 1, 1, 1, 2, 3, 4]);
    expect(slideLoops(NaN)).toBe(1);
    // Every loop ends still, so the picture starts and ends still whatever the speed.
    for (const n of [1, 2, 3, 4]) {
      expect(slidePhase(0, n)).toEqual({ loop: 0, v: 0 });
      expect(slidePhase(1, n)).toEqual({ loop: n - 1, v: 1 });
      expect(slidePhase(2, n)).toEqual({ loop: n - 1, v: 1 });
      expect(slidePhase(-1, n)).toEqual({ loop: 0, v: 0 });
    }
    const mid = slidePhase(0.6, 3);
    expect(mid.loop).toBe(1);
    expect(mid.v).toBeCloseTo(0.8);
  });

  it('speed scales the loop outside slideshows', () => {
    expect(loopMs(1)).toBe(LOOP_MS);
    expect(loopMs(2)).toBe(LOOP_MS / 2);
    expect(loopMs(0.25)).toBe(LOOP_MS * 4);
    expect(advancePhase(0, LOOP_MS, 1)).toBeCloseTo(1);
    expect(advancePhase(0, LOOP_MS, 4)).toBeCloseTo(4);
    expect(advancePhase(1.5, -50, 1)).toBe(1.5);
  });

  it('loops join without a jump, and a change of speed never jumps', () => {
    for (const shape of MOTION_SHAPES) {
      let phase = 0;
      const pose = () => shapePose(phase - Math.floor(phase), loopOf(shape, 3, Math.floor(phase)));
      let prev = pose();
      // About 3 loops at 60 frames a second, the speed changing on the way.
      for (let f = 0; f < 1700; f++) {
        const before = Math.floor(phase);
        phase = advancePhase(phase, 16.7, f < 600 ? 1 : f < 1100 ? 3.7 : 0.4);
        const q = pose();
        // A jump would be about SHIFT; even the quick spiral at 370% moves well under a quarter of it a frame…
        expect(Math.hypot(q.x - prev.x, q.y - prev.y)).toBeLessThan(SHIFT * 0.25);
        expect(Math.abs(q.dolly - prev.dolly)).toBeLessThan(DOLLY * 0.1);
        // …and from one loop to the next it is all but still.
        if (Math.floor(phase) !== before) expect(dist(q, prev)).toBeLessThan(SHIFT * 0.005);
        prev = q;
      }
      expect(phase).toBeGreaterThan(3);
    }
  });
});

describe('3D photos: the picture fills its frame', () => {
  // The shader's sampling (Depth3D.tsx FRAG), in JS: where a screen point looks in the picture at depth z.
  const sample = (uv: number, k: number, kd: number, z: number, pivot: number, scale: number) => {
    const p = 0.5 + (uv - 0.5) / scale;
    return p - (k + (p - 0.5) * kd) * (z - pivot);
  };
  it('never shows the edges, even at the largest amount and depth, with every shape', () => {
    const sizes: [number, number][] = [[1600, 900], [900, 1600], [1000, 1000], [3000, 500]];
    for (const l of loops) for (const [w, h] of sizes) for (const pivot of [0.25, 0.5, 0.85]) {
      let biggest = 1;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i <= 60; i++) {
        const f = framePose(scalePose(shapePose(i / 60, l), 4 * 3), w, h, pivot);
        biggest = Math.max(biggest, f.scale);
        for (const uv of [0, 1]) for (const z of [0, 0.5, 1]) {
          const x = sample(uv, f.shift.x, f.dolly, z, pivot, f.scale);
          const y = sample(uv, f.shift.y, f.dolly, z, pivot, f.scale);
          lo = Math.min(lo, x, y);
          hi = Math.max(hi, x, y);
        }
      }
      expect(lo).toBeGreaterThanOrEqual(-1e-9);
      expect(hi).toBeLessThanOrEqual(1 + 1e-9);
      expect(biggest).toBeLessThanOrEqual(2.5 + 1e-9);
    }
  });

  it('enlarges only as much as needed', () => {
    // The still pose: not enlarged at all; at 100% only a few per cent.
    expect(framePose({ x: 0, y: 0, dolly: 0 }, 1600, 900, 0.5).scale).toBe(1);
    for (const l of loops) {
      const f = framePose(shapePose(0.5, l), 1600, 900, 0.5);
      expect(f.scale).toBeLessThan(1.06);
      // Within the limit the pose is used as it is.
      expect(f.shift).toEqual(shiftUv(shapePose(0.5, l), 1600, 900));
    }
  });
});

describe('3D photos: camera maths', () => {
  it('moves the same in pixels both ways', () => {
    const s = shiftUv({ x: 0.02, y: 0.02, dolly: 0 }, 2000, 1000);
    expect(s.x * 2000).toBeCloseTo(s.y * 1000);
    expect(s.y).toBeCloseTo(0.02);
  });

  it('enlarges just enough that the edges never show', () => {
    expect(cropScale({ x: 0, y: 0 }, 0, 0.5)).toBe(1);
    const k = cropScale({ x: 0.02, y: 0.01 }, 0.05, 0.7);
    // The furthest any sample moves: (0.02 + 0.05 / 2) × 0.7 = 0.0315, on each side.
    expect(k).toBeCloseTo(1 / (1 - 2 * 0.0315));
    expect(k).toBeLessThan(1.08);
  });

  it('keeps the middle of the picture still', () => {
    const w = 64;
    const data = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data[y * w + x] = x > 16 && x < 48 && y > 16 && y < 48 ? 204 : 20;
    expect(pivotOf({ w, h: w, data })).toBeCloseTo(0.8, 1);
    expect(pivotOf({ w, h: w, data: new Uint8Array(w * w) })).toBe(0.25);
    expect(pivotOf({ w: 0, h: 0, data: new Uint8Array() })).toBe(0.5);
  });

  it('times the movement to the picture', () => {
    expect(progress(500, 0, 1000)).toBe(0.5);
    expect(progress(1500, 500, 2500)).toBe(0.5);
    expect(progress(5, 10, 10)).toBe(1);
  });
});

describe('3D photos: depth maps and the setting', () => {
  it('reads what the app sends back', () => {
    const b = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 7, 9]);
    const m = parseDepth(b.buffer);
    expect([m.w, m.h, [...m.data]]).toEqual([2, 1, [7, 9]]);
    expect(() => parseDepth(new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 7]))).toThrow();
    expect(() => parseDepth(new Uint8Array(3))).toThrow();
  });

  it('is off unless chosen', () => {
    expect(normalize({}).depth3d).toBe(false);
    expect(normalize({ depth3d: true }).depth3d).toBe(true);
    expect(normalize({ depth3d: 'yes' as unknown as boolean }).depth3d).toBe(false);
  });

  it('carries the old slideshow setting over to the viewer setting once', () => {
    const old = normalize({ depth3d: true });
    expect(depthToCarryOver({}, [normalize({}), old])).toBe(true);
    expect(depthToCarryOver({ depthAutoMigrated: false }, [null, { depth3d: true }])).toBe(true);
    // Not on anywhere: nothing to carry over.
    expect(depthToCarryOver({}, [normalize({}), {}, undefined])).toBe(false);
    // Done before (and maybe turned off since): left alone.
    expect(depthToCarryOver({ depthAutoMigrated: true }, [old])).toBe(false);
  });
});

describe('3D with the mouse', () => {
  it('leans with the mouse, held within the furthest lean', () => {
    expect(mouseLean(0, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(mouseLean(0.5, -0.5, 1)).toEqual({ x: 0.5, y: -0.5 });
    expect(mouseLean(0.5, 0, 3).x).toBe(1);
    expect(mouseLean(-2, 0, 1).x).toBe(-1);
    expect(Math.abs(mouseLean(0.5, 0, 0.3).x - 0.15)).toBeLessThan(1e-9);
  });
  it('is stronger or weaker with the depth setting', () => {
    const a = mousePose({ x: 1, y: 0 }, 1);
    const b = mousePose({ x: 1, y: 0 }, 2);
    expect(b.x).toBeCloseTo(a.x * 2);
    expect(mousePose({ x: 0, y: 0 }, 3)).toEqual({ x: 0, y: 0, dolly: 0 });
    expect(scalePose({ x: 0.01, y: 0.02, dolly: 0.03 }, 0.5)).toEqual({ x: 0.005, y: 0.01, dolly: 0.015 });
    // Even the strongest lean leaves the picture filling its frame.
    expect(cropScale(shiftUv(mousePose({ x: 1, y: 1 }, 3), 1600, 900), 0, 0.85)).toBeLessThan(2);
  });
  it('eases toward where the mouse is, whatever the frame rate', () => {
    expect(easeToward(0, 1, 0)).toBe(0);
    const one = easeToward(0, 1, 32);
    const two = easeToward(easeToward(0, 1, 16), 1, 16);
    expect(one).toBeCloseTo(two, 9);
    expect(easeToward(0, 1, 1000)).toBeGreaterThan(0.99);
  });
});
