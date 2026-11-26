import { describe, expect, it } from 'vitest';
import { cleanSideWidth, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, sideDrag, sideMax, sideStep } from './sidebarwidth';

describe('folder panel width', () => {
  it('cleans saved widths', () => {
    expect(cleanSideWidth(undefined)).toBe(SIDE_DEFAULT);
    expect(cleanSideWidth(Number.NaN)).toBe(SIDE_DEFAULT);
    expect(cleanSideWidth('300')).toBe(SIDE_DEFAULT);
    expect(cleanSideWidth(311.6)).toBe(312);
    expect(cleanSideWidth(20)).toBe(SIDE_MIN);
    expect(cleanSideWidth(5000)).toBe(SIDE_MAX);
  });
  it('leaves room for the grid in a narrow window', () => {
    expect(sideMax(2560)).toBe(SIDE_MAX);
    expect(sideMax(800)).toBe(380);
    expect(sideMax(500)).toBe(SIDE_MIN);
    expect(cleanSideWidth(500, 800)).toBe(380);
  });
  it('a drag below the snap point turns compact; above it opens at that width', () => {
    expect(sideDrag(100, 1600)).toEqual({ rail: true });
    expect(sideDrag(149, 1600)).toEqual({ rail: true });
    expect(sideDrag(150, 1600)).toEqual({ rail: false, width: SIDE_MIN });
    expect(sideDrag(333.4, 1600)).toEqual({ rail: false, width: 333 });
    expect(sideDrag(900, 1600)).toEqual({ rail: false, width: SIDE_MAX });
  });
  it('arrow keys step the width, past the narrowest to compact and back', () => {
    expect(sideStep(false, 260, 1, 1600)).toEqual({ rail: false, width: 280 });
    expect(sideStep(false, 190, -1, 1600)).toEqual({ rail: false, width: SIDE_MIN });
    expect(sideStep(false, SIDE_MIN, -1, 1600)).toEqual({ rail: true });
    expect(sideStep(true, SIDE_MIN, 1, 1600)).toEqual({ rail: false, width: SIDE_MIN });
    expect(sideStep(true, SIDE_MIN, -1, 1600)).toEqual({ rail: true });
  });
});
