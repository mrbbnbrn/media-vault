// Music-driven slideshow helpers (pure, no timers or events, so they can be tested):
//
//  * DropDetector  — "Beat drop": notices a beat much bigger than the recent ones
//                    (a drop / big hit) together with a jump in loudness.
//  * MontagePacer  — "Montage": quick cuts on busy parts, long holds on calm parts;
//                    picks how many beats each item stays (1, 2, 4 or 8).
//
// Both are fed the `strength` (0..1) of each beat and the loudness level (0..1,
// about 10 times a second) that the beat listener reports. Times are in ms.

/** Running average that forgets with a time constant (ms), whatever the update rate. */
function ease(avg: number, value: number, dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return avg;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return avg + (value - avg) * k;
}

/** Never two drops closer than this (ms): one big hit = one cut. */
export const DROP_COOLDOWN_MS = 2500;
/** A drop moves on at once, but never sooner than this after the previous change (ms). */
export const DROP_MIN_GAP_MS = 350;

export class DropDetector {
  /** Average strength of recent beats (per beat, ~the last 8). */
  private avgStrength = 0;
  /** Slow average loudness (~3 s), the "before" to compare against. */
  private slowLevel = 0;
  /** Loudest level in the last moment (decays fast). */
  private peakLevel = 0;
  private lastLevelAt: number | null = null;
  private beats = 0;
  private levels = 0;
  private lastDrop = -Infinity;

  /** A loudness reading (about 10 a second). */
  level(now: number, level: number): void {
    const l = Math.max(0, Math.min(1, level));
    if (this.lastLevelAt == null) {
      this.slowLevel = l;
      this.peakLevel = l;
    } else {
      const dt = now - this.lastLevelAt;
      // The peak follows rises at once and falls within ~0.3 s.
      this.peakLevel = Math.max(l, ease(this.peakLevel, l, dt, 300));
      this.slowLevel = ease(this.slowLevel, l, dt, 3000);
    }
    this.lastLevelAt = now;
    this.levels += 1;
  }

  /** A beat at `now`. True when it is a drop: much stronger than the recent
   *  beats and the music suddenly got louder. */
  beat(now: number, strength: number): boolean {
    const s = Math.max(0, Math.min(1, strength));
    const warm = this.beats >= 4 && this.levels >= 5;
    const strongJump = s >= 0.5 && (s >= this.avgStrength * 1.6 || s - this.avgStrength >= 0.3);
    const loudJump = this.peakLevel - this.slowLevel;
    const louder = loudJump >= 0.12 || (this.slowLevel > 0.02 && this.peakLevel >= this.slowLevel * 1.5 && loudJump >= 0.06);
    // A huge loudness jump with a clear beat counts too (strength is often near 1 on every beat).
    const hugeJump = s >= 0.5 && loudJump >= 0.25;
    const drop = warm && now - this.lastDrop >= DROP_COOLDOWN_MS && ((strongJump && louder) || hugeJump);
    this.avgStrength = this.beats === 0 ? s : this.avgStrength + (s - this.avgStrength) * 0.125;
    this.beats += 1;
    if (drop) {
      this.lastDrop = now;
      // The loud part after the drop is the new normal: it shouldn't count as another jump.
      this.slowLevel = this.peakLevel;
      this.avgStrength = s;
    }
    return drop;
  }
}

/** Montage: the beats an item stays for each kind of moment. */
export const MONTAGE_STEPS = [1, 2, 4, 8] as const;
export type MontageEvery = (typeof MONTAGE_STEPS)[number];

/** How busy the music is (0..1) from loudness, beat strength and steadiness. */
export function montageEnergy(level: number, strength: number, steady: number): number {
  return Math.max(0, Math.min(1, 0.5 * level + 0.35 * strength + 0.15 * steady));
}

/** Energy → beats per item, without stickiness. */
function classify(energy: number): MontageEvery {
  return energy >= 0.62 ? 1 : energy >= 0.45 ? 2 : energy >= 0.25 ? 4 : 8;
}

/** Energy → beats per item, with a little stickiness around the edges so it
 *  doesn't flip back and forth: it only changes once the energy is clearly
 *  past an edge. */
export function montageEvery(energy: number, current: MontageEvery = 2, pad = 0.04): MontageEvery {
  const busier = classify(energy + pad);
  const calmer = classify(energy - pad);
  if (busier <= current && current <= calmer) return current;
  return classify(energy);
}

export class MontagePacer {
  private level = 0;
  private strength = 0;
  private steady = 0;
  private lastLevelAt: number | null = null;
  private lastBeat: number | null = null;
  private lastGap: number | null = null;
  private current: MontageEvery = 2;

  /** A loudness reading (about 10 a second); smoothed over ~1.5 s. */
  levelAt(now: number, level: number): void {
    const l = Math.max(0, Math.min(1, level));
    this.level = this.lastLevelAt == null ? l : ease(this.level, l, now - this.lastLevelAt, 1500);
    this.lastLevelAt = now;
  }

  /** A beat; returns how many beats the current item should stay now. */
  beat(now: number, strength: number): MontageEvery {
    const s = Math.max(0, Math.min(1, strength));
    this.strength += (s - this.strength) * 0.2;
    if (this.lastBeat != null) {
      const gap = now - this.lastBeat;
      // Steady = the gap between beats stays about the same.
      if (this.lastGap != null && gap > 0) {
        const same = 1 - Math.min(1, Math.abs(gap - this.lastGap) / Math.max(gap, this.lastGap) / 0.25);
        this.steady += (same - this.steady) * 0.2;
      }
      this.lastGap = gap;
    }
    this.lastBeat = now;
    this.current = montageEvery(this.energy(), this.current);
    return this.current;
  }

  energy(): number {
    return montageEnergy(this.level, this.strength, this.steady);
  }

  every(): MontageEvery {
    return this.current;
  }
}
