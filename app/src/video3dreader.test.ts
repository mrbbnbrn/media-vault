import { describe, expect, it } from 'vitest';
import { frameReader, type FrameIo } from './video3d';

// A pretend video: 30 frames at 10 fps, 2 × 1 pixels, each frame's red = its number.
const W = 2;
const H = 1;
function batch(ts: number[], done: boolean): Uint8Array {
  const px = W * H * 4;
  const b = new Uint8Array(8 + ts.length * 8 + ts.length * px);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, ts.length, true);
  b[4] = done ? 1 : 0;
  ts.forEach((t, i) => {
    dv.setFloat64(8 + i * 8, t, true);
    b[8 + ts.length * 8 + i * px] = Math.round(t * 10);
  });
  return b;
}
/** The app's reader, stopped after `dieAfter` reads of each decoder (as the idle timeout did). */
function fakeIo(dieAfter: number, failOpens = 0) {
  const opened: number[] = [];
  let reads = 0;
  let pos = 0;
  let id = 0;
  let opensLeftToFail = failOpens;
  const io: FrameIo = {
    async open(from) {
      if (opened.length && opensLeftToFail-- > 0) throw new Error("couldn't open");
      opened.push(from);
      // ffmpeg's seek can land on the frame before the one asked for.
      pos = Math.max(0, Math.ceil(from * 10 - 1e-9) - 1);
      reads = 0;
      return { id: ++id };
    },
    async read() {
      if (reads++ >= dieAfter) throw new Error("That video isn't being prepared any more.");
      const ts: number[] = [];
      while (ts.length < 4 && pos < 30) ts.push(pos++ / 10);
      return batch(ts, pos >= 30);
    },
    async close() {},
  };
  return { io, opened };
}
async function all(io: FrameIo) {
  const src = await frameReader(io, W, H, 0, 3);
  const got: number[] = [];
  for (;;) {
    const f = await src.next();
    if (!f) break;
    got.push(f.rgba[0]);
  }
  return got;
}

describe('prepared 3D: the video reader', () => {
  it('reads every frame once, in order', async () => {
    const { io, opened } = fakeIo(99);
    expect(await all(io)).toEqual([...Array(30).keys()]);
    expect(opened).toEqual([0]);
  });
  it('a reader stopped part way (left unasked too long) is opened again after the last frame: none lost, none twice', async () => {
    const { io, opened } = fakeIo(2);
    expect(await all(io)).toEqual([...Array(30).keys()]);
    expect(opened.length).toBeGreaterThan(2);
    expect(opened[1]).toBeCloseTo(0.7 + 0.0005);
  });
  it('gives up on a reader that keeps failing', async () => {
    const { io } = fakeIo(0);
    await expect(all(io)).rejects.toThrow("isn't being prepared");
  });
});
