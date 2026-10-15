import { describe, expect, it } from 'vitest';
import { rawBody } from './api';

function split(body: Uint8Array): [unknown, Uint8Array] {
  const n = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
  return [JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + n))), body.subarray(4 + n)];
}

describe('bytes sent to the backend', () => {
  it('go raw after the other arguments, from bytes or a number list', () => {
    const [args, bytes] = split(rawBody({ id: 7, width: null, sharper: true }, new Uint8Array([0, 1, 255])));
    expect(args).toEqual({ id: 7, width: null, sharper: true });
    expect(Array.from(bytes)).toEqual([0, 1, 255]);
    const [, again] = split(rawBody({ id: 1 }, [9, 8]));
    expect(Array.from(again)).toEqual([9, 8]);
  });

  it('are about the size of the data, not several times it', () => {
    const thumb = new Uint8Array(60_000).map((_, i) => (i * 37) % 256);
    const raw = rawBody({ id: 123456, width: 1920, height: 1080, durationMs: null, sharper: false }, thumb).length;
    const json = JSON.stringify({ id: 123456, data: Array.from(thumb), width: 1920, height: 1080, durationMs: null, sharper: false }).length;
    expect(raw).toBeLessThan(thumb.length + 100);
    expect(json / raw).toBeGreaterThan(3);
  });

  it('carry smart-search vectors as little-endian floats', () => {
    const v = new Float32Array([1, -2.5, 0.125]);
    const [, bytes] = split(rawBody({ media: 3 }, new Uint8Array(Float32Array.from(v).buffer)));
    const back = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([0, 1, 2].map((i) => back.getFloat32(i * 4, true))).toEqual([1, -2.5, 0.125]);
  });
});
