// Small rules used by the viewer, kept apart so they can be tested.

import type { FaceBox } from './api';
import { frameTimes } from './previews';

// ---- continue watching ------------------------------------------------------------------

/** Only videos longer than this remember where you left off. */
export const RESUME_MIN_SECONDS = 120;

/** Close to the end (last 5%, at least the last 20 s) counts as finished. */
export function nearEnd(at: number, dur: number): boolean {
  return dur - at <= Math.max(20, dur * 0.05);
}

/** What to save as the resume point (ms), or null to clear it. */
export function resumeValue(at: number, dur: number): number | null {
  if (!(dur > RESUME_MIN_SECONDS) || !Number.isFinite(at)) return null;
  if (at < 5 || nearEnd(at, dur)) return null;
  return Math.round(at * 1000);
}

/** Where to start a video opened by hand (seconds), or 0. */
export function resumeStart(resumeMs: number | null | undefined, dur: number): number {
  if (!resumeMs || !(dur > RESUME_MIN_SECONDS)) return 0;
  const at = resumeMs / 1000;
  return at > 0 && !nearEnd(at, dur) ? at : 0;
}

// ---- seek-bar previews ---------------------------------------------------------------------

/** The preview clip frame closest to `t` seconds. */
export function nearestFrame(t: number, duration: number): number {
  const times = frameTimes(duration);
  let best = 0;
  let bestD = Infinity;
  times.forEach((ft, i) => {
    const d = Math.abs(ft - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// ---- faces ----------------------------------------------------------------------------------------

/** Faces to show now: all of them for a picture; for a video, those within ±1.5 s. */
export function facesAt(faces: FaceBox[], video: boolean, atSeconds: number): FaceBox[] {
  if (!video) return faces;
  const ms = atSeconds * 1000;
  return faces.filter((f) => Math.abs(f.frameMs - ms) <= 1500);
}

// ---- slow pan and zoom ----------------------------------------------------------------------------

export interface KenBurns {
  from: { s: number; x: number; y: number };
  to: { s: number; x: number; y: number };
}

/** A gentle zoom (1.0 ↔ 1.12) with a small pan in a random direction (x, y in % of the size). */
export function kenBurnsPath(rand: () => number = Math.random): KenBurns {
  const angle = rand() * Math.PI * 2;
  const pan = 3 + rand() * 2;
  const x = Math.cos(angle) * pan;
  const y = Math.sin(angle) * pan;
  const zoomIn = rand() < 0.6;
  const near = { s: 1, x: 0, y: 0 };
  const far = { s: 1.12, x, y };
  return zoomIn ? { from: near, to: far } : { from: far, to: near };
}

// ---- duel pairs ---------------------------------------------------------------------------------------

export interface Rated {
  id: number;
  elo: number;
  duels: number;
}

export const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/**
 * Two items for the next duel: one of those with the fewest duels, against
 * one with a similar rating (and few duels), with some randomness. Never the
 * same pair as `last`.
 */
export function pickPair(list: Rated[], last: string | null, rand: () => number = Math.random): [Rated, Rated] | null {
  if (list.length < 2) return null;
  const byDuels = [...list].sort((a, b) => a.duels - b.duels || rand() - 0.5);
  const pool = byDuels.slice(0, Math.max(2, Math.ceil(byDuels.length * 0.25)));
  for (let tries = 0; tries < 8; tries++) {
    const a = pool[Math.floor(rand() * pool.length)];
    let best: Rated | null = null;
    let bestScore = Infinity;
    for (const b of list) {
      if (b.id === a.id || (last && pairKey(a.id, b.id) === last && list.length > 2)) continue;
      const score = Math.abs(a.elo - b.elo) / 100 + b.duels * 0.3 + rand() * 1.5;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best) return rand() < 0.5 ? [a, best] : [best, a];
  }
  return [list[0], list[1]];
}

// ---- speed round ------------------------------------------------------------------------------------

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 3;
export function clampSpeed(s: number): number {
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, s)) * 100) / 100;
}
