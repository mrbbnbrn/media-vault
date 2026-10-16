// Working out depth maps and outlines before they're needed (pictures only,
// never GIFs or videos), so 3D photos and the subject effects start at once:
//
// - while idle: with a 3D or subject effect on and no keyboard or mouse for
//   IDLE_MS, the pictures being viewed are worked out (and saved) one at a
//   time, stopping as soon as there's input;
// - in the background, on request: the pictures missing a saved map (whole
//   vault, Settings → Faces & smart search), every picture again (saved ones
//   cleared first), or the pictures of one folder or person folder (its
//   right-click menu). One job at a time, the rest wait their turn; progress
//   shows in Settings and in the background-jobs ring, with Stop.
//
// Both go through the same one-at-a-time queues as the viewer (depth.ts,
// subject.ts), behind whatever the viewer needs right now.

import { api, mediaUrl, type Item, type ItemFilter } from './api';
import { beginJob, endJob, updateJob } from './jobs';
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

// ---- in the background, on request -------------------------------------------------------------

export interface RebuildState {
  running: boolean;
  done: number;
  total: number;
  /** What's being worked on ("the whole vault", "“Anna”"; null = nothing running). */
  what: string | null;
  /** Jobs waiting their turn. */
  waiting: number;
  /** What it's doing or how it ended, in a few words (null = nothing to say). */
  note: string | null;
}

/** One request: which pictures, and whether saved ones are cleared and worked out again. */
export interface PrepareRequest {
  what: string;
  filters: ItemFilter[];
  /** Clear every saved map first and work everything out again. */
  again?: boolean;
}

let state: RebuildState = { running: false, done: 0, total: 0, what: null, waiting: 0, note: null };
let stopAsked = false;
const queue: PrepareRequest[] = [];
const subs = new Set<() => void>();
const JOB = 'prepare-3d';

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

/** Stops the job running now (after the picture being worked on) and drops the ones waiting. */
export function stopRebuild() {
  queue.length = 0;
  if (state.running) {
    stopAsked = true;
    set({ waiting: 0, note: 'Stopping after this picture…' });
  }
}

/** The whole vault: only the pictures missing a saved map, or (again) everything after clearing. */
export function prepareVault(again: boolean): 'started' | 'queued' | 'already' {
  return prepareInBackground({ what: 'the whole vault', filters: [{ kinds: ['image'] }], again });
}

/** One folder (and its subfolders); a person folder also gets the pictures their face was recognised in. */
export function prepareFolder(f: { id: number; name: string; person: boolean }): 'started' | 'queued' | 'already' {
  const filters: ItemFilter[] = [{ folder: f.id, recursive: true, kinds: ['image'] }];
  if (f.person) filters.push({ people: [f.id], kinds: ['image'] });
  return prepareInBackground({ what: `“${f.name}”`, filters });
}

/** Adds a request (started at once when nothing runs). */
export function prepareInBackground(r: PrepareRequest): 'started' | 'queued' | 'already' {
  if (state.what === r.what && state.running && !stopAsked && !r.again) return 'already';
  if (queue.some((q) => q.what === r.what && !!q.again === !!r.again)) return 'already';
  queue.push(r);
  if (state.running) {
    set({ waiting: queue.length });
    return 'queued';
  }
  void drain();
  return 'started';
}

async function drain() {
  while (queue.length) {
    const r = queue.shift()!;
    await runOne(r);
  }
}

async function picturesOf(filters: ItemFilter[]): Promise<{ kind: string; src: string; itemId: number }[]> {
  const seen = new Map<number, Item>();
  for (const f of filters) for (const i of await api.queryItems(f)) if (!seen.has(i.id)) seen.set(i.id, i);
  return [...seen.values()].filter((i) => i.kind === 'image' && i.deletedAt == null).map((i) => ({ kind: 'image', src: mediaUrl(i.id), itemId: i.id }));
}

async function runOne(r: PrepareRequest): Promise<void> {
  stopAsked = false;
  set({ running: true, done: 0, total: 0, what: r.what, waiting: queue.length, note: r.again ? 'Clearing the saved ones…' : 'Finding the pictures…' });
  beginJob({ id: JOB, label: 'Preparing 3D data', detail: r.what, long: true, unit: 'pictures', cancel: stopRebuild, cancelLabel: 'Stop' });
  let ok = true;
  try {
    const [di, si] = await Promise.all([depthPack(true), subjectPack(true)]);
    const d = di?.available ? depthSetup() : null;
    const s = si?.available ? subjectSetup() : null;
    if (r.again) {
      await api.derivedClear();
      // The copies in memory would otherwise be used without being saved again.
      forgetDepth();
      forgetSubjects();
    }
    if (!d && !s) {
      set({ note: r.again ? 'Cleared. No depth or outline model is installed, so nothing was worked out.' : 'No depth or outline model is installed, so there is nothing to work out.' });
      ok = false;
      return;
    }
    const pics = await picturesOf(r.filters);
    notePictures(pics);
    // Pictures that already have both maps saved for the models in use are skipped.
    const [hasD, hasS] = await Promise.all([
      d ? api.derivedHave('depth', depthTag(d)).then((l) => new Set(l)) : Promise.resolve(null),
      s ? api.derivedHave('outline', subjectTag(s)).then((l) => new Set(l)) : Promise.resolve(null),
    ]);
    const todo = pics.filter((p) => (d && !hasD?.has(p.itemId)) || (s && !hasS?.has(p.itemId)));
    const already = pics.length - todo.length;
    set({ total: todo.length, note: already ? `${already.toLocaleString()} already saved.` : null });
    updateJob(JOB, { total: todo.length });
    for (let i = 0; i < todo.length; i++) {
      if (stopAsked) break;
      const p = todo[i];
      if (d && !hasD?.has(p.itemId)) await depthOf(p.src);
      if (stopAsked) break;
      if (s && !hasS?.has(p.itemId)) await subjectOf(p.src);
      set({ done: i + 1 });
      updateJob(JOB, { done: i + 1 });
    }
    const n = state.done;
    if (stopAsked) {
      ok = false;
      set({ note: `Stopped after ${n.toLocaleString()} of ${todo.length.toLocaleString()} (${r.what}).` });
    } else if (!todo.length) {
      set({ note: pics.length ? `Nothing to do: every picture in ${r.what} is already saved.` : `No pictures in ${r.what}.` });
    } else {
      set({ note: `Done (${r.what}): ${n.toLocaleString()} ${n === 1 ? 'picture' : 'pictures'} worked out${already ? `, ${already.toLocaleString()} were already saved` : ''}.` });
    }
  } catch (e) {
    ok = false;
    set({ note: `Couldn't finish (${r.what}): ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    endJob(JOB, { failed: !ok, summary: `${state.done.toLocaleString()} pictures prepared for 3D` });
    set({ running: false, what: null, waiting: queue.length });
  }
}
