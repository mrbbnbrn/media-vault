// Which grid thumbnails load first. Every tile asks for its thumbnail with a
// priority (lower = sooner: on screen first, then the rows the scroll is
// heading towards, then those it left behind); only a few load at a time, so
// when you fling the grid the tiles you have already scrolled past never get
// a turn, instead of queueing hundreds of decryptions ahead of the ones you
// look at. A tile that goes away (scrolled out) leaves the queue.

export class LoadQueue {
  private waiting = new Map<string, { prio: number; grant: () => void }>();
  private running = new Map<string, ReturnType<typeof setTimeout> | null>();

  constructor(
    /** At most this many loading at once. */
    public limit = 6,
    /** A load that never reports back frees its place after this long (ms). */
    private stuckMs = 8000,
  ) {}

  /** Ask (again) for `key`; `grant` is called once when its turn comes. A new priority replaces the old one. */
  want(key: string, prio: number, grant: () => void) {
    if (this.running.has(key)) return;
    const w = this.waiting.get(key);
    if (w) {
      w.prio = prio;
      w.grant = grant;
    } else this.waiting.set(key, { prio, grant });
    this.pump();
  }

  /** It loaded (or failed): the next one may start. */
  done(key: string) {
    if (this.running.has(key)) {
      const t = this.running.get(key);
      if (t) clearTimeout(t);
      this.running.delete(key);
      this.pump();
    }
  }

  /** Not wanted any more (the tile went away). */
  drop(key: string) {
    this.waiting.delete(key);
    this.done(key);
  }

  get pending(): number {
    return this.waiting.size;
  }

  get active(): number {
    return this.running.size;
  }

  private pump() {
    while (this.running.size < this.limit && this.waiting.size) {
      let best: string | null = null;
      let bp = Infinity;
      for (const [k, w] of this.waiting) {
        if (w.prio < bp) {
          bp = w.prio;
          best = k;
        }
      }
      if (best == null) return;
      const w = this.waiting.get(best)!;
      this.waiting.delete(best);
      this.running.set(best, this.stuckMs > 0 ? setTimeout(() => this.done(best), this.stuckMs) : null);
      w.grant();
    }
  }
}

/**
 * Priority of a tile from where it is and where the scroll is going:
 * on screen first (top to bottom), then ahead in the direction of travel by
 * distance, then behind (three times as far away, so it rarely wins).
 * `dir` is +1 scrolling down, −1 up, 0 still.
 */
export function tilePriority(y0: number, y1: number, viewTop: number, viewBottom: number, dir: number): number {
  if (y1 > viewTop && y0 < viewBottom) return Math.max(0, y0 - viewTop) / 1e6;
  const below = y0 >= viewBottom;
  const dist = below ? y0 - viewBottom : viewTop - y1;
  const ahead = dir === 0 || (dir > 0) === below;
  return 1 + (ahead ? dist : dist * 3);
}

/** How far past the view to draw tiles in the direction of travel, from the scroll speed (px per ms). */
export function lookAhead(speed: number): number {
  return 600 + Math.min(2400, Math.max(0, Math.abs(speed)) * 400);
}

/** The one queue for grid thumbnails. */
export const thumbQueue = new LoadQueue(6);
