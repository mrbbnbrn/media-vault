import { describe, expect, it } from 'vitest';
import { applyLayer, diffLayer, packedSize, packLayer, unpackLayer } from './layerpack';

function picture(w: number, h: number) {
  const a = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    a[i * 4] = (i * 13) % 256;
    a[i * 4 + 1] = (i * 7) % 256;
    a[i * 4 + 2] = (i * 3) % 256;
    a[i * 4 + 3] = 255;
  }
  return a;
}

describe('saved 3D layers', () => {
  it('keeps only what differs, and gives back exactly the layer', async () => {
    const w = 37, h = 23;
    const orig = picture(w, h);
    const layer = orig.slice();
    // A filled-in area and a depth in the alpha.
    for (let y = 5; y < 15; y++) for (let x = 10; x < 20; x++) layer.set([90, 120, 30], (y * w + x) * 4);
    for (let i = 0; i < w * h; i++) layer[i * 4 + 3] = (i * 5) % 256;
    const { body, changed } = diffLayer(orig, layer, w, h);
    expect(changed).toBe(100);
    expect(applyLayer(orig, body, w, h, changed)).toEqual(layer);
    const packed = await packLayer(orig, layer, w, h);
    expect(packedSize(packed)).toEqual({ w, h });
    expect(await unpackLayer(orig, packed)).toEqual(layer);
  });

  it('refuses something that is not a packed layer', async () => {
    expect(packedSize(new Uint8Array(20))).toBeNull();
    await expect(unpackLayer(picture(2, 2), new Uint8Array(20))).rejects.toThrow();
  });
});
