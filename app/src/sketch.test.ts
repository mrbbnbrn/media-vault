import { describe, expect, it } from 'vitest';
import { parseSketch, sketchBmp, sketchColour, sketchUrl, smoothSketch } from './sketch';

const RED_BLUE = '21' + 'f00' + '00f';

describe('colour sketches', () => {
  it('reads the cells', () => {
    const k = parseSketch('43' + 'f08'.repeat(12))!;
    expect(k.cols).toBe(4);
    expect(k.rows).toBe(3);
    expect([...k.rgb.slice(0, 3)]).toEqual([255, 0, 136]);
    expect(k.rgb.length).toBe(36);
  });

  it('refuses anything malformed', () => {
    for (const bad of [null, undefined, '', '43', '43abc', '00', '21f00', '21f00zzz', 'x1f0000f']) expect(parseSketch(bad)).toBeNull();
    expect(sketchUrl('nonsense')).toBeNull();
    expect(sketchUrl(null)).toBeNull();
  });

  it('makes a valid bottom-up BMP with padded rows', () => {
    const k = parseSketch('12' + 'f00' + '00f')!; // 1 wide, 2 high: red on top, blue below
    const b = sketchBmp(k);
    const v = new DataView(b.buffer);
    expect(String.fromCharCode(b[0], b[1])).toBe('BM');
    expect(v.getUint32(2, true)).toBe(b.length);
    expect(v.getInt32(18, true)).toBe(1);
    expect(v.getInt32(22, true)).toBe(2);
    expect(v.getUint16(28, true)).toBe(24);
    expect(b.length).toBe(54 + 4 * 2); // 3 bytes per row, padded to 4
    // First stored row is the bottom one (blue), in B, G, R order.
    expect([...b.slice(54, 57)]).toEqual([255, 0, 0]);
    expect([...b.slice(58, 61)]).toEqual([0, 0, 255]);
  });

  it('gives a data URL, the same one each time, and decodes to the BMP', () => {
    const u = sketchUrl(RED_BLUE)!;
    expect(u.startsWith('data:image/bmp;base64,')).toBe(true);
    expect(sketchUrl(RED_BLUE)).toBe(u);
    const bytes = Uint8Array.from(atob(u.slice(22)), (c) => c.charCodeAt(0));
    expect([...bytes]).toEqual([...sketchBmp(smoothSketch(parseSketch(RED_BLUE)!, 4))]);
  });

  it('a finer, smooth version: mostly red on the left, blue on the right, blended between', () => {
    const k = smoothSketch(parseSketch(RED_BLUE)!, 4); // red | blue, 2×1 → 8×4
    expect([k.cols, k.rows]).toEqual([8, 4]);
    const px = (x: number, y: number) => [...k.rgb.slice((y * 8 + x) * 3, (y * 8 + x) * 3 + 3)];
    expect(px(0, 0)[0]).toBeGreaterThan(200);
    expect(px(0, 0)[2]).toBeLessThan(55);
    expect(px(7, 3)[2]).toBeGreaterThan(200);
    // A flat sketch stays exactly flat.
    const flat = smoothSketch(parseSketch('22' + '8a4'.repeat(4))!, 4);
    expect(new Set(flat.rgb).size).toBe(3);
    // In between: a blend, red fading as it goes right.
    const mid = px(4, 1);
    expect(mid[0]).toBeGreaterThan(0);
    expect(mid[0]).toBeLessThan(255);
    expect(px(3, 2)[0]).toBeGreaterThan(px(4, 2)[0]);
  });

  it('averages to one colour', () => {
    expect(sketchColour(RED_BLUE)).toBe('rgb(128, 0, 128)');
    expect(sketchColour('')).toBeNull();
  });
});
