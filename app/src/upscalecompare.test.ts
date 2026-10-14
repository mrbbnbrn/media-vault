import { describe, expect, it } from 'vitest';
import { clampLine, compareKeyStep } from './upscalecompare';

const key = (k: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods,
});

describe('before/after line', () => {
  it('stays on the visible picture', () => {
    expect(clampLine(50, 100, 300)).toBe(100);
    expect(clampLine(350, 100, 300)).toBe(300);
    expect(clampLine(180, 100, 300)).toBe(180);
    expect(clampLine(180, 300, 300)).toBe(300); // nothing visible
  });

  it('is nudged by [ ] and Shift+arrows only', () => {
    expect(compareKeyStep(key('['))).toBe(-1);
    expect(compareKeyStep(key(']'))).toBe(1);
    expect(compareKeyStep(key('ArrowLeft', { shiftKey: true }))).toBe(-1);
    expect(compareKeyStep(key('ArrowRight', { shiftKey: true }))).toBe(1);
    // Plain arrows still change picture; Ctrl/Alt combinations are left alone.
    expect(compareKeyStep(key('ArrowRight'))).toBe(0);
    expect(compareKeyStep(key(']', { ctrlKey: true }))).toBe(0);
    expect(compareKeyStep(key('o'))).toBe(0);
  });
});
