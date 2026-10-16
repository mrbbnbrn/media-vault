// Working out depth maps and outlines before they're needed (pictures only,
// never GIFs or videos), so 3D photos and the subject effects start at once:
//
// - while idle: with a 3D or subject effect on and no keyboard or mouse for
//   IDLE_MS, the pictures being viewed are worked out (and saved) one at a
//   time, stopping as soon as there's input;
// - "Work them all out again" (Settings → Faces & smart search): the saved
//   ones are cleared and every picture in the vault is worked out again in
//   the background, for the models in use, with progress and a Stop button.
//
// Both go through the same one-at-a-time queues as the viewer (depth.ts,
// subject.ts), behind whatever the viewer needs right now.

import { api, mediaUrl } from './api';
import { notePictures } from './derived';
import { depthOf, depthPack, depthSetup, depthTag, forgetDepth, knownDepth } from './depth';
import { forgetSubjects, knownSubject, subjectOf, subjectPack, subjectSetup, subjectTag } from './subject';

/** No keyboard or mouse for this long counts as idle (ms). */
export const IDLE_MS = 20000;

// ---- while idle ---------------------------------------------------------------------------------

/** Pictures already prepared this session (per model), so they aren't asked about again. */
const prepared = new Set<string>();

/**
 * Prepares `list()` (picture addresses, in order) while the app is idle, one
 * at a time, stopping as soon as there's input. `want`: which maps. Returns
 * the function that stops it.
 */
export function startIdlePrepare(list: () => string[], want: { depth: boolean; subject: boolean }): () => void {
  let last = performance.now();
  let busy = false;
  let stopped = false;
  const poke = () => {
    last = performance.now();
  };
  const idle = () => !stopped && performance.now() - last >= IDLE_MS;
  const events = ['keydown', 'pointermove', 'pointerdown', 'wheel', 'touchstart'] as const;
  for (const e of events) window.addEventListener(e, poke, { capture: true, passive: true });
  const timer = window.setInterval(() => {
    if (busy || !idle()) return;
    busy = true;
    void (async () => {
      try {
        if (want.depth && !depthSetup()) await depthPack();
        if (want.subject && !subjectSetup()) await subjectPack();
        const d = want.depth ? depthSetup() : null;
        const s = want.subject ? subjectSetup() : null;
        for (const src of list()) {
          if (!idle()) break;
          if (d) {
            const k = `d|${depthTag(d)}|${src}`;
            if (!prepared.has(k)) {
              if (knownDepth(src) === undefined) await depthOf(src);
              prepared.add(k);
            }
          }
          if (!idle()) break;
          if (s) {
            const k = `s|${subjectTag(s)}|${src}`;
            if (!prepared.has(k)) {
              if (knownSubject(src) === undefined) await subjectOf(src);
              prepared.add(k);
            }
          }
        }
      } catch {
        /* tried again when next idle */
      } finally {
        busy = false;
      }
    })();
  }, 1000);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    for (const e of events) window.removeEventListener(e, poke, { capture: true });
  };
}

// ---- working them all out again ----------------------------------------------------------------

export interface RebuildState {
  running: boolean;
  done: number;
  total: number;
  /** What it's doing or how it ended, in a few words (null = nothing to say). */
  note: string | null;
}

let state: RebuildState = { running: false, done: 0, total: 0, note: null };
let stopAsked = false;
const subs = new Set<() => void>();

function set(p: Partial<RebuildState>) {
  state = { ...state, ...p };
  subs.forEach((f) => f());
}

export function rebuildState(): RebuildState {
  return state;
}

export function onRebuild(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function stopRebuild() {
  if (state.running) {
    stopAsked = true;
    set({ note: 'Stopping after this picture…' });
  }
}

/** Clears the saved depth maps and outlines, then works out depth and outline for every picture in the vault. */
export async function rebuildAll(): Promise<void> {
  if (state.running) return;
  stopAsked = false;
  set({ running: true, done: 0, total: 0, note: 'Clearing the saved ones…' });
  let finished = false;
  try {
    const [d, s] = await Promise.all([depthPack(true), subjectPack(true)]);
    const useD = !!d?.available;
    const useS = !!s?.available;
    await api.derivedClear();
    // The copies in memory would otherwise be used without being saved again.
    forgetDepth();
    forgetSubjects();
    if (!useD && !useS) {
      set({ note: 'Cleared. No depth or outline model is installed, so nothing was worked out.' });
      return;
    }
    const items = await api.queryItems({ kinds: ['image'] });
    const pics = items.filter((i) => i.kind === 'image' && i.deletedAt == null).map((i) => ({ kind: 'image', src: mediaUrl(i.id), itemId: i.id }));
    notePictures(pics);
    set({ total: pics.length, note: null });
    for (let i = 0; i < pics.length; i++) {
      if (stopAsked) break;
      if (useD) await depthOf(pics[i].src);
      if (stopAsked) break;
      if (useS) await subjectOf(pics[i].src);
      set({ done: i + 1 });
    }
    finished = !stopAsked;
    set({ note: finished ? `Done: ${pics.length.toLocaleString()} ${pics.length === 1 ? 'picture' : 'pictures'} worked out.` : `Stopped after ${state.done.toLocaleString()} of ${pics.length.toLocaleString()}.` });
  } catch (e) {
    set({ note: `Couldn't finish: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    set({ running: false });
  }
}
