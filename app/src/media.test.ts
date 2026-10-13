import { describe, expect, it } from 'vitest';
import { formatTime, gifDurationMs, webpDurationMs } from './media';

function gif(delaysCs: number[]): Uint8Array {
  const out: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0];
  out.push(0, 0, 0, 255, 255, 255); // 2-colour global table
  for (const d of delaysCs) {
    out.push(0x21, 0xf9, 4, 0, d & 0xff, d >> 8, 0, 0); // graphic control
    out.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0); // image descriptor
    out.push(2, 2, 0x4c, 0x01, 0); // LZW data
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

function webp(durations: number[]): Uint8Array {
  const chunks: number[] = [];
  const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >> (8 * i)) & 0xff);
  for (const d of durations) {
    const payload = [...le(0, 3), ...le(0, 3), ...le(0, 3), ...le(0, 3), ...le(d, 3), 0];
    chunks.push(...'ANMF'.split('').map((c) => c.charCodeAt(0)), ...le(payload.length, 4), ...payload);
  }
  const head = [...'RIFF'.split('').map((c) => c.charCodeAt(0)), ...le(4 + chunks.length, 4), ...'WEBP'.split('').map((c) => c.charCodeAt(0))];
  return new Uint8Array([...head, ...chunks]);
}

describe('animation length', () => {
  it('adds up GIF frame delays', () => {
    expect(gifDurationMs(gif([10, 20, 30]))).toBe(600);
    expect(gifDurationMs(gif([0, 0]))).toBe(200); // 0 delays play at 100 ms
    expect(gifDurationMs(gif([50]))).toBe(0); // a single frame is not animated
    expect(gifDurationMs(new Uint8Array([1, 2, 3]))).toBe(0);
  });

  it('adds up animated WebP frame durations', () => {
    expect(webpDurationMs(webp([100, 250, 50]))).toBe(400);
    expect(webpDurationMs(webp([100]))).toBe(0);
  });

  it('formats times', () => {
    expect(formatTime(47_000)).toBe('0:47');
    expect(formatTime(231_000)).toBe('3:51');
    expect(formatTime(3_725_000)).toBe('1:02:05');
    expect(formatTime(null)).toBe('');
  });
});
