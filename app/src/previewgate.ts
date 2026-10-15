// Grid previews rest while nobody can see them: the window is minimised or
// hidden, or the viewer covers the library (which stays underneath, frozen).
// Players are paused where they are and carry on when the library shows again.

import { useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { inTauri } from './api';

const covers = new Set<string>();
let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
let minimised = false;
let paused = false;
const subs = new Set<(paused: boolean) => void>();

const windowSubs = new Set<(resting: boolean) => void>();
let windowResting = hidden;

function update() {
  if ((hidden || minimised) !== windowResting) {
    windowResting = hidden || minimised;
    windowSubs.forEach((s) => s(windowResting));
  }
  const p = hidden || minimised || covers.size > 0;
  if (p === paused) return;
  paused = p;
  subs.forEach((s) => s(p));
}

export function previewsPaused(): boolean {
  return paused;
}

/** Called with true when previews must rest, false when they may play again. */
export function onPreviewsPaused(cb: (paused: boolean) => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/**
 * Only the window being hidden or minimised (not the viewer or the river
 * covering the library): the discovery river rests its own players with this.
 */
export function onWindowResting(cb: (resting: boolean) => void): () => void {
  windowSubs.add(cb);
  return () => windowSubs.delete(cb);
}
export const isWindowResting = () => windowResting;

/** Something covers the library (the viewer): `key` names who, so several can. */
export function setPreviewCover(key: string, on: boolean) {
  if (on) covers.add(key);
  else covers.delete(key);
  update();
}

export function usePreviewsPaused(): boolean {
  return useSyncExternalStore(
    (cb) => onPreviewsPaused(cb),
    () => paused,
  );
}

/** Resolves when the window can be seen again (the background maker waits for it). */
export function whenPreviewsMayRun(stopped: () => boolean): Promise<void> {
  // Only hidden / minimised matter here: under the viewer the library is still drawn.
  if (!(hidden || minimised)) return Promise.resolve();
  return new Promise((res) => {
    const t = setInterval(() => {
      if (stopped() || !(hidden || minimised)) {
        clearInterval(t);
        res();
      }
    }, 500);
  });
}

// ---- videos outside the player pool (folder cards) ----------------------------------------------

const extra = new Set<HTMLVideoElement>();
const resumeAfter = new WeakSet<HTMLVideoElement>();

/** Ref callback: this video rests with the grid previews. */
export function gateVideo(v: HTMLVideoElement | null) {
  if (!v) return;
  extra.add(v);
  v.dataset.gated = '1';
  if (paused) v.pause();
}
export function ungateVideo(v: HTMLVideoElement) {
  extra.delete(v);
}
onPreviewsPaused((p) => {
  for (const v of extra) {
    if (!v.isConnected) {
      extra.delete(v);
      continue;
    }
    if (p) {
      if (!v.paused) {
        resumeAfter.add(v);
        v.pause();
      }
    } else if (resumeAfter.has(v)) {
      resumeAfter.delete(v);
      v.play().catch(() => {});
    }
  }
});

// ---- watching the window -------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    hidden = document.visibilityState === 'hidden';
    update();
  });
  update();
}

if (inTauri) {
  // WebView2 doesn't always say "hidden" when the window is minimised: ask the window.
  try {
    const w = getCurrentWindow();
    const check = () =>
      w.isMinimized()
        .then((m) => {
          minimised = m;
          update();
        })
        .catch(() => {});
    check();
    w.onResized(check).catch(() => {});
    w.onFocusChanged(check).catch(() => {});
  } catch {
    // Not in the app window.
  }
}
