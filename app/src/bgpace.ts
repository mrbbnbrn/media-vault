// Background work steps aside: the window's own background loops (thumbnails,
// preview clips, fingerprints, face scanning, smart-search analysis, 3D
// preparing) wait between items while you are using the window, go slower
// while a video plays, and otherwise run when the window has a free moment.
// The backend's own analysis pass is told the same (api.setUserBusy).

import { api, inTauri } from './api';
import { onBusyChange, userBusy } from './calm';

let videoPlaying = 0;

/** A video is playing in the viewer (or stopped): background work slows down meanwhile. */
export function setVideoPlaying(on: boolean) {
  videoPlaying = Math.max(0, videoPlaying + (on ? 1 : -1));
  tellBackend();
}

const idle = (timeout: number) =>
  new Promise<void>((r) => {
    const w = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(() => r(), { timeout });
    else setTimeout(r, 0);
  });

/**
 * Await between two items of background work: returns once the user has paused
 * (or `stopped()`), after a breather while a video plays, in an idle moment.
 */
export async function giveWay(stopped: () => boolean = () => false): Promise<void> {
  while (!stopped() && userBusy()) await new Promise((r) => setTimeout(r, 250));
  if (stopped()) return;
  if (videoPlaying > 0) await new Promise((r) => setTimeout(r, 400));
  await idle(videoPlaying > 0 ? 1000 : 300);
}

// ---- the backend's own loops ---------------------------------------------------------------------

let told: boolean | null = null;
let tellTimer: ReturnType<typeof setTimeout> | null = null;

function tellBackend() {
  if (!inTauri) return;
  if (tellTimer) return;
  // Busy is said at once; calm a moment later (a short pause between clicks isn't calm yet).
  const busy = userBusy() || videoPlaying > 0;
  tellTimer = setTimeout(() => {
    tellTimer = null;
    const now = userBusy() || videoPlaying > 0;
    if (now === told) return;
    told = now;
    api.setUserBusy(now, videoPlaying > 0).catch(() => {});
  }, busy ? 0 : 200);
}

onBusyChange(tellBackend);
