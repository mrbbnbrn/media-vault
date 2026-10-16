import { describe, expect, it } from 'vitest';
import { parseDepth } from './api';
import {
  cameraAt, DOLLY, LOOP_MS, MOTION_LABELS, MOTION_SHAPES, SHAPE_REACH, SHIFT, cropScale, easeToward, framePose, loopMs, motionChoice, motionPose,
  mouseLean, mousePose, newCamera, pivotOf, scalePose, shapeOutline, shiftUv, type MotionChoice, type Pose,
} from './depth';
import { depthToCarryOver, normalize } from './presets';

const CHOICES: MotionChoice[] = ['random', ...MOTION_SHAPES];
const dist = (a: Pose, b: Pose) => Math.hypot(a.x - b.x, a.y - b.y) + Math.abs(a.dolly - b.dolly);
/** Poses along a few times round each shape. */
const poses = (c: MotionChoice, turns = 4, n = 600) => Array.from({ length: n + 1 }, (_, i) => motionPose(c, (i / n) * turns));

describe('3D photos: motion shapes', () => {
  it('stays within the amount, never jerks, and really moves', () => {
    for (const c of CHOICES) {
      const ps = poses(c, 12, 4000);
      let most = 0;
      for (let i = 0; i < ps.length; i++) {
        const q = ps[i];
        most = Math.max(most, Math.hypot(q.x, q.y) + q.dolly);
        expect(Math.hypot(q.x, q.y)).toBeLessThanOrEqual(SHIFT * SHAPE_REACH + 1e-12);
        expect(q.dolly).toBeGreaterThanOrEqual(-1e-12);
        expect(q.dolly).toBeLessThanOrEqual(DOLLY + 1e-12);
        if (i) expect(dist(q, ps[i - 1])).toBeLessThan(SHIFT * 0.08);
        // Smooth: the step changes only a little from one step to the next (no sudden turn).
        if (i > 1) {
          const d1 = { x: ps[i - 1].x - ps[i - 2].x, y: ps[i - 1].y - ps[i - 2].y };
          const d2 = { x: q.x - ps[i - 1].x, y: q.y - ps[i - 1].y };
          expect(Math.hypot(d2.x - d1.x, d2.y - d1.y)).toBeLessThan(SHIFT * 0.002);
        }
      }
      expect(most, c).toBeGreaterThan(SHIFT * 0.4);
      const half = motionPose(c, 0.3);
      const two = scalePose(half, 2);
      expect(Math.hypot(two.x, two.y)).toBeCloseTo(2 * Math.hypot(half.x, half.y), 12);
    }
  }, 30000); // ~200,000 checks: slow on a busy machine

  it('never stops, except Zoom in and out, which rests at the still picture', () => {
    for (const c of CHOICES) {
      const ps = poses(c, 6, 3000);
      const slowest = Math.min(...ps.slice(1).map((q, i) => dist(q, ps[i])));
      if (c === 'zoom') {
        expect(slowest).toBeLessThan(DOLLY * 1e-6);
        expect(motionPose('zoom', 3)).toEqual({ x: 0, y: 0, dolly: 0 });
        expect(motionPose('zoom', 3.5).dolly).toBeCloseTo(DOLLY);
      } else if (c === 'circle' || c === 'random' || c === 'spiral' || c === 'drift') {
        // These never even slow to a stop.
        expect(slowest, c).toBeGreaterThan(SHIFT * 1e-4);
      }
    }
    // The circle goes round at an even pace.
    const steps = poses('circle', 1, 100).slice(1).map((q, i, all) => dist(q, i ? all[i - 1] : motionPose('circle', 0)));
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.001);
  });

  it('each shape moves its own way', () => {
    for (let v = 0; v <= 2; v += 0.05) {
      expect(motionPose('side', v).y).toBe(0);
      expect(motionPose('updown', v).x).toBe(0);
      expect(motionPose('zoom', v).x + motionPose('zoom', v).y).toBe(0);
      expect(motionPose('diagonal', v).x).toBeCloseTo(motionPose('diagonal', v).y, 12);
    }
    // The pendulum is highest at its ends.
    expect(motionPose('pendulum', 0.25).y).toBeLessThan(motionPose('pendulum', 0).y);
    expect(motionPose('drift', 0.5).dolly).toBeCloseTo(DOLLY);
    // The circle keeps its distance from the middle.
    for (let v = 0; v < 1; v += 0.1) expect(Math.hypot(motionPose('circle', v).x, motionPose('circle', v).y)).toBeCloseTo(SHIFT * 0.85);
    // All shapes differ from each other.
    const sig = CHOICES.map((c) => [0.15, 0.3, 0.45, 0.6].map((v) => Object.values(motionPose(c, v)).map((n) => (n as number).toFixed(5)).join()).join('|'));
    expect(new Set(sig).size).toBe(CHOICES.length);
    // Random never comes round to the same place the same way (it wanders).
    expect(dist(motionPose('random', 0.2), motionPose('random', 1.2))).toBeGreaterThan(SHIFT * 0.05);
  });

  it('reads saved choices safely and names every one', () => {
    expect(motionChoice('spiral')).toBe('spiral');
    expect(motionChoice('drift')).toBe('drift');
    expect(motionChoice('wobble')).toBe('random');
    expect(motionChoice(undefined)).toBe('random');
    expect(motionPose('circle', NaN)).toEqual(motionPose('circle', 0));
    for (const c of CHOICES) expect(MOTION_LABELS[c]).toBeTruthy();
  });

  it('draws each shape small for the chooser, inside its box', () => {
    for (const c of CHOICES) {
      const pts = shapeOutline(c, 34, 22);
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(34);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(22);
      }
    }
  });
});

describe('3D photos: one camera for every picture', () => {
  it('speed scales the time round', () => {
    expect(loopMs(1)).toBe(LOOP_MS);
    expect(loopMs(2)).toBe(LOOP_MS / 2);
    expect(loopMs(0.25)).toBe(LOOP_MS * 4);
    expect(loopMs(20)).toBe(LOOP_MS / 20);
    expect(loopMs(50)).toBe(LOOP_MS / 20);
  });

  it('carries on from picture to picture: no reset, never a jump, whatever the speed or shape', () => {
    const cam = newCamera();
    let t = 1000;
    let prev = cameraAt(cam, 'circle', 1, t, true);
    const choices: MotionChoice[] = ['circle', 'circle', 'random', 'spiral', 'zoom', 'pendulum', 'drift', 'infinity'];
    for (let f = 0; f < 4000; f++) {
      t += 16.7;
      const choice = choices[Math.floor(f / 500)];
      const speed = f < 1500 ? 1 : f < 2500 ? 4 : 0.25;
      const q = cameraAt(cam, choice, speed, t, true);
      // A jump would be about SHIFT; the quickest shape at 400% moves well under a fifth of it a frame.
      expect(Math.hypot(q.x - prev.x, q.y - prev.y)).toBeLessThan(SHIFT * 0.2);
      expect(Math.abs(q.dolly - prev.dolly)).toBeLessThan(DOLLY * 0.1);
      // A second picture asking at the same moment (crossfading) sees the same pose and doesn't move it on.
      expect(cameraAt(cam, choice, speed, t, true)).toEqual(q);
      prev = q;
    }
    expect(cam.phase).toBeGreaterThan(5);
  });

  it('waits while paused, and never jumps on after a long pause', () => {
    const cam = newCamera();
    cameraAt(cam, 'circle', 1, 0, true);
    cameraAt(cam, 'circle', 1, 100, true);
    const at = cam.phase;
    cameraAt(cam, 'circle', 1, 5000, false);
    expect(cam.phase).toBe(at);
    // Back after a minute away: one small step, not a minute's worth.
    cameraAt(cam, 'circle', 1, 65000, true);
    expect(cam.phase - at).toBeLessThan(0.01);
  });

  it('starts at once with no waiting, even for a picture shown a tenth of a second', () => {
    const cam = newCamera();
    const a = cameraAt(cam, 'side', 1, 0, true);
    const b = cameraAt(cam, 'side', 1, 100, true);
    expect(dist(a, b)).toBeGreaterThan(0);
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
    for (const c of CHOICES) for (const [w, h] of sizes) for (const pivot of [0.25, 0.5, 0.85]) {
      let biggest = 1;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i <= 60; i++) {
        const f = framePose(scalePose(motionPose(c, (i / 60) * 3), 4 * 3), w, h, pivot);
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
    for (const c of CHOICES) {
      const f = framePose(motionPose(c, 0.5), 1600, 900, 0.5);
      expect(f.scale).toBeLessThan(1.06);
      // Within the limit the pose is used as it is.
      expect(f.shift).toEqual(shiftUv(motionPose(c, 0.5), 1600, 900));
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

describe('3D for moving pictures', () => {
  it('gives every frame a map, sharing them when there are very many frames', async () => {
    const { frameStep, frameDepth, smoothFrames, FRAMES_MAX, animationType } = await import('./depth');
    expect(frameStep(10)).toBe(1);
    expect(frameStep(FRAMES_MAX)).toBe(1);
    expect(frameStep(FRAMES_MAX + 1)).toBe(2);
    const m = (v: number) => ({ w: 1, h: 1, data: new Uint8Array([v]) });
    const f = { maps: [m(1), m(2), m(3)], step: 2, count: 6 };
    expect(frameDepth(f, 0)?.data[0]).toBe(1);
    expect(frameDepth(f, 3)?.data[0]).toBe(2);
    expect(frameDepth(f, 99)?.data[0]).toBe(3);
    expect(frameDepth({ maps: [], step: 1, count: 0 }, 0)).toBeNull();
    // Smoothing blends neighbours (going round), so a lone jump is softened.
    const sm = smoothFrames([m(0), m(200), m(0), m(0)]);
    expect([...sm.map((x) => x.data[0])]).toEqual([50, 100, 50, 0]);
    expect(animationType(new Uint8Array([0x47, 0x49, 0x46]))).toBe('image/gif');
    expect(animationType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(animationType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45]))).toBe('image/webp');
  });
});
