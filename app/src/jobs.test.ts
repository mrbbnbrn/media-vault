import { describe, expect, it, vi } from 'vitest';
import { beginJob, countText, endJob, formatLeft, jobFraction, jobList, loopJob, overall, secondsLeft, updateJob, visibleJobs, type Job } from './jobs';
import { niceTicks } from './components/VaultGrowth';

const job = (p: Partial<Job>): Job => ({ id: 'x', label: 'X', done: 0, total: 0, unit: 'items', startedAt: 0, long: false, ...p });

describe('job maths', () => {
  it('fractions, overall progress and counts', () => {
    expect(jobFraction(job({ done: 25, total: 100 }))).toBe(0.25);
    expect(jobFraction(job({ done: 5, total: 0 }))).toBeNull();
    expect(jobFraction(job({ done: 1, total: 10, fraction: 0.9 }))).toBe(0.9);
    expect(jobFraction(job({ endedAt: 5 }))).toBe(1);
    expect(overall([job({ done: 50, total: 100 }), job({ done: 100, total: 100 })])).toBe(0.75);
    expect(overall([])).toBe(0);
    expect(countText(job({ done: 1240, total: 5000 }))).toBe(`${(1240).toLocaleString()} of ${(5000).toLocaleString()} items`);
    expect(countText(job({ done: 0, total: 0 }))).toBe('');
  });

  it('time left only once it can be told', () => {
    expect(secondsLeft(job({ done: 50, total: 100, startedAt: 0 }), 2000)).toBeNull(); // too early
    expect(secondsLeft(job({ done: 50, total: 100, startedAt: 0 }), 60_000)).toBeCloseTo(60);
    expect(secondsLeft(job({ done: 1, total: 0, startedAt: 0 }), 60_000)).toBeNull();
    expect(formatLeft(30)).toBe('less than a minute left');
    expect(formatLeft(600)).toBe('about 10 min left');
    expect(formatLeft(3 * 3600 + 600)).toBe('about 3 h 10 min left');
    expect(formatLeft(null)).toBe('');
  });

  it('quick housekeeping jobs stay hidden, real ones show at once', () => {
    const quiet = job({ id: 'q', quiet: true, total: 3, startedAt: 0 });
    const loud = job({ id: 'l', startedAt: 0 });
    expect(visibleJobs([quiet, loud], 500).map((j) => j.id)).toEqual(['l']);
    expect(visibleJobs([quiet, loud], 2000).map((j) => j.id)).toEqual(['q', 'l']);
    expect(visibleJobs([{ ...quiet, endedAt: 800 }], 2000)).toEqual([]); // finished before it would show
    expect(visibleJobs([{ ...quiet, total: 400 }], 10).length).toBe(1); // big batch: at once
  });
});

describe('the registry', () => {
  it('begins, updates and ends jobs, then lets them fade', () => {
    vi.useFakeTimers();
    beginJob({ id: 'a', label: 'Importing', long: true, total: 10 });
    updateJob('a', { done: 4 });
    updateJob('b', { done: 1, total: 2 }, { label: 'Copying', long: true });
    expect(jobList().map((j) => [j.id, j.done, j.total])).toEqual([['a', 4, 10], ['b', 1, 2]]);
    endJob('a', { summary: 'Import finished: 10 items' });
    expect(jobList().find((j) => j.id === 'a')?.endedAt).toBeDefined();
    expect(jobList().find((j) => j.id === 'a')?.done).toBe(10);
    endJob('b', { failed: true });
    vi.advanceTimersByTime(5000);
    expect(jobList()).toEqual([]);
    vi.useRealTimers();
  });

  it('a background loop counts its own work against what is left', async () => {
    let left = 5;
    const t = loopJob('loop', { label: 'Making thumbnails', left: async () => left });
    t.step(); // not started yet: ignored
    t.batch();
    await new Promise((r) => setTimeout(r, 0));
    expect(jobList().find((j) => j.id === 'loop')?.total).toBe(5);
    t.step();
    t.step();
    left = 7; // more arrived
    t.batch();
    await new Promise((r) => setTimeout(r, 0));
    const j = jobList().find((x) => x.id === 'loop')!;
    expect([j.done, j.total]).toEqual([2, 9]);
    t.idle();
    expect(jobList().find((x) => x.id === 'loop')?.endedAt).toBeDefined();
  });
});

describe('chart axis', () => {
  it('picks round steps', () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(90)).toEqual([0, 50, 100]);
    expect(niceTicks(2.3e9)).toEqual([0, 1e9, 2e9, 3e9]);
  });
});
