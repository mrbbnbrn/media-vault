// Which grid tiles may play the real video, and which stay on their tiny
// clip (or flip-book). Pure rules, so they can be tested.
//
// Tiles start on their tiny clip. While the PC keeps up (hardly any dropped
// video frames, the window drawing smoothly) a few more tiles at a time switch
// to the real video; when it starts to struggle, tiles go back to their tiny
// clips and the number that struggled is remembered for a while. The hovered
// tile always plays the real video.

export type Layer = 'thumb' | 'flip' | 'tiny' | 'real';

export interface TileWant {
  id: number;
  hasTiny: boolean;
  hasStrip: boolean;
  hovered: boolean;
  /** Smaller = more important (e.g. distance from the middle of the view). */
  rank: number;
}

/** Most tiles playing the real video at once, however fast the PC is. */
export const MAX_REAL = 16;

/** What every playing tile shows: hovered → real; then by rank while the budget lasts; else its best stand-in. */
export function chooseLayers(tiles: TileWant[], budget: number, quality: 'auto' | 'tiny'): Map<number, Layer> {
  const out = new Map<number, Layer>();
  const standIn = (t: TileWant): Layer => (t.hasTiny ? 'tiny' : t.hasStrip ? 'flip' : 'thumb');
  let left = quality === 'tiny' ? 0 : Math.max(0, Math.min(budget, MAX_REAL));
  for (const t of tiles) {
    if (t.hovered) {
      out.set(t.id, 'real');
      left--;
    }
  }
  // Tiles with nothing to stand in for the video come first, then the most important.
  const rest = tiles.filter((t) => !t.hovered).sort((a, b) => Number(a.hasTiny || a.hasStrip) - Number(b.hasTiny || b.hasStrip) || a.rank - b.rank);
  for (const t of rest) {
    if (left > 0) {
      out.set(t.id, 'real');
      left--;
    } else out.set(t.id, standIn(t));
  }
  return out;
}

export interface Sample {
  /** Tiles playing the real video during the last look. */
  real: number;
  /** Tiles that would like to (all playing tiles). */
  wanted: number;
  /** Video frames shown and dropped by the real videos since the last look. */
  frames: number;
  dropped: number;
  /** Share of window frames that took too long (> 50 ms) and the average frame time (ms). */
  slowShare: number;
  avgFrameMs: number;
}

/** Looks every couple of seconds and sets how many tiles may play the real video. */
export class Budget {
  budget = 4;
  private ceiling = Infinity;
  private ceilingUntil = 0;
  private calm = 0;

  constructor(start = 4) {
    this.budget = start;
  }

  /** One look (every ~2 s). Returns the new budget. */
  look(s: Sample, now: number): number {
    if (now >= this.ceilingUntil) this.ceiling = Infinity;
    if (s.wanted === 0) return this.budget;
    const jank = s.slowShare > 0.12 || s.avgFrameMs > 30;
    const droppy = s.frames >= 20 && s.dropped / s.frames > 0.08;
    if (jank || droppy) {
      // Struggling: back to half of what played, and remember it for a minute.
      this.calm = 0;
      const was = Math.min(this.budget, s.real);
      this.budget = Math.max(0, Math.floor(was / 2));
      this.ceiling = this.budget;
      this.ceilingUntil = now + 60_000;
      return this.budget;
    }
    const smooth = s.slowShare < 0.04 && s.avgFrameMs < 22 && (s.frames < 20 || s.dropped / s.frames < 0.02);
    if (!smooth) {
      this.calm = 0;
      return this.budget;
    }
    this.calm++;
    // Grow only when the budget is in use and more tiles would like it.
    if (s.real >= this.budget && s.wanted > this.budget) {
      this.budget = Math.min(s.wanted, MAX_REAL, this.ceiling, this.budget + (this.calm >= 3 ? 4 : 2));
    }
    return this.budget;
  }
}
