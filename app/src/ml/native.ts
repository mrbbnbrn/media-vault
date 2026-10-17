// The app's own analysis pass (analyse.rs): each picture it can read is
// decrypted and decoded once, in memory, for its thumbnail, look-alike
// fingerprint, smart-search vector and faces, on all cores but one (smart
// search and faces on the graphics card when possible). This starts it while
// a vault is open, shows its progress in the activity ring and tells the
// grids and pages when something is ready. The window's own loops only do
// what it can't (videos, other picture formats).

import { api, inTauri, onEvent, type AnalyseStatus } from '../api';
import { beginJob, endJob, updateJob } from '../jobs';
import { thumbMade } from '../media';
import { faceScanPaused, noteFaceProgress, onFaceScanPaused, setFaceScanPaused } from './facescan';
import { noteClipProgress } from './smart';
import { noteFingerprintProgress } from '../fingerprint';
import { userBusy } from '../calm';

const JOB = 'analyse';
let options = { smart: true, facesPaused: false };
let running = false;

/** Settings changed (smart search on or off). */
export function setNativeOptions(o: Partial<typeof options>) {
  options = { ...options, ...o };
  if (running) api.analyseStart(options).catch(() => {});
}

/** The ring's wording for what is left (without smart search it's only thumbnails and fingerprints). */
export function analyseLabel(st: Pick<AnalyseStatus, 'facesLeft'>, smart = true): string {
  return st.facesLeft > 0 ? (smart ? 'Analysing pictures and faces' : 'Scanning faces') : smart ? 'Analysing pictures' : 'Preparing thumbnails';
}

let smartPauser: (() => void) | null = null;
/** What "Pause" does for smart-search analysing (App: turns it off in the settings; resumed there). */
export function setSmartPauser(f: () => void) {
  smartPauser = f;
}

/** Runs while a vault is open; stops itself when it locks. */
export function startNativeAnalyser(smart: boolean): () => void {
  if (!inTauri || running) return () => {};
  running = true;
  options = { smart, facesPaused: faceScanPaused() };
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
      if (!st.running) break;
      const prev = last;
      last = st;
      if (st.left > 0) {
        const label = analyseLabel(st, options.smart);
        if (!active) {
          active = true;
          base = st.done;
          beginJob({
            id: JOB, label, unit: 'items', total: st.left, long: st.facesLeft > 0, quiet: st.facesLeft === 0,
            cancel: st.facesLeft > 0 ? () => setFaceScanPaused(true) : options.smart ? () => smartPauser?.() : undefined,
            cancelLabel: st.facesLeft > 0 ? 'Pause faces' : 'Pause',
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
        if (st.smart !== prev.smart) noteClipProgress();
        if (st.faces !== prev.faces) noteFaceProgress();
      }
      // Asking holds the library a moment (it counts): less often while you are using the window.
      await sleep(userBusy() ? 4000 : st.busy || st.left > 0 ? 1500 : 6000);
    }
    finish();
    running = false;
  })();
  return () => {
    stopped = true;
    running = false;
    offThumb.then((u) => u());
    offPause();
    wake?.();
    finish();
  };
}
