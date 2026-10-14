import { describe, expect, it } from 'vitest';
import { upscaleBody } from './api';
import { factorText, fivePoints, modelLabel, upscaleFactor } from './upscale';

describe('upscaler rules', () => {
  it('upscales small pictures ×4 and bigger ones less', () => {
    expect(upscaleFactor(800, 600)).toEqual({ factor: 4 });
    expect(upscaleFactor(2000, 1500)).toEqual({ factor: 2.4 });
    expect('error' in upscaleFactor(4000, 3000)).toBe(true);
    expect('error' in upscaleFactor(0, 10)).toBe(true);
    expect(factorText(4)).toBe('×4');
    expect(factorText(2.36)).toBe('×2.4');
  });

  it('takes the 5 face points from the 68', () => {
    const p68 = Array.from({ length: 68 }, (_, i) => [i, 100 + i] as [number, number]);
    const five = fivePoints(p68)!;
    expect(five[0]).toEqual([38.5, 138.5]); // mean of 36…41
    expect(five[1]).toEqual([44.5, 144.5]);
    expect(five[2]).toEqual([30, 130]);
    expect(five[3]).toEqual([48, 148]);
    expect(five[4]).toEqual([54, 154]);
    expect(fivePoints(p68.slice(0, 10))).toBeNull();
  });

  it('names the models', () => {
    expect(modelLabel('realesrgan')).toBe('Real-ESRGAN');
    expect(modelLabel('gfpgan')).toBe('GFPGAN');
  });

  it('packs the request in front of the pixels', () => {
    const rgba = new Uint8Array([1, 2, 3, 4]);
    const body = upscaleBody({ itemId: 7, width: 1, height: 1, model: 'gfpgan', faces: [] }, rgba);
    const n = new DataView(body.buffer).getUint32(0, true);
    const json = JSON.parse(new TextDecoder().decode(body.slice(4, 4 + n)));
    expect(json.itemId).toBe(7);
    expect(Array.from(body.slice(4 + n))).toEqual([1, 2, 3, 4]);
  });
});
