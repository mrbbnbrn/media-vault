import { describe, expect, it } from 'vitest';
import { decodeText, TEXT_LIMIT } from './docs';

const enc = (s: string) => new TextEncoder().encode(s);

describe('text decoding', () => {
  it('reads UTF-8, with or without a BOM', () => {
    expect(decodeText(enc('Merhaba dünya, şöyle')).text).toBe('Merhaba dünya, şöyle');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('ğüş')])).text).toBe('ğüş');
  });

  it('reads UTF-16 with a BOM', () => {
    const s = 'İstanbul';
    const b = new Uint8Array(2 + s.length * 2);
    b[0] = 0xff;
    b[1] = 0xfe;
    for (let i = 0; i < s.length; i++) {
      b[2 + i * 2] = s.charCodeAt(i) & 0xff;
      b[3 + i * 2] = s.charCodeAt(i) >> 8;
    }
    expect(decodeText(b)).toMatchObject({ text: 'İstanbul', encoding: 'UTF-16' });
  });

  it('falls back to the Turkish Windows code page for old files', () => {
    // "Çağrı" in Windows-1254: C7 61 F0 72 FD
    const r = decodeText(new Uint8Array([0xc7, 0x61, 0xf0, 0x72, 0xfd]));
    expect(r).toMatchObject({ text: 'Çağrı', encoding: 'Windows-1254' });
  });

  it('shows the beginning of very large files without breaking a character', () => {
    const big = new Uint8Array(TEXT_LIMIT + 10).fill(0x61);
    big.set(enc('ş'), TEXT_LIMIT - 1); // 2-byte character cut in half by the limit
    const r = decodeText(big);
    expect(r.truncated).toBe(true);
    expect(r.encoding).toBe('UTF-8');
    expect(r.text.length).toBe(TEXT_LIMIT - 1);
  });
});
