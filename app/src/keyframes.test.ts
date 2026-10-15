import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyframeNear, mp4Keyframes, readKeyframes, type RangeReader } from './keyframes';

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => existsSync(p));
const FFPROBE = FFMPEG?.replace(/ffmpeg$/, 'ffprobe');

function make(args: string[]): Uint8Array {
  const r = spawnSync(FFMPEG!, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=12', ...args, 'pipe:1'], { maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return new Uint8Array(r.stdout);
}

const reader = (b: Uint8Array): RangeReader & { calls: number } => {
  const f = (async (start: number, end: number) => {
    f.calls++;
    return { bytes: b.subarray(start, Math.min(end, b.length)), total: b.length };
  }) as RangeReader & { calls: number };
  f.calls = 0;
  return f;
};

const box = (type: string, ...parts: Uint8Array[]) => {
  const n = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  new DataView(out.buffer).setUint32(0, n);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const be = (...xs: number[]) => {
  const out = new Uint8Array(xs.length * 4);
  xs.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x >>> 0));
  return out;
};

describe('keyframe index', () => {
  it('reads keyframes from sample tables (with a composition offset and an edit list)', () => {
    // 10 samples of 1000 ticks at 10000/s, keyframes at samples 1 and 6 (1-based), offset 2000, edit list shift 2000.
    const hdlr = box('hdlr', be(0, 0), new TextEncoder().encode('vide'), be(0, 0, 0), new Uint8Array([0]));
    const mdhd = box('mdhd', be(0, 0, 0, 10000, 10000), new Uint8Array(4));
    const stts = box('stts', be(0, 1, 10, 1000));
    const stss = box('stss', be(0, 2, 1, 6));
    const ctts = box('ctts', be(0, 1, 10, 2000));
    const stbl = box('stbl', stts, stss, ctts);
    const elst = box('elst', be(0, 1, 10000, 2000, 0x10000));
    const trak = box('trak', box('edts', elst), box('mdia', mdhd, hdlr, box('minf', stbl)));
    const moov = box('moov', trak);
    expect(mp4Keyframes(moov, { type: 'moov', start: 8, end: moov.length })).toEqual([0, 0.5]);
    // No sync table: every frame is a keyframe.
    const all = box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', stts)))));
    expect(mp4Keyframes(all, { type: 'moov', start: 8, end: all.length })).toBe('all');
    // A fragmented MP4 has no samples in its moov.
    const frag = box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', box('stbl', box('stts', be(0, 0)))))));
    expect(mp4Keyframes(frag, { type: 'moov', start: 8, end: frag.length })).toBeNull();
  });

  it('picks the nearest keyframe within reach, a hair after it', () => {
    expect(keyframeNear([0, 2, 4, 6], 4.6, 1)).toBeCloseTo(4.001);
    expect(keyframeNear([0, 10], 5, 2)).toBe(5);
    expect(keyframeNear('all', 3, 1)).toBe(3);
    expect(keyframeNear(null, 3, 1)).toBe(3);
    expect(keyframeNear([0, 9.99], 9.9, 1, 10)).toBe(9.9);
  });

  /** Encode the test pattern into a file (in a temporary folder) and read it back. */
  const file = (ext: string, args: string[]): { bytes: Uint8Array; keys: number[] } => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-kf-'));
    try {
      const f = join(dir, `a.${ext}`);
      const r = spawnSync(FFMPEG!, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=12', ...args, f]);
      if (r.status !== 0) throw new Error(String(r.stderr));
      const p = spawnSync(FFPROBE!, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', f]);
      const keys = String(p.stdout).split('\n').filter((l) => l.includes('K')).map((l) => Number(l.split(',')[0])).sort((a, z) => a - z);
      return { bytes: new Uint8Array(readFileSync(f)), keys };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.skipIf(!FFMPEG)('matches ffprobe for an MP4 with the index at the end, B-frames and an edit list', async () => {
    const { bytes, keys } = file('mp4', ['-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-bf', '2']);
    expect(keys.length).toBeGreaterThan(3);
    const rd = reader(bytes);
    expect(await readKeyframes(rd)).toEqual(keys.map((t) => expect.closeTo(t, 3)));
    // The first 256 KB, then the box after the frames.
    expect(rd.calls).toBeLessThanOrEqual(3);
    // With the index in front, one read is enough.
    const fast = file('mp4', ['-c:v', 'libx264', '-g', '50', '-bf', '2', '-movflags', '+faststart']);
    const rf = reader(fast.bytes);
    expect(await readKeyframes(rf)).toEqual(fast.keys.map((t) => expect.closeTo(t, 3)));
    expect(rf.calls).toBe(1);
  });

  it.skipIf(!FFMPEG)('can\'t tell for a fragmented MP4', async () => {
    expect(await readKeyframes(reader(make(['-c:v', 'libx264', '-f', 'mp4', '-movflags', '+empty_moov+frag_keyframe'])))).toBeNull();
  });

  it.skipIf(!FFMPEG)('reads WebM cues (keyframes at cluster starts)', async () => {
    const { bytes, keys } = file('webm', ['-c:v', 'libvpx', '-deadline', 'realtime', '-g', '75']);
    const cues = await readKeyframes(reader(bytes));
    expect(Array.isArray(cues) && cues.length).toBeTruthy();
    for (const t of cues as number[]) expect(keys.some((k) => Math.abs(k - t) < 0.01)).toBe(true);
  });
});
