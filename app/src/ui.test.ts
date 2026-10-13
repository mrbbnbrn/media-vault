import { describe, expect, it } from 'vitest';
import { accentVars, formatBytes, isHex, luminance, mix, onAccent } from './theme';
import { shouldSend } from './activity';
import { countWords } from './screens/Recover';

describe('theme', () => {
  it('defaults to teal and falls back on bad input', () => {
    expect(accentVars('#2EC4B6')['--accent']).toBe('#2ec4b6');
    expect(accentVars('not a colour')['--accent']).toBe('#2ec4b6');
  });
  it('mixes colours', () => {
    expect(mix('#ffffff', '#000000', 0)).toBe('#000000');
    expect(mix('#ffffff', '#000000', 1)).toBe('#ffffff');
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080');
  });
  it('keeps text on the accent readable', () => {
    for (const hex of ['#2ec4b6', '#5b9cf0', '#a78bfa', '#e8a54b', '#f07a8c', '#9ccc54']) {
      expect(onAccent(hex)).toBe('#0a1214');
    }
    expect(onAccent('#1a237e')).toBe('#ffffff');
    expect(luminance('#ffffff')).toBeCloseTo(1);
  });
  it('validates hex', () => {
    expect(isHex('#a1b2c3')).toBe(true);
    expect(isHex('a1b2c3')).toBe(false);
  });
  it('formats sizes', () => {
    expect(formatBytes(8.2e9)).toBe('8.2 GB');
    expect(formatBytes(1.01e11)).toBe('101 GB');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(null)).toBe('');
  });
});

describe('activity throttle', () => {
  it('sends at most every interval', () => {
    expect(shouldSend(10_000, 0, 5_000)).toBe(true);
    expect(shouldSend(10_000, 6_000, 5_000)).toBe(false);
  });
});

describe('recovery word counting', () => {
  it('ignores numbering, punctuation and line breaks', () => {
    const typed = Array.from({ length: 24 }, (_, i) => `${i + 1}. word${'abcdefghijklmnopqrstuvwx'[i]}`).join('\n');
    expect(countWords(typed)).toBe(24);
    expect(countWords('  ')).toBe(0);
  });
});
