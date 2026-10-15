import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { children, readWebmFrames, vint, writeWebm, WEBM_IDS } from './webm';

const FFMPEG = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => existsSync(p));

/** VP9 frames made by ffmpeg (IVF container: 32-byte header, then 12-byte frame headers). */
function vp9Frames(seconds: number, gop: number): { data: Uint8Array; timestampUs: number; key: boolean }[] {
  const r = spawnSync(FFMPEG!, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=426x240:rate=24:duration=${seconds}`, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', String(gop), '-f', 'ivf', 'pipe:1'], { maxBuffer: 64 << 20 });
  const b = new Uint8Array(r.stdout);
  const out = [];
  let p = 32;
  let i = 0;
  while (p + 12 <= b.length) {
    const size = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
    const data = b.slice(p + 12, p + 12 + size);
    // ffmpeg was asked for a keyframe every `gop` frames.
    out.push({ data, timestampUs: Math.round((i * 1e6) / 24), key: i % gop === 0 });
    p += 12 + size;
    i++;
  }
  return out;
}

describe('WebM writer', { timeout: 60_000 }, () => {
  it('writes sizes in the shortest form', () => {
    expect([...vint(0)]).toEqual([0x80]);
    expect([...vint(126)]).toEqual([0xfe]);
    expect([...vint(127)]).toEqual([0x40, 0x7f]);
    expect([...vint(300)]).toEqual([0x41, 0x2c]);
  });

  it('round-trips frames, keyframes start clusters, cues point at them', () => {
    const frames = Array.from({ length: 30 }, (_, i) => ({ data: new Uint8Array([i, 1, 2, 3]), timestampUs: i * 41_667, key: i % 10 === 0 }));
    const w = writeWebm({ codec: 'V_VP9', width: 426, height: 240 }, frames, 30 * 41_667);
    const r = readWebmFrames(w);
    expect(r.codec).toBe('V_VP9');
    expect([r.width, r.height]).toEqual([426, 240]);
    expect(r.durationMs).toBeCloseTo(1250, 0);
    expect(r.frames).toHaveLength(30);
    expect(r.frames.filter((f) => f.key).map((f) => f.ms)).toEqual([0, 417, 833]);
    expect(r.frames[29].ms).toBe(1208);
    // Every cue points at the start of a cluster (relative to the segment's data).
    const seg = children(w, 0, w.length).find((e) => e.id === WEBM_IDS.Segment)!;
    const clusters = children(w, seg.start, seg.end).filter((e) => e.id === WEBM_IDS.Cluster);
    expect(r.cues.map((c) => c.ms)).toEqual([0, 417, 833]);
    // A cluster element starts 4 (id) + size bytes before its data.
    r.cues.forEach((c, i) => {
      const at = seg.start + c.pos;
      expect([w[at], w[at + 1], w[at + 2], w[at + 3]]).toEqual([0x1f, 0x43, 0xb6, 0x75]);
      expect(at).toBeLessThan(clusters[i].start);
    });
  });

  it('refuses an empty clip', () => {
    expect(() => writeWebm({ codec: 'V_VP8', width: 2, height: 2 }, [])).toThrow();
  });

  it.skipIf(!FFMPEG)('makes a file ffmpeg plays to the last frame', () => {
    const frames = vp9Frames(3, 24);
    const w = writeWebm({ codec: 'V_VP9', width: 426, height: 240 }, frames);
    const r = spawnSync(FFMPEG!, ['-v', 'error', '-i', 'pipe:0', '-f', 'framemd5', 'pipe:1'], { input: w, maxBuffer: 64 << 20 });
    expect(r.status).toBe(0);
    expect(String(r.stderr)).toBe('');
    const lines = String(r.stdout).split('\n').filter((l) => /^\s*0,/.test(l));
    expect(lines).toHaveLength(frames.length);
    const probe = spawnSync(FFMPEG!.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'pipe:0'], { input: w });
    if (probe.status === 0) expect(Number(String(probe.stdout).trim())).toBeCloseTo(3, 1);
  });
});
