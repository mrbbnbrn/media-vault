import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterGrid, gridShown, resetGrid, whenGridShown } from './firstgrid';

afterEach(() => {
  resetGrid();
  vi.useRealTimers();
});

describe('background work after the first page', () => {
  it('starts when the grid is shown, or after the longest wait', async () => {
    vi.useFakeTimers();
    const start = vi.fn(() => () => {});
    whenGridShown(start, 1000);
    await vi.advanceTimersByTimeAsync(500);
    expect(start).not.toHaveBeenCalled();
    gridShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(1);
    // Shown already: straight away.
    const again = vi.fn(() => () => {});
    whenGridShown(again);
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toHaveBeenCalledTimes(1);
    // A new unlock waits again; nothing shown: the longest wait.
    resetGrid();
    const late = vi.fn(() => () => {});
    whenGridShown(late, 800);
    await vi.advanceTimersByTimeAsync(799);
    expect(late).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('never starts what was stopped first, and stops what started', async () => {
    vi.useFakeTimers();
    const stopA = vi.fn();
    const a = vi.fn(() => stopA);
    whenGridShown(a, 1000)();
    gridShown();
    await vi.advanceTimersByTimeAsync(0);
    expect(a).not.toHaveBeenCalled();
    const stopB = vi.fn();
    const stop = whenGridShown(() => stopB);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(stopB).toHaveBeenCalledTimes(1);
    await expect(afterGrid()).resolves.toBeUndefined();
  });
});
