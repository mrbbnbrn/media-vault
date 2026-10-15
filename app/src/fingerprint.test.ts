import { describe, expect, it } from 'vitest';
import { distance, phash, sharpness } from './fingerprint';

// Synthetic "photos": a dozen overlapping waves at odd angles (like real
// pictures, every low frequency carries something).
function photo(seed: number, size = 32): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const waves = Array.from({ length: 12 }, () => ({ fx: rnd() * 0.5, fy: rnd() * 0.5, ph: rnd() * 6.28, amp: 10 + rnd() * 25 }));
  const out: number[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) out.push(128 + waves.reduce((t, w) => t + w.amp * Math.sin(w.fx * x + w.fy * y + w.ph), 0) / 3);
  return out;
}

// Small, repeatable noise.
function noisy(p: number[], amount: number): number[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  return p.map((v) => v + rnd() * amount);
}

describe('look-alike fingerprints', () => {
  const a = photo(3);
  it('a brighter, noisy copy is close; a different picture is far', () => {
    const copy = noisy(a.map((v) => v * 1.08), 6);
    const other = photo(99);
    expect(distance(phash(a), phash(copy))).toBeLessThanOrEqual(5);
    expect(distance(phash(a), phash(other))).toBeGreaterThanOrEqual(20);
    expect(phash(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('counts differing bits in both halves', () => {
    expect(distance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(distance('8000000000000001', '0000000000000000')).toBe(2);
  });
  it('a checkerboard is sharper than a smooth gradient', () => {
    const checker = Array.from({ length: 64 * 64 }, (_, i) => (((i % 64) + Math.floor(i / 64)) % 2 ? 255 : 0));
    const gradient = Array.from({ length: 64 * 64 }, (_, i) => (i % 64) * 4);
    expect(sharpness(checker)).toBeGreaterThan(sharpness(gradient));
  });
});

// The same made-up picture as the Rust version's test (picture.rs): both
// must give exactly the same fingerprint, so the app's native analysis and
// the window agree.
describe('same fingerprint as the native analysis', () => {
  const g = Array.from({ length: 32 * 32 }, (_, i) => {
    const x = i % 32;
    const y = Math.floor(i / 32);
    return Math.round(128 + 90 * Math.sin(x / 5) * Math.cos(y / 7) + 2 * x - y);
  });
  it('pHash and sharpness', () => {
    expect(phash(g)).toBe('bd02ed03ad5253ad');
    expect(sharpness(g, 32, 32)).toBeCloseTo(9.843332098765433, 9);
  });
});
