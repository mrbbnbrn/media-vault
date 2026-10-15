import { describe, expect, it } from 'vitest';
import { Budget, chooseLayers, MAX_REAL, type TileWant } from './previewplan';
import { MIN_SPARE, PlayerPool, type PoolPlayer } from './videopool';
import { FRAMES, frameTimes, TINY_PIECE, tinyPieces, tinySize, tinyToSource } from './previews';

const tile = (id: number, o: Partial<TileWant> = {}): TileWant => ({ id, hasTiny: true, hasStrip: true, hovered: false, rank: id, ...o });

describe('which tiles play the real video', () => {
  it('hover always plays the real video, even with no budget or tiny clips only', () => {
    const l = chooseLayers([tile(1), tile(2, { hovered: true })], 0, 'tiny');
    expect(l.get(2)).toBe('real');
    expect(l.get(1)).toBe('tiny');
  });

  it('gives the budget to the most important tiles and the best stand-in to the rest', () => {
    const l = chooseLayers([tile(3), tile(1), tile(2, { hasTiny: false }), tile(4, { hasTiny: false, hasStrip: false })], 2, 'auto');
    // Tile 4 has nothing else that moves, so it comes first; then the best ranked.
    expect(l.get(4)).toBe('real');
    expect(l.get(1)).toBe('real');
    expect(l.get(2)).toBe('flip');
    expect(l.get(3)).toBe('tiny');
  });

  it('a tile with nothing made yet shows its thumbnail when there is no budget', () => {
    expect(chooseLayers([tile(1, { hasTiny: false, hasStrip: false })], 0, 'auto').get(1)).toBe('thumb');
  });

  it('never more than MAX_REAL at once', () => {
    const tiles = Array.from({ length: 40 }, (_, i) => tile(i));
    const l = chooseLayers(tiles, 1000, 'auto');
    expect([...l.values()].filter((x) => x === 'real')).toHaveLength(MAX_REAL);
  });
});

describe('the real-video budget', () => {
  const smooth = { frames: 300, dropped: 1, slowShare: 0, avgFrameMs: 16.7 };
  it('grows while the PC keeps up and more tiles want it', () => {
    const b = new Budget(2);
    let n = b.look({ ...smooth, real: 2, wanted: 20 }, 0);
    expect(n).toBe(4);
    n = b.look({ ...smooth, real: 4, wanted: 20 }, 2000);
    expect(n).toBe(6);
    n = b.look({ ...smooth, real: 6, wanted: 20 }, 4000);
    expect(n).toBe(10); // a longer calm grows faster
    // Not beyond what is wanted.
    expect(b.look({ ...smooth, real: 10, wanted: 11 }, 6000)).toBe(11);
  });

  it("doesn't grow while the budget isn't used", () => {
    const b = new Budget(4);
    expect(b.look({ ...smooth, real: 1, wanted: 20 }, 0)).toBe(4);
  });

  it('halves on dropped frames or a stuttering window, and stays there for a minute', () => {
    const b = new Budget(8);
    expect(b.look({ real: 8, wanted: 20, frames: 400, dropped: 80, slowShare: 0, avgFrameMs: 17 }, 0)).toBe(4);
    expect(b.look({ ...smooth, real: 4, wanted: 20 }, 2000)).toBe(4);
    expect(b.look({ ...smooth, real: 4, wanted: 20 }, 30_000)).toBe(4);
    // After a minute it may try again.
    expect(b.look({ ...smooth, real: 4, wanted: 20 }, 61_000)).toBeGreaterThan(4);
    const j = new Budget(6);
    expect(j.look({ real: 6, wanted: 6, frames: 0, dropped: 0, slowShare: 0.3, avgFrameMs: 40 }, 0)).toBe(3);
    expect(j.look({ real: 3, wanted: 6, frames: 0, dropped: 0, slowShare: 0.3, avgFrameMs: 40 }, 2000)).toBe(1);
    expect(j.look({ real: 1, wanted: 6, frames: 0, dropped: 0, slowShare: 0.3, avgFrameMs: 40 }, 4000)).toBe(0);
  });

  it('leaves the budget alone when nothing plays', () => {
    const b = new Budget(3);
    expect(b.look({ real: 0, wanted: 0, frames: 0, dropped: 0, slowShare: 1, avgFrameMs: 99 }, 0)).toBe(3);
  });
});

class FakePlayer implements PoolPlayer {
  static made = 0;
  src = '';
  paused = true;
  inPage = false;
  constructor() {
    FakePlayer.made++;
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  remove() {
    this.inPage = false;
  }
  removeAttribute(n: string) {
    if (n === 'src') this.src = '';
  }
  load() {}
}

describe('player pool', () => {
  it('hands players leaving the screen to tiles coming in instead of making new ones', () => {
    const pool = new PlayerPool(() => new FakePlayer());
    // 12 tiles on screen.
    let shown = Array.from({ length: 12 }, (_, i) => {
      const p = pool.acquire(`v${i}`);
      p.src = `v${i}`;
      pool.play(p);
      return p;
    });
    expect(pool.stats.created).toBe(12);
    // Scroll: 100 times, the top row of 4 leaves and a new row comes in.
    for (let step = 0; step < 100; step++) {
      const leaving = shown.slice(0, 4);
      leaving.forEach((p) => pool.release(p));
      expect(leaving.every((p) => p.paused)).toBe(true);
      const coming = Array.from({ length: 4 }, (_, k) => {
        const src = `v${12 + step * 4 + k}`;
        const p = pool.acquire(src);
        p.src = src;
        return p;
      });
      shown = [...shown.slice(4), ...coming];
    }
    expect(pool.stats.created).toBe(12);
    expect(pool.stats.reused).toBe(400);
    expect(pool.stats.inUse).toBe(12);
  });

  it('grows to as many as are needed, and lets go of spares when far bigger', () => {
    const pool = new PlayerPool(() => new FakePlayer());
    const many = Array.from({ length: 60 }, (_, i) => pool.acquire(`v${i}`));
    expect(pool.stats.inUse).toBe(60);
    many.slice(0, 56).forEach((p) => pool.release(p));
    // 4 in use: keep MIN_SPARE spares (more while many are in use).
    expect(pool.stats.spare).toBe(MIN_SPARE);
    expect(pool.stats.dropped).toBe(56 - MIN_SPARE);
  });

  it('prefers a spare that already has the video loaded', () => {
    const pool = new PlayerPool(() => new FakePlayer());
    const a = pool.acquire('a');
    a.src = 'a';
    const b = pool.acquire('b');
    b.src = 'b';
    pool.release(a);
    pool.release(b);
    expect(pool.acquire('a')).toBe(a);
    expect(pool.stats.warm).toBe(1);
  });

  it('pauses everything and carries on with what was playing', () => {
    const pool = new PlayerPool(() => new FakePlayer());
    const a = pool.acquire('a');
    const b = pool.acquire('b');
    pool.play(a);
    pool.pauseAll();
    expect(a.paused).toBe(true);
    // A tile asking to play while paused waits.
    pool.play(b);
    expect(b.paused).toBe(true);
    pool.resumeAll();
    expect(a.paused).toBe(false);
    expect(b.paused).toBe(false);
  });
});

describe('tiny clips', () => {
  it('uses the same moments as the frame strip in long videos', () => {
    const p = tinyPieces(600);
    expect(p.piece).toBe(TINY_PIECE);
    const strip = frameTimes(600);
    expect(p.starts).toEqual([0, 12, 24, 36].map((i) => expect.closeTo(strip[i], 3)));
    expect(p.starts.length * p.piece).toBe(6);
    expect(FRAMES / 4 / 8).toBe(TINY_PIECE);
  });

  it('is the start of a short video', () => {
    expect(tinyPieces(3)).toEqual({ starts: [0], piece: 2.95 });
    expect(tinyPieces(9)).toEqual({ starts: [0], piece: 6 });
    expect(tinyPieces(0).starts).toEqual([0]);
  });

  it('maps a moment of the tiny clip back to the real video', () => {
    expect(tinyToSource(0, 600)).toBe(60);
    expect(tinyToSource(1.6, 600)).toBeCloseTo(198.1);
    expect(tinyToSource(6.5, 600)).toBeCloseTo(60.5); // it loops
    expect(tinyToSource(2, 4)).toBe(2);
  });

  it('is small and even-sized, never bigger than the video', () => {
    expect(tinySize(1920, 1080)).toEqual({ w: 426, h: 240 });
    expect(tinySize(1080, 1920)).toEqual({ w: 240, h: 426 });
    expect(tinySize(320, 181)).toEqual({ w: 320, h: 182 });
    expect(tinySize(4000, 3)).toEqual({ w: 426, h: 2 });
  });
});
