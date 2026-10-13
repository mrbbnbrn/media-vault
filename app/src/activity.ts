// Tells the backend when the user is active, so auto-lock only happens when
// they are truly idle: no mouse/keyboard AND nothing playing.

import { api } from './api';

const INPUT_THROTTLE_MS = 5_000;
const PLAYING_BEAT_MS = 10_000;

let lastSent = 0;
const playingSources = new Set<string>();
let beat: ReturnType<typeof setInterval> | null = null;

/** Throttle helper, exported for tests. */
export function shouldSend(now: number, last: number, every: number): boolean {
  return now - last >= every;
}

function onInput() {
  const now = Date.now();
  if (shouldSend(now, lastSent, INPUT_THROTTLE_MS)) {
    lastSent = now;
    api.reportActivity('input').catch(() => {});
  }
}

export function startActivityTracking(): () => void {
  const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;
  events.forEach((e) => window.addEventListener(e, onInput, { passive: true }));
  return () => events.forEach((e) => window.removeEventListener(e, onInput));
}

/**
 * Mark something as playing (a slideshow, a video, a multi-screen panel).
 * While any source is playing, the vault never locks for being idle.
 */
export function setPlaying(source: string, playing: boolean): void {
  if (playing) playingSources.add(source);
  else playingSources.delete(source);

  if (playingSources.size > 0 && !beat) {
    api.reportActivity('playing').catch(() => {});
    beat = setInterval(() => api.reportActivity('playing').catch(() => {}), PLAYING_BEAT_MS);
  } else if (playingSources.size === 0 && beat) {
    clearInterval(beat);
    beat = null;
  }
}

export function stopAllPlaying(): void {
  playingSources.clear();
  if (beat) clearInterval(beat);
  beat = null;
}
