// Which grid thumbnails load first. Every tile asks for its thumbnail with a
// priority (lower = sooner: on screen first, then the rows the scroll is
// heading towards, then those it left behind); only a few load at a time, so
// when you fling the grid the tiles you have already scrolled past never get
// a turn, instead of queueing hundreds of decryptions ahead of the ones you
// look at. A tile that goes away (scrolled out) leaves the queue, and its
// load, if it had started, is cancelled (its AbortSignal fires).
//
// Tiles on screen always come first: when every place is taken and a tile on
// screen is waiting, the load of a tile far off screen is cancelled and
// queued again behind it.

/** Priorities below this are tiles on screen (see `tilePriority`). */
export const ON_SCREEN = 1;
/** Loads of tiles at least this far off screen (px) give their place to tiles on screen. */
export const FAR_PX = 400;

type Grant = (signal: AbortSignal) => void;

interface Running {
  prio: number;
  grant: Grant;
  ctrl: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
}

export class LoadQueue {
  private waiting = new Map<string, { prio: number; grant: Grant }>();
  private running = new Map<string, Running>();
  /** Loads cancelled to make room for tiles on screen (for the measurements). */
  preempted = 0;

  constructor(
    /** At most this many loading at once. */
    public limit = 6,
    /** A load that never reports back frees its place after this long (ms). */
    private stuckMs = 8000,
  ) {}

  /**
   * Ask (again) for `key`; `grant` is called when its turn comes, with a
   * signal that fires if the load is cancelled (dropped, or put back to make
   * room). A new priority replaces the old one, also while it loads.
   */
  want(key: string, prio: number, grant: Grant) {
    const r = this.running.get(key);
    if (r) {
      r.prio = prio;
      r.grant = grant;
      this.pump();
      return;
    }
    const w = this.waiting.get(key);
    if (w) {
      w.prio = prio;
      w.grant = grant;
    } else this.waiting.set(key, { prio, grant });
    this.pump();
  }

  /** It loaded (or failed): the next one may start. */
  done(key: string) {
    const r = this.running.get(key);
    if (r) {
      if (r.timer) clearTimeout(r.timer);
      this.running.delete(key);
      this.pump();
    }
  }

  /** Not wanted any more (the tile went away): a load in progress is cancelled. */
  drop(key: string) {
    this.waiting.delete(key);
    const r = this.running.get(key);
    if (r) {
      r.ctrl.abort();
      this.done(key);
    }
  }

  get pending(): number {
    return this.waiting.size;
  }

  get active(): number {
    return this.running.size;
  }

  /** Is `key` loading right now? */
  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** Is `key` waiting or loading? */
  has(key: string): boolean {
    return this.running.has(key) || this.waiting.has(key);
  }

  private start(key: string, w: { prio: number; grant: Grant }) {
    this.waiting.delete(key);
    const ctrl = new AbortController();
    const timer = this.stuckMs > 0 ? setTimeout(() => this.done(key), this.stuckMs) : null;
    this.running.set(key, { prio: w.prio, grant: w.grant, ctrl, timer });
    w.grant(ctrl.signal);
  }

  private pump() {
    for (;;) {
      let best: string | null = null;
      let bp = Infinity;
      for (const [k, w] of this.waiting) {
        if (w.prio < bp) {
          bp = w.prio;
          best = k;
        }
      }
      if (best == null) return;
      if (this.running.size < this.limit) {
        this.start(best, this.waiting.get(best)!);
        continue;
      }
      // Full. A tile on screen is waiting: the farthest load off screen makes room.
      if (bp >= ON_SCREEN) return;
      let worst: string | null = null;
      let wp = ON_SCREEN + FAR_PX;
      for (const [k, r] of this.running) {
        if (r.prio >= wp) {
          wp = r.prio;
          worst = k;
        }
      }
      if (worst == null) return;
      const r = this.running.get(worst)!;
      if (r.timer) clearTimeout(r.timer);
      this.running.delete(worst);
      r.ctrl.abort();
      this.preempted += 1;
      // Back in line, behind the tiles on screen.
      this.waiting.set(worst, { prio: r.prio, grant: r.grant });
      this.start(best, this.waiting.get(best)!);
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
  return ON_SCREEN + (ahead ? dist : dist * 3);
}

/** How far past the view to draw tiles in the direction of travel, from the scroll speed (px per ms). */
export function lookAhead(speed: number): number {
  return 600 + Math.min(2400, Math.max(0, Math.abs(speed)) * 400);
}

/** The one queue for grid thumbnails. */
export const thumbQueue = new LoadQueue(6);
