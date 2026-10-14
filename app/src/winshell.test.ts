import { describe, expect, it } from 'vitest';
import { outsideWindow } from './dragout';
import { pastedPictureName } from './winclip';

describe('drag out', () => {
  it('knows when the pointer is outside the window', () => {
    expect(outsideWindow(10, 10, 800, 600)).toBe(false);
    expect(outsideWindow(0, 0, 800, 600)).toBe(false);
    expect(outsideWindow(-1, 10, 800, 600)).toBe(true);
    expect(outsideWindow(10, -3, 800, 600)).toBe(true);
    expect(outsideWindow(800, 10, 800, 600)).toBe(true);
    expect(outsideWindow(10, 600, 800, 600)).toBe(true);
  });
});

describe('paste', () => {
  it('names pasted pictures by date and time', () => {
    expect(pastedPictureName(new Date(2026, 9, 4, 9, 5, 7))).toBe('Pasted picture 2026-10-04 09.05.07.png');
  });
});
