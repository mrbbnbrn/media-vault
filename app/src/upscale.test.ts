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

  it('keeps faces with their 5 points', () => {
    const five = Array.from({ length: 5 }, (_, i) => [i, 100 + i] as [number, number]);
    expect(fivePoints(five)).toEqual(five);
    expect(fivePoints(five.slice(0, 4))).toBeNull();
    expect(fivePoints([...five.slice(0, 4), [Number.NaN, 1]])).toBeNull();
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
