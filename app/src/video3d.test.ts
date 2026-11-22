import { describe, expect, it } from 'vitest';
import {
  BG_FRESH, calmDepth, calmMask, GATE, lumaGrid, motionBetween, motionDamp, newBgMemory, packTiles, readTile, rememberBackground,
  roundInfo, smoothInfo, tileRect, tileSize, type FrameInfo,
} from './video3dmath';
import { covers, frameStep, packIndex, packSegment, parseIndex, parseSegment, parseTrackTag, segmentFor, trackTag, type TrackIndex } from './trackformat';
import { composePlate, plateHole } from './platemath';
import { mapLabel } from './derived';

/** A w × h RGBA frame, grey `v`, with a w2 × h2 block of grey `b` at (x0, y0). */
function frame(w: number, h: number, v: number, block?: { x0: number; y0: number; w: number; h: number; b: number }): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const inB = block && x >= block.x0 && x < block.x0 + block.w && y >= block.y0 && y < block.y0 + block.h;
      const g = inB ? block!.b : v;
      const i = (y * w + x) * 4;
      out[i] = g;
      out[i + 1] = g;
      out[i + 2] = g;
      out[i + 3] = 255;
    }
  return out;
}
const map = (w: number, h: number, f: (x: number, y: number) => number) => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { w, h, data };
};

describe('prepared 3D: motion between frames', () => {
  it('sees still, moving and a new scene', () => {
    const a = lumaGrid(frame(192, 108, 100), 192, 108);
    expect(a.length).toBe(GATE * GATE);
    const first = motionBetween(a, null);
    expect(first.cut).toBe(true);
    const same = motionBetween(a, a);
    expect(same.cut).toBe(false);
    expect(same.moving).toBe(0);
    expect(Math.min(...same.gate)).toBe(1);
    // A block moved in: still elsewhere, moving there (and next to it).
    const b = lumaGrid(frame(192, 108, 100, { x0: 0, y0: 0, w: 40, h: 40, b: 220 }), 192, 108);
    const m = motionBetween(b, a);
    expect(m.cut).toBe(false);
    expect(m.moving).toBeGreaterThan(0.05);
    expect(m.gate[0]).toBe(0);
    expect(m.gate[GATE * GATE - 1]).toBe(1);
    // Everything changed a lot: a new scene.
    expect(motionBetween(lumaGrid(frame(192, 108, 240), 192, 108), a).cut).toBe(true);
  });
});

describe('prepared 3D: calming over time', () => {
  const still = motionBetween(new Float32Array(GATE * GATE).fill(50), new Float32Array(GATE * GATE).fill(50));
  it('keeps the depth range steady where nothing moved', () => {
    const prev = map(64, 64, (x) => 40 + x * 2);
    // The model's whole range jumped (the scene "breathes"): lined up with the last frame again.
    const raw = map(64, 64, (x) => Math.round((40 + x * 2) * 1.3 + 10));
    const out = calmDepth(raw, prev, still);
    let err = 0;
    for (let i = 0; i < out.data.length; i++) err = Math.max(err, Math.abs(out.data[i] - prev.data[i]));
    expect(err).toBeLessThan(12);
    // Without calming the jump would be far bigger.
    expect(Math.abs(raw.data[63] - prev.data[63])).toBeGreaterThan(40);
  });
  it('follows the new depth where things moved, and starts fresh on a new scene', () => {
    const prev = map(64, 64, () => 50);
    const raw = map(64, 64, () => 200);
    const moved = { gate: new Float32Array(GATE * GATE), cut: false, moving: 1 };
    expect(calmDepth(raw, prev, moved).data[0]).toBeGreaterThan(150);
    expect(calmDepth(raw, prev, { ...still, cut: true })).toBe(raw);
    expect(calmDepth(raw, null, still)).toBe(raw);
  });
  it('blends the outline only where still', () => {
    const prev = map(32, 32, () => 255);
    const raw = map(32, 32, () => 0);
    expect(calmMask(raw, prev, still).data[0]).toBe(128);
    const moved = { gate: new Float32Array(GATE * GATE), cut: false, moving: 1 };
    expect(calmMask(raw, prev, moved).data[0]).toBe(0);
  });
});

describe('prepared 3D: tiles', () => {
  it('packs every map into its own tile', () => {
    const { w, h } = tileSize(1920, 1080, 768);
    expect([w, h]).toEqual([768, 432]);
    expect(tileSize(101, 51, 768)).toEqual({ w: 102, h: 52 });
    const tw = 8;
    const th = 4;
    const depth = map(16, 16, () => 77);
    const mask = map(4, 4, () => 200);
    const plate = new Uint8Array(tw * th * 4).fill(10);
    for (let i = 3; i < plate.length; i += 4) plate[i] = 33;
    const packed = packTiles(tw, th, { depth, mask, plate, fore: null });
    expect(packed.length).toBe(tw * 3 * th * 2 * 4);
    expect(readTile(packed, tw, th, 'depth')[5]).toBe(77);
    expect(readTile(packed, tw, th, 'mask')[0]).toBe(200);
    expect(readTile(packed, tw, th, 'plateDepth')[0]).toBe(33);
    expect(readTile(packed, tw, th, 'plate')[0]).toBe(10);
    expect(readTile(packed, tw, th, 'foreDepth')[0]).toBe(0);
    expect(tileRect('plateDepth')).toEqual([1 / 3, 1 / 2, 1 / 3, 1 / 2]);
  });
});

describe('prepared 3D: background seen before fills in behind the subject', () => {
  it('uses the remembered background, not the guess', () => {
    const w = 40;
    const h = 20;
    const still = motionBetween(new Float32Array(GATE * GATE).fill(50), new Float32Array(GATE * GATE).fill(50));
    const mem = newBgMemory(w, h);
    // First the background alone (a striped wall), then a subject stands in front of part of it.
    const wall = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const g = (i % w) % 2 ? 200 : 40;
      wall.set([g, g, g, 255], i * 4);
    }
    rememberBackground(mem, wall, new Float32Array(w * h), still);
    expect(mem.age[0]).toBe(0);
    const mask = map(w, h, (x) => (x >= 10 && x < 20 ? 255 : 0));
    const withSubject = new Uint8ClampedArray(wall);
    for (let y = 0; y < h; y++) for (let x = 10; x < 20; x++) withSubject.set([255, 0, 0, 255], (y * w + x) * 4);
    const depth = map(w, h, () => 100);
    const plate = composePlate(withSubject, w, h, mask, depth, null, { rgb: mem.rgb, age: mem.age, fresh: BG_FRESH });
    const at = (x: number) => plate[(10 * w + x) * 4];
    // Behind the subject: the stripes again (not red, not a smudge).
    expect(at(14)).toBe(40);
    expect(at(15)).toBe(200);
    expect(plate[(10 * w + 15) * 4 + 1]).toBe(200);
    // A moving camera forgets it all.
    rememberBackground(mem, wall, plateHole(mask, w, h), { ...still, moving: 0.9 });
    expect(mem.age[0]).toBe(65535);
  });
});

describe('prepared 3D: each frame’s numbers', () => {
  const st = { box: { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.9 }, bottom: { x: 0.4, y: 0.9 }, centroid: { x: 0.4, y: 0.5 }, coverage: 0.2 };
  it('smooths them unless the scene changed', () => {
    const a: FrameInfo = { p: 0.5, z: 0.6, b: 0.4, st, mo: 0 };
    const b: FrameInfo = { p: 0.7, z: 0.8, b: 0.2, st: { ...st, centroid: { x: 0.8, y: 0.5 } }, mo: 1 };
    const s = smoothInfo(a, b, false);
    expect(s.p).toBeCloseTo(0.56, 5);
    expect(s.st!.centroid.x).toBeCloseTo(0.52, 5);
    expect(smoothInfo(a, b, true)).toBe(b);
    expect(roundInfo({ ...a, p: 0.123456789 }).p).toBe(0.1235);
  });
  it('calms the 3D on fast scenes only when asked', () => {
    expect(motionDamp(0, true)).toBe(1);
    expect(motionDamp(1, true)).toBeCloseTo(0.4, 5);
    expect(motionDamp(1, false)).toBe(1);
  });
});

describe('prepared 3D: saved format', () => {
  const info: FrameInfo = { p: 0.5, z: null, b: null, st: null, mo: 0.1 };
  it('reads back pieces and the index exactly', () => {
    const seg = packSegment('vp09.00.40.08', 96, 64, [
      { t: 0, key: true, i: info, bytes: new Uint8Array([1, 2, 3]) },
      { t: 0.04, key: false, i: { ...info, mo: 0.5 }, bytes: new Uint8Array([4, 5]) },
    ]);
    const s = parseSegment(seg)!;
    expect(s.codec).toBe('vp09.00.40.08');
    expect([s.cw, s.ch]).toEqual([96, 64]);
    expect(s.frames.map((f) => [f.t, f.key, f.i.mo])).toEqual([[0, true, 0.1], [0.04, false, 0.5]]);
    expect(s.chunks.map((c) => [...c])).toEqual([[1, 2, 3], [4, 5]]);
    expect(parseSegment(seg.slice(0, seg.length - 1))).toBeNull();
    expect(parseSegment(new Uint8Array([1, 2, 3]))).toBeNull();
    const idx: TrackIndex = {
      v: 1, tag: 't', kind: 'video', w: 32, h: 32, codec: 'webp', every: 1, complete: false,
      segs: [{ n: 0, t0: 0, t1: 1.88, frames: 48, bytes: 10 }, { n: 1, t0: 1.92, t1: 3.8, frames: 48, bytes: 10 }],
      has: { subject: true, plate: true }, models: { depth: 'v2-small@518~1', subject: 'birefnet@1024', fill: 'simple', edges: 0 }, duration: 4, made: 1,
    };
    expect(parseIndex(packIndex(idx))).toEqual(idx);
    expect(parseIndex(new Uint8Array([77, 86, 51, 73, 123]))).toBeNull();
    expect(frameStep(idx)).toBeCloseTo(0.04, 6);
    expect(segmentFor(idx.segs, 0, 0.02)).toBe(0);
    expect(segmentFor(idx.segs, 1.89, 0.02)).toBe(0);
    expect(segmentFor(idx.segs, 1.91, 0.02)).toBe(1);
    expect(segmentFor(idx.segs, -1, 0.02)).toBe(-1);
    expect(covers(idx, 3.81)).toBe(true);
    expect(covers(idx, 5)).toBe(false);
  });
  it('names what it was made with, and reads it back for the labels', () => {
    const tag = trackTag({ depth: 'da3-mono-large@518~0.5', subject: 'birefnet@1024', edges: 0.7, fill: 'lama', size: 768, every: 2 });
    expect(tag).toBe('da3-mono-large@518~0.5_birefnet@1024_e0.70_lama_w768_f2');
    expect(/^[a-z0-9@~._-]+$/.test(tag)).toBe(true);
    expect(parseTrackTag(tag)).toEqual({ depth: 'da3-mono-large@518~0.5', subject: 'birefnet@1024', edges: 0.7, fill: 'lama', size: 768, every: 2 });
    const plain = trackTag({ depth: 'v2-small@518~1', subject: '', edges: 0, fill: '', size: 512, every: 1 });
    expect(plain).toBe('v2-small@518~1_none_e0.00_none_w512_f1');
    expect(parseTrackTag(plain)).toEqual({ depth: 'v2-small@518~1', subject: '', edges: 0, fill: '', size: 512, every: 1 });
    const l = mapLabel('track', tag, new Map([['da3-mono-large', 'Best'], ['birefnet', 'BiRefNet']]));
    expect(l.name).toBe('Best');
    expect(l.detail).toBe('outline BiRefNet · sharper edges · LaMa fill · 768 px · every 2nd frame');
  });
});
