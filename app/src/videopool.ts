// Reused video players for grid previews. Creating and destroying <video>
// elements while scrolling is slow (each one sets up a media pipeline);
// instead, players that leave the screen are paused, taken out of their tile
// and handed to tiles coming in (only the address changes). The pool grows to
// as many players as there are video tiles on screen — there is no small
// fixed limit — and lets go of spare ones when it is far bigger than needed.

export interface PoolPlayer {
  src: string;
  paused: boolean;
  pause(): void;
  play(): Promise<void>;
  remove(): void;
  removeAttribute(name: string): void;
  load(): void;
}

export interface PoolStats {
  /** Players made since the start. */
  created: number;
  /** Times a spare player was handed to a new tile. */
  reused: number;
  /** …and of those, how many already had the right video loaded. */
  warm: number;
  /** Spare players let go. */
  dropped: number;
  inUse: number;
  spare: number;
}

/** Keep at least this many spare players, and up to half as many as are in use. */
export const MIN_SPARE = 4;
export const SPARE_SHARE = 0.5;

export class PlayerPool<P extends PoolPlayer> {
  private spare: P[] = [];
  private used = new Set<P>();
  private resting = new WeakSet<P>();
  private paused = false;
  readonly stats: PoolStats = { created: 0, reused: 0, warm: 0, dropped: 0, inUse: 0, spare: 0 };

  private trimTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `later` runs the clean-up of spare players a moment after the last
   * release, so a burst of tiles leaving and coming (a fast scroll, a layout
   * change) swaps players instead of dropping and making them.
   */
  constructor(
    private make: () => P,
    private later: (fn: () => void) => ReturnType<typeof setTimeout> | null = (fn) => setTimeout(fn, 2500),
  ) {}

  /** A player for `src`: a spare one that already has it, else any spare one, else a new one. */
  acquire(src: string): P {
    let i = this.spare.findIndex((p) => p.src === src);
    const warm = i >= 0;
    // Otherwise the one waiting longest (least likely to be scrolled back to).
    if (i < 0 && this.spare.length) i = 0;
    let p: P;
    if (i >= 0) {
      p = this.spare.splice(i, 1)[0];
      this.stats.reused++;
      if (warm) this.stats.warm++;
    } else {
      p = this.make();
      this.stats.created++;
    }
    this.used.add(p);
    this.count();
    return p;
  }

  /** A tile is done with its player: paused, taken out of the page, kept for the next tile. */
  release(p: P) {
    if (!this.used.delete(p)) return;
    p.pause();
    p.remove();
    this.resting.delete(p);
    // Most recently used last, so a tile scrolled back finds its video still loaded.
    this.spare.push(p);
    this.count();
    if (this.trimTimer) clearTimeout(this.trimTimer);
    this.trimTimer = this.later(() => {
      this.trimTimer = null;
      this.trim();
    });
  }

  /** Let go of spare players beyond what's sensible for the players in use. */
  trim() {
    const keep = Math.max(MIN_SPARE, Math.ceil(this.used.size * SPARE_SHARE));
    while (this.spare.length > keep) {
      const p = this.spare.shift()!;
      p.removeAttribute('src');
      p.load();
      this.stats.dropped++;
    }
    this.count();
  }

  /** Pause every player in use (window hidden, viewer open); `resume` starts those again. */
  pauseAll() {
    this.paused = true;
    for (const p of this.used) {
      if (!p.paused) {
        this.resting.add(p);
        p.pause();
      }
    }
  }
  resumeAll() {
    this.paused = false;
    for (const p of this.used) {
      if (this.resting.has(p)) {
        this.resting.delete(p);
        p.play().catch(() => {});
      }
    }
  }
  get isPaused() {
    return this.paused;
  }
  /** A tile wants its player playing; while paused it starts when resumed. */
  play(p: P) {
    if (this.paused) this.resting.add(p);
    else p.play().catch(() => {});
  }

  inUse(): P[] {
    return [...this.used];
  }

  private count() {
    this.stats.inUse = this.used.size;
    this.stats.spare = this.spare.length;
  }
}
