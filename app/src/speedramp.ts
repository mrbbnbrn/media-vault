// "Speed ramp" for videos: the speed rises and falls in smooth waves, like an
// edit (slow-mo ↔ fast). With beat sync listening, a strong beat drops it to
// slow-mo at once, and it ramps back up into the wave.
//
// Pure (no timers): call rate(now) every animation frame and hit(now, strength)
// on each beat; the hook in Player sets video.playbackRate from it.

export const RAMP_SLOW = 0.5;
export const RAMP_FAST = 1.8;
/** One whole wave (slow → fast → slow), ms. */
export const RAMP_PERIOD_MS = 4800;
/** After a strong beat: stay in slow-mo this long, then ease back up over RAMP_BACK_MS. */
export const RAMP_HOLD_MS = 350;
export const RAMP_BACK_MS = 1200;
/** Strong beats closer than this don't start a new slow-mo. */
export const RAMP_HIT_GAP_MS = 1500;

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** The wave on its own: RAMP_SLOW at t=0, RAMP_FAST half a period later. */
export function waveRate(t: number, period = RAMP_PERIOD_MS): number {
  const phase = (((t % period) + period) % period) / period;
  const k = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
  return RAMP_SLOW + (RAMP_FAST - RAMP_SLOW) * k;
}

export class SpeedRamp {
  private start: number;
  private hitAt = -Infinity;
  private avgStrength = 0;
  private beats = 0;
  private shown: number | null = null;
  private lastAt: number | null = null;

  /** `base` is the user's own speed; the ramp multiplies it. */
  constructor(now: number, private base = 1) {
    this.start = now;
  }

  setBase(base: number): void {
    this.base = base > 0 ? base : 1;
  }

  /** A beat; true when it was strong enough to drop into slow-mo. Strong =
   *  clearly above the recent beats (or a drop the caller already noticed). */
  hit(now: number, strength: number, force = false): boolean {
    const s = Math.max(0, Math.min(1, strength));
    const strong = force || (this.beats >= 3 && s >= 0.55 && s >= this.avgStrength + 0.15);
    this.avgStrength = this.beats === 0 ? s : this.avgStrength + (s - this.avgStrength) * 0.15;
    this.beats += 1;
    if (!strong || now - this.hitAt < RAMP_HIT_GAP_MS) return false;
    this.hitAt = now;
    // Restart the wave from its slow end, so after the hit it climbs back up.
    this.start = now + RAMP_HOLD_MS + RAMP_BACK_MS - RAMP_PERIOD_MS / 2;
    return true;
  }

  /** The speed the video should play at, before smoothing. */
  target(now: number): number {
    let r = waveRate(now - this.start);
    const since = now - this.hitAt;
    if (since >= 0 && since < RAMP_HOLD_MS + RAMP_BACK_MS) {
      const back = smooth((since - RAMP_HOLD_MS) / RAMP_BACK_MS);
      r = RAMP_SLOW + (r - RAMP_SLOW) * back;
    }
    return r * this.base;
  }

  /** The speed for this frame: follows target() smoothly (a slow-mo hit lands
   *  within ~0.1 s, the wave itself is already smooth). Clamped to what
   *  browsers play (0.25–4). */
  rate(now: number): number {
    const want = this.target(now);
    if (this.shown == null || this.lastAt == null) this.shown = want;
    else {
      const dt = Math.max(0, now - this.lastAt);
      this.shown += (want - this.shown) * (1 - Math.exp(-dt / 60));
    }
    this.lastAt = now;
    return Math.max(0.25, Math.min(4, Math.round(this.shown * 100) / 100));
  }
}
