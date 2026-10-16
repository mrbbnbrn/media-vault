import { describe, expect, it } from 'vitest';
import { parseSubject, type SubjectMask } from './api';
import {
  LIFT_GROW, LIFT_MS, effectAmount, fadeAt, fadeDone, fadeTo, flatDepth, maskStats, moveSubjectPoint, newFade,
  setSubjectCompute, setSubjectSetupForTests, subjectAhead, subjectChoice, subjectDepth, subjectFrame, subjectKey, subjectOf, subjectSetupOf, unmoveSubjectPoint,
} from './subject';

/** A mask with a filled rectangle (uv) as the subject. */
function rectMask(w: number, h: number, r: { x0: number; y0: number; x1: number; y1: number }): SubjectMask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (x >= r.x0 * w && x < r.x1 * w && y >= r.y0 * h && y < r.y1 * h) data[y * w + x] = 255;
  return { w, h, data };
}

describe('subject effects: settings and setup', () => {
  it('reads the model and amounts safely', () => {
    expect(subjectChoice({})).toBe('');
    expect(subjectChoice({ subjectModel: 'birefnet' })).toBe('birefnet');
    expect(effectAmount(undefined)).toBe(1);
    expect(effectAmount(10)).toBe(3);
    expect(effectAmount(0.1)).toBe(0.3);
    expect(effectAmount(-1)).toBe(1);
  });
  it('keys outlines by model, size and picture', () => {
    const a = subjectKey('x', { model: 'birefnet', side: 1024 });
    expect(a).not.toBe(subjectKey('x', { model: 'birefnet-lite', side: 1024 }));
    expect(a).not.toBe(subjectKey('y', { model: 'birefnet', side: 1024 }));
  });
  it('makes a setup only from a usable pack', () => {
    expect(subjectSetupOf(null)).toBeNull();
    expect(subjectSetupOf({ available: false, problem: 'x', folder: null, device: null, deviceKnown: false })).toBeNull();
    expect(subjectSetupOf({ available: true, problem: null, folder: null, device: 'gpu', deviceKnown: true, model: 'birefnet-lite', inputSide: 512 })).toEqual({ model: 'birefnet-lite', side: 512 });
    expect(subjectSetupOf({ available: true, problem: null, folder: null, device: 'gpu', deviceKnown: true, model: 'birefnet' })?.side).toBe(1024);
  });
  it('parses what subject_estimate sends back', () => {
    const b = new Uint8Array(8 + 6);
    new DataView(b.buffer).setUint32(0, 3, true);
    new DataView(b.buffer).setUint32(4, 2, true);
    b.set([0, 255, 0, 10, 20, 30], 8);
    expect(parseSubject(b)).toEqual({ w: 3, h: 2, data: new Uint8Array([0, 255, 0, 10, 20, 30]) });
    expect(() => parseSubject(new Uint8Array(9))).toThrow();
  });
});

describe('subject effects: where the subject is', () => {
  it('finds the box, bottom middle, centre and coverage', () => {
    const st = maskStats(rectMask(200, 100, { x0: 0.25, y0: 0.2, x1: 0.75, y1: 0.9 }))!;
    expect(st).not.toBeNull();
    expect(st.box.x0).toBeCloseTo(0.25, 2);
    expect(st.box.x1).toBeCloseTo(0.75, 2);
    expect(st.box.y0).toBeCloseTo(0.2, 2);
    expect(st.box.y1).toBeCloseTo(0.9, 2);
    expect(st.bottom.x).toBeCloseTo(0.5, 2);
    expect(st.bottom.y).toBeCloseTo(0.9, 2);
    expect(st.centroid.x).toBeCloseTo(0.5, 2);
    expect(st.centroid.y).toBeCloseTo(0.55, 2);
    expect(st.coverage).toBeCloseTo(0.35, 2);
  });
  it('skips empty outlines and ones that cover everything', () => {
    expect(maskStats(null)).toBeNull();
    expect(maskStats({ w: 10, h: 10, data: new Uint8Array(100) })).toBeNull();
    expect(maskStats({ w: 10, h: 10, data: new Uint8Array(100).fill(255) })).toBeNull();
    expect(maskStats({ w: 10, h: 10, data: new Uint8Array(5) })).toBeNull();
  });
  it("averages the depth under the subject (flat depth stays in the middle)", () => {
    const mask = rectMask(64, 64, { x0: 0, y0: 0.5, x1: 1, y1: 1 });
    const depth = { w: 2, h: 2, data: new Uint8Array([0, 0, 255, 255]) };
    expect(subjectDepth(depth, mask)).toBeCloseTo(1, 2);
    expect(subjectDepth(flatDepth(), mask)).toBeCloseTo(128 / 255, 3);
    expect(subjectDepth(depth, { w: 4, h: 4, data: new Uint8Array(16) })).toBeNull();
  });
});

describe('subject effects: the movement', () => {
  const st = maskStats(rectMask(100, 100, { x0: 0.3, y0: 0.2, x1: 0.7, y1: 1 }))!;

  it('eases Lift-off in and out without jumping', () => {
    const f = newFade(0);
    fadeTo(f, 1, 1000);
    expect(fadeAt(f, 1000)).toBe(0);
    expect(fadeAt(f, 1000 + LIFT_MS / 2)).toBeGreaterThan(0.5);
    expect(fadeAt(f, 1000 + LIFT_MS)).toBe(1);
    expect(fadeDone(f, 1000 + LIFT_MS)).toBe(true);
    const mid = fadeAt(f, 1200);
    fadeTo(f, 0, 1200);
    expect(fadeAt(f, 1200)).toBeCloseTo(mid, 10);
    expect(fadeAt(f, 1200 + LIFT_MS)).toBe(0);
  });
  it('Lift-off grows the subject by about 3.5% × amount with a shadow; off is the plain picture', () => {
    const off = subjectFrame(st, 1.5, { level: 0, amount: 1 });
    expect(off.lift).toBe(1);
    expect(off.shadow).toBe(0);
    expect(off.grow).toBe(0);
    const p = { x: 0.31, y: 0.25 };
    expect(moveSubjectPoint(off, 1.5, p).x).toBeCloseTo(p.x, 12);
    const on = subjectFrame(st, 1.5, { level: 1, amount: 2 });
    expect(on.lift).toBeCloseTo(1 + LIFT_GROW * 2, 12);
    expect(on.shadow).toBeCloseTo(0.35, 12);
    expect(on.shadowOffset.x).toBeGreaterThan(0);
    expect(on.shadowOffset.y).toBeGreaterThan(0);
  });
  it('the shader’s reverse move undoes the move', () => {
    const f = subjectFrame(st, 1.5, { level: 0.7, amount: 2 });
    for (const p of [{ x: 0.3, y: 0.2 }, { x: 0.7, y: 1 }, { x: 0.5, y: 0.5 }, { x: 0.1, y: 0.9 }]) {
      const q = unmoveSubjectPoint(f, 1.5, moveSubjectPoint(f, 1.5, p));
      expect(q.x).toBeCloseTo(p.x, 10);
      expect(q.y).toBeCloseTo(p.y, 10);
    }
  });
});

describe('subject effects: the queue', () => {
  it('works out the urgent picture first and remembers it', async () => {
    const order: string[] = [];
    setSubjectSetupForTests({ model: 'birefnet', side: 4 });
    setSubjectCompute(async (src) => {
      order.push(src);
      await new Promise((r) => setTimeout(r, 1));
      return { w: 1, h: 1, data: new Uint8Array([255]) };
    });
    subjectAhead(['a', 'b', 'c']);
    const m = await subjectOf('now', true);
    expect(m?.w).toBe(1);
    // 'a' had already started; 'now' comes straight after it.
    expect(order.indexOf('now')).toBeLessThanOrEqual(1);
    await subjectOf('c');
    expect(order.filter((s) => s === 'now').length).toBe(1);
    await subjectOf('now');
    expect(order.filter((s) => s === 'now').length).toBe(1);
    setSubjectCompute(null);
    setSubjectSetupForTests(null);
  });
});
