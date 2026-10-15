import { describe, expect, it, vi } from 'vitest';
import { FAR_PX, LoadQueue, lookAhead, ON_SCREEN, tilePriority } from './loadqueue';

describe('thumbnail load queue', () => {
  it('starts only a few at a time, most urgent first', () => {
    const q = new LoadQueue(2, 0);
    const got: string[] = [];
    for (const [k, p] of [['a', 5], ['b', 1], ['c', 3], ['d', 0.5]] as const) q.want(k, p, () => got.push(k));
    // a and b got the two places at once (the queue starts work as soon as it can).
    expect(got).toEqual(['a', 'b']);
    q.done('a');
    expect(got).toEqual(['a', 'b', 'd']);
    q.done('b');
    expect(got).toEqual(['a', 'b', 'd', 'c']);
    expect(q.active).toBe(2);
    expect(q.pending).toBe(0);
  });

  it('a tile scrolled away never gets a turn, and a new priority counts', () => {
    const q = new LoadQueue(1, 0);
    const got: string[] = [];
    q.want('busy', 0, () => got.push('busy'));
    q.want('far', 1, () => got.push('far'));
    q.want('near', 5, () => got.push('near'));
    q.drop('far');
    q.want('near', 2, () => got.push('near!'));
    q.done('busy');
    expect(got).toEqual(['busy', 'near!']);
    // Asking again while it loads does nothing.
    q.want('near', 0, () => got.push('again'));
    expect(got).toEqual(['busy', 'near!']);
    // Dropping a running one frees its place.
    q.want('x', 1, () => got.push('x'));
    q.drop('near');
    expect(got).toEqual(['busy', 'near!', 'x']);
  });

  it('a load that never reports back frees its place in the end', () => {
    vi.useFakeTimers();
    const q = new LoadQueue(1, 1000);
    const got: string[] = [];
    q.want('stuck', 0, () => got.push('stuck'));
    q.want('next', 1, () => got.push('next'));
    vi.advanceTimersByTime(999);
    expect(got).toEqual(['stuck']);
    vi.advanceTimersByTime(2);
    expect(got).toEqual(['stuck', 'next']);
    vi.useRealTimers();
  });

  it('a tile that goes away cancels its load', () => {
    const q = new LoadQueue(2, 0);
    const signals = new Map<string, AbortSignal>();
    q.want('a', 0.1, (s) => signals.set('a', s));
    q.want('b', 0.2, (s) => signals.set('b', s));
    q.drop('a');
    expect(signals.get('a')!.aborted).toBe(true);
    expect(signals.get('b')!.aborted).toBe(false);
    // Finished normally: dropping afterwards cancels nothing.
    q.done('b');
    q.drop('b');
    expect(signals.get('b')!.aborted).toBe(false);
  });

  it('tiles on screen come first: a load far off screen makes room and is queued again', () => {
    const q = new LoadQueue(2, 0);
    const got: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const grant = (k: string) => (s: AbortSignal) => {
      got.push(k);
      signals.set(k, s);
    };
    // Prefetching rows far below while nothing is on screen yet.
    q.want('far1', ON_SCREEN + 3000, grant('far1'));
    q.want('far2', ON_SCREEN + 100, grant('far2'));
    expect(q.active).toBe(2);
    // A tile on screen: the farthest one (only one far enough) gives its place.
    q.want('seen', 0.001, grant('seen'));
    expect(got).toEqual(['far1', 'far2', 'seen']);
    expect(signals.get('far1')!.aborted).toBe(true);
    expect(signals.get('far2')!.aborted).toBe(false);
    expect(q.preempted).toBe(1);
    expect(q.isRunning('seen')).toBe(true);
    // Another tile on screen: far2 is near (within FAR_PX), so it waits.
    q.want('seen2', 0.002, grant('seen2'));
    expect(q.isRunning('seen2')).toBe(false);
    // far1 comes back when places free up, after the tiles on screen.
    q.done('seen');
    expect(got.at(-1)).toBe('seen2');
    q.done('far2');
    expect(got.at(-1)).toBe('far1');
    expect(signals.get('far1')!.aborted).toBe(false);
    // A running tile scrolled onto the screen keeps its place: its new priority counts.
    q.want('far1', 0.01, grant('far1'));
    q.want('seen3', 0.003, grant('seen3'));
    expect(q.isRunning('far1')).toBe(true);
    expect(q.isRunning('seen3')).toBe(false);
    expect(FAR_PX).toBeGreaterThan(0);
  });

  it('priorities: on screen, then ahead, then behind', () => {
    const view = [1000, 2000] as const;
    const onTop = tilePriority(1000, 1200, ...view, 1);
    const onLow = tilePriority(1800, 2100, ...view, 1);
    const ahead = tilePriority(2300, 2500, ...view, 1);
    const behind = tilePriority(600, 800, ...view, 1);
    expect(onTop).toBeLessThan(onLow);
    expect(onLow).toBeLessThan(1);
    expect(ahead).toBeLessThan(behind);
    // Scrolling up, the rows above come first.
    expect(tilePriority(600, 800, ...view, -1)).toBeLessThan(tilePriority(2300, 2500, ...view, -1));
    // Standing still: just by distance.
    expect(tilePriority(2100, 2300, ...view, 0)).toBeLessThan(tilePriority(500, 700, ...view, 0));
  });

  it('looks further ahead the faster you scroll', () => {
    expect(lookAhead(0)).toBe(600);
    expect(lookAhead(2)).toBe(1400);
    expect(lookAhead(-50)).toBe(3000);
  });
});
