import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calmly, holdCalm, noteInputForTest, QUIET_MS, resetCalm, reuseSame, shallowSame, stableOrder, userBusy } from './calm';

describe('calm view', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCalm();
  });
  afterEach(() => {
    resetCalm();
    vi.useRealTimers();
  });

  it('runs soon when nobody is using the window, once per key', () => {
    const f = vi.fn();
    calmly('a', f);
    calmly('a', f);
    expect(f).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('waits while the user is busy, then runs the last one', () => {
    noteInputForTest();
    expect(userBusy()).toBe(true);
    const first = vi.fn();
    const last = vi.fn();
    calmly('reload', first);
    calmly('reload', last);
    vi.advanceTimersByTime(QUIET_MS - 200);
    expect(last).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(first).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
  });

  it('a hold (an open menu) keeps changes back until released', () => {
    holdCalm('menu', true);
    const f = vi.fn();
    calmly('x', f);
    vi.advanceTimersByTime(5000);
    expect(f).not.toHaveBeenCalled();
    holdCalm('menu', false);
    vi.advanceTimersByTime(QUIET_MS);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('stable order', () => {
  const key = (x: { id: number }) => x.id;
  it('keeps the old order for things already shown; new ones take their fresh place', () => {
    const prev = [{ id: 1 }, { id: 2 }, { id: 3 }];
    // The fresh sort moved 3 to the top and added 9 in the middle.
    const next = [{ id: 3 }, { id: 9 }, { id: 1 }, { id: 2 }];
    expect(stableOrder(prev, next, key).map(key)).toEqual([1, 9, 2, 3]);
  });
  it('drops removed ones and reuses unchanged objects', () => {
    const a = { id: 1, n: 1 };
    const b = { id: 2, n: 1 };
    const out = stableOrder([a, b], [{ id: 2, n: 1 }, { id: 1, n: 2 }], key, shallowSame);
    expect(out[0]).toEqual({ id: 1, n: 2 });
    expect(out[1]).toBe(b);
    expect(stableOrder([a, b], [{ id: 2, n: 1 }], key).map(key)).toEqual([2]);
  });
  it('reuseSame keeps the old array when nothing changed', () => {
    const prev = [{ id: 1, t: ['a'] }, { id: 2, t: [] as string[] }];
    expect(reuseSame(prev, [{ id: 1, t: ['a'] }, { id: 2, t: [] }], key, shallowSame)).toBe(prev);
    const r = reuseSame(prev, [{ id: 1, t: ['b'] }, { id: 2, t: [] }], key, shallowSame);
    expect(r).not.toBe(prev);
    expect(r[1]).toBe(prev[1]);
  });
});
