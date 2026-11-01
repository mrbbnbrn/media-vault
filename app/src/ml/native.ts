// The app's own analysis pass (analyse.rs): each picture it can read is
// decrypted and decoded once, in memory, for its thumbnail, look-alike
// fingerprint and faces, on all cores but one (faces on the graphics card
// when possible). This starts it while
// a vault is open, shows its progress in the activity ring and tells the
// grids and pages when something is ready. The window's own loops only do
// what it can't (videos, other picture formats).

import { api, inTauri, onEvent, type AnalyseStatus } from '../api';
import { beginJob, endJob, updateJob } from '../jobs';
import { thumbMade } from '../media';
import { faceScanPaused, noteFaceProgress, onFaceScanPaused, stopFaceSearch } from './facescan';
import { noteFingerprintProgress } from '../fingerprint';

const JOB = 'analyse';
let options = { facesPaused: false };
let running = false;

/** Settings changed (the face scan paused or resumed). */
function setNativeOptions(o: Partial<typeof options>) {
  options = { ...options, ...o };
  if (running) api.analyseStart(options).catch(() => {});
}

/** The ring's wording for what is left (faces, else thumbnails and fingerprints). */
function analyseLabel(st: Pick<AnalyseStatus, 'facesLeft'>): string {
  return st.facesLeft > 0 ? 'Scanning faces' : 'Preparing thumbnails';
}

/** Runs while a vault is open; stops itself when it locks. */
export function startNativeAnalyser(): () => void {
  if (!inTauri || running) return () => {};
  running = true;
  options = { facesPaused: faceScanPaused() };
  let stopped = false;
  let active = false;
  let base = 0;
  let last: AnalyseStatus | null = null;
  let wake: (() => void) | null = null;
  // Batches of new thumbnails (a single id from older builds).
  const offThumb = onEvent<number | number[]>('analyse-thumb', (ids) => (Array.isArray(ids) ? ids : [ids]).forEach((id) => thumbMade(id)));
  const offPause = onFaceScanPaused((p) => setNativeOptions({ facesPaused: p }));
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
  const finish = () => {
    if (!active) return;
    active = false;
    const n = (last?.done ?? base) - base;
    endJob(JOB, { summary: `Analysis finished: ${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}` });
  };
  /** Show where the pass is; false once it has stopped. */
  const show = (st: AnalyseStatus): boolean => {
    if (!st.running) return false;
    const prev = last;
    last = st;
    if (st.left > 0) {
      const label = analyseLabel(st);
      if (!active) {
        active = true;
        base = st.done;
        beginJob({
          id: JOB, label, unit: 'items', total: st.left, long: st.facesLeft > 0, quiet: st.facesLeft === 0,
          cancel: st.facesLeft > 0 ? () => void stopFaceSearch() : undefined,
          cancelLabel: st.facesLeft > 0 ? 'Stop face search' : 'Pause',
        });
      } else {
        updateJob(JOB, { done: st.done - base, total: st.done - base + st.left, label });
      }
    } else {
      finish();
    }
    // Pages showing counts refresh when their part moved on.
    if (prev) {
      if (st.thumbs !== prev.thumbs || st.prints !== prev.prints) noteFingerprintProgress();
      if (st.faces !== prev.faces) noteFaceProgress();
    }
    return true;
  };
  // The pass tells after every round; asking is only in case an event was missed.
  const offStatus = onEvent<AnalyseStatus>('analyse-status', (st) => {
    if (stopped) return;
    if (!show(st)) wake?.();
  });
  (async () => {
    try {
      await api.analyseStart(options);
    } catch {
      running = false;
      return;
    }
    while (!stopped) {
      let st: AnalyseStatus;
      try {
        st = await api.analyseStatus();
      } catch {
        break; // locked
      }
      if (!show(st)) break;
      await sleep(30_000);
    }
    finish();
    running = false;
  })();
  return () => {
    stopped = true;
    running = false;
    offThumb.then((u) => u());
    offStatus.then((u) => u());
    offPause();
    wake?.();
    finish();
  };
}
