import { afterEach, describe, expect, it } from 'vitest';
import type { DepthMap } from './api';
import {
  applyDepthSetup, depthAhead, depthChoice, depthKey, depthLetGo, depthOf, forgetDepth, knownDepth, pickAhead, setDepthCompute, setupOf, speedText,
  type DepthSetup,
} from './depth';

const FAST: DepthSetup = { model: 'v2-small', side: 518, detail: 'standard' };
const BAL: DepthSetup = { model: 'da3-base', side: 518, detail: 'standard' };
const BAL_HIGH: DepthSetup = { model: 'da3-base', side: 756, detail: 'high' };

const map = (tag: number): DepthMap => ({ w: 1, h: 1, data: new Uint8Array([tag]) });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A pretend model: records what it was asked for; each job finishes when released. */
function fakeModel() {
  const asked: string[] = [];
  const jobs: { src: string; s: DepthSetup; done: (m: DepthMap | null) => void }[] = [];
  setDepthCompute((src, s) => {
    asked.push(`${s.model}@${s.side}:${src}`);
    return new Promise((done) => jobs.push({ src, s, done }));
  });
  /** Finish the job running now. */
  const finish = async (tag = 1) => {
    await tick();
    const j = jobs.shift();
    j?.done(map(tag));
    await tick();
    return j;
  };
  return { asked, jobs, finish };
}

afterEach(() => {
  forgetDepth();
  applyDepthSetup(null);
  setDepthCompute(null);
});

describe('3D photos: depth maps per model', () => {
  it('keys a map by picture, model and size', () => {
    expect(depthKey('a.jpg', FAST)).not.toBe(depthKey('a.jpg', BAL));
    expect(depthKey('a.jpg', BAL)).not.toBe(depthKey('a.jpg', BAL_HIGH));
    expect(depthKey('a.jpg', BAL)).toBe(depthKey('a.jpg', { ...BAL }));
    expect(depthKey('a.jpg', BAL)).not.toBe(depthKey('b.jpg', BAL));
  });

  it('reads the setup from depth_info, and the choice safely from the settings', () => {
    expect(setupOf(null)).toBeNull();
    expect(setupOf({ available: false, problem: 'x', folder: null, device: null, deviceKnown: false, sharedRuntime: false })).toBeNull();
    expect(setupOf({ available: true, problem: null, folder: null, device: 'gpu', deviceKnown: false, sharedRuntime: false, model: 'da3-base', inputSide: 756, detail: 'high' }))
      .toEqual({ ...BAL_HIGH, soft: 1 });
    // Best's edges are softened half as much unless "Edges" says otherwise; the setting is held in range.
    const best = { available: true, problem: null, folder: null, device: 'gpu' as const, deviceKnown: false, sharedRuntime: false, model: 'da3-mono-large', inputSide: 518 };
    expect(setupOf(best)?.soft).toBe(0.5);
    expect(setupOf(best, 1.5)?.soft).toBe(1.5);
    expect(setupOf(best, 9)?.soft).toBe(2);
    expect(setupOf(best, 0)?.soft).toBe(0.5);
    expect(depthKey('a.jpg', { ...FAST, soft: 0.5 })).not.toBe(depthKey('a.jpg', FAST));
    // An older answer without a size: the Fast size.
    expect(setupOf({ available: true, problem: null, folder: null, device: 'gpu', deviceKnown: false, sharedRuntime: false })?.side).toBe(518);
    expect(depthChoice({})).toEqual({ model: '', detail: 'standard' });
    expect(depthChoice({ depthModel: 'da3-base', depthDetail: 'high' })).toEqual({ model: 'da3-base', detail: 'high' });
    expect(depthChoice({ depthModel: 7 as unknown as string, depthDetail: 'ultra' as 'high' })).toEqual({ model: '', detail: 'standard' });
  });

  it('forgets the maps when another model or detail is chosen, not when the same one is asked again', async () => {
    const m = fakeModel();
    applyDepthSetup(FAST);
    const p = depthOf('a.jpg', true);
    await m.finish(5);
    expect((await p)?.data[0]).toBe(5);
    expect(knownDepth('a.jpg')?.data[0]).toBe(5);
    applyDepthSetup({ ...FAST });
    expect(knownDepth('a.jpg')?.data[0]).toBe(5);
    // Another model: gone, and worked out again with the new one.
    applyDepthSetup(BAL);
    expect(knownDepth('a.jpg')).toBeUndefined();
    const q = depthOf('a.jpg', true);
    await m.finish(6);
    expect((await q)?.data[0]).toBe(6);
    expect(m.asked).toEqual(['v2-small@518:a.jpg', 'da3-base@518:a.jpg']);
    // Another detail (size): gone too; going back doesn't bring the old ones back.
    applyDepthSetup(BAL_HIGH);
    expect(knownDepth('a.jpg')).toBeUndefined();
    applyDepthSetup(BAL);
    expect(knownDepth('a.jpg')).toBeUndefined();
  });

  it("drops a map that was being made when the model changed", async () => {
    const m = fakeModel();
    applyDepthSetup(FAST);
    const p = depthOf('a.jpg', true);
    await tick();
    applyDepthSetup(BAL);
    expect(await p).toBeNull();
    await m.finish(9); // the old model's answer arrives late
    expect(knownDepth('a.jpg')).toBeUndefined();
  });
});

describe('3D photos: working ahead', () => {
  const img = (n: string) => ({ kind: 'image', src: n });
  const vid = (n: string) => ({ kind: 'video', src: n });

  it('picks the next two pictures and the previous one, skipping videos', () => {
    expect(pickAhead([img('n1'), img('n2'), img('n3')], [img('p1'), img('p2')])).toEqual(['n1', 'n2', 'p1']);
    expect(pickAhead([vid('v'), img('n1'), vid('w'), img('n2'), img('n3')], [vid('pv'), img('p1')])).toEqual(['n1', 'n2', 'p1']);
    expect(pickAhead([], [])).toEqual([]);
    expect(pickAhead([img('a')], [img('a')])).toEqual(['a']); // a short list wraps round: once is enough
    expect(pickAhead([{ kind: 'gif', src: 'g' }], [])).toEqual([]);
  });

  it('a new list replaces the old one: quick browsing never piles up work', async () => {
    const m = fakeModel();
    applyDepthSetup(FAST);
    depthAhead(['a', 'b', 'c']);
    await tick(); // 'a' starts
    depthAhead(['d', 'e', 'f']); // moved on: 'b' and 'c' aren't wanted any more
    await m.finish(); // a
    await m.finish(); // d
    await m.finish(); // e
    await m.finish(); // f
    await m.finish();
    expect(m.asked.map((s) => s.split(':')[1])).toEqual(['a', 'd', 'e', 'f']);
    expect(knownDepth('a')).toBeDefined(); // the one already running is kept
    expect(knownDepth('b')).toBeUndefined();
  });

  it('at most three ahead, and the picture on screen goes first (the newest one first)', async () => {
    const m = fakeModel();
    applyDepthSetup(FAST);
    depthAhead(['a', 'b', 'c', 'd', 'e']);
    await tick(); // 'a' starts
    void depthOf('x', true);
    void depthOf('y', true);
    for (let i = 0; i < 6; i++) await m.finish();
    expect(m.asked.map((s) => s.split(':')[1])).toEqual(['a', 'y', 'x', 'b', 'c']);
  });

  it('a picture left before its depth came is dropped (unless still wanted ahead)', async () => {
    const m = fakeModel();
    applyDepthSetup(FAST);
    void depthOf('busy', true);
    await tick(); // 'busy' starts
    const left = depthOf('left', true);
    depthAhead(['next']);
    const kept = depthOf('next', true);
    depthLetGo('left');
    depthLetGo('next');
    expect(await left).toBeNull();
    for (let i = 0; i < 3; i++) await m.finish(3);
    expect((await kept)?.data[0]).toBe(3);
    expect(m.asked.map((s) => s.split(':')[1])).toEqual(['busy', 'next']);
  });
});

describe('3D photos: speed test wording', () => {
  it('says seconds per picture and where it ran', () => {
    expect(speedText({ ms: 150, device: 'gpu', loadMs: 0 })).toBe('0.15 s per picture on the graphics card');
    expect(speedText({ ms: 2340, device: 'cpu', loadMs: 0 })).toBe('2.3 s per picture on the processor');
    expect(speedText({ ms: 12600, device: 'cpu', loadMs: 0 })).toBe('13 s per picture on the processor');
  });
});
