// Working out depth maps and outlines before they're needed (pictures only,
// never GIFs or videos), so 3D photos and the subject effects start at once:
//
// - while idle: with a 3D or subject effect on and no keyboard or mouse for
//   IDLE_MS, the pictures being viewed are worked out (and saved) one at a
//   time, stopping as soon as there's input;
// - in the background, on request: the pictures missing a saved map (whole
//   vault, Settings → Faces & smart search), every picture again (saved ones
//   cleared first), or the pictures of one folder or person folder (its
//   right-click menu). Every installed depth and outline model gets its own
//   maps (one model after another, so models aren't swapped back and forth),
//   at the detail and edge settings in use. One job at a time, the rest wait their turn; progress
//   shows in Settings and in the background-jobs ring, with Stop.
//
// Both go through the same one-at-a-time queues as the viewer (depth.ts,
// subject.ts), behind whatever the viewer needs right now.

import { api, mediaUrl, onLocked, type Item, type ItemFilter } from './api';
import { viewerPrefs } from './prefs';
import { beginJob, endJob, updateJob } from './jobs';
import { notePictures } from './derived';
import { depthChoice, depthOf, depthPack, depthSetup, depthTag, edgesSetting, forgetDepth, knownDepth, setupOf, type DepthSetup } from './depth';
import { forgetSubjects, knownSubject, subjectOf, subjectPack, subjectSetup, subjectSetupOf, subjectTag, type SubjectSetup } from './subject';

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

/** One model's work: its setup and the tag its maps are saved under. */
type Pass = { kind: 'depth'; setup: DepthSetup; tag: string; name: string } | { kind: 'outline'; setup: SubjectSetup; tag: string; name: string };

/** Every installed, usable depth and outline model, as the viewer would use it (detail and edges as set now). */
async function allPasses(): Promise<Pass[]> {
  const p = viewerPrefs();
  const detail = depthChoice(p).detail;
  const edges = edgesSetting(p.depthEdges);
  const [dms, sms] = await Promise.all([api.depthModels().catch(() => []), api.subjectModels().catch(() => [])]);
  const out: Pass[] = [];
  for (const m of dms.filter((x) => x.installed && !x.problem)) {
    const setup = setupOf(await api.depthInfo(m.id, detail).catch(() => null), edges);
    if (setup && !out.some((o) => o.tag === depthTag(setup))) out.push({ kind: 'depth', setup, tag: depthTag(setup), name: m.name });
  }
  for (const m of sms.filter((x) => x.installed && !x.problem)) {
    const setup = subjectSetupOf(await api.subjectInfo(m.id).catch(() => null));
    if (setup && !out.some((o) => o.kind === 'outline' && o.tag === subjectTag(setup))) out.push({ kind: 'outline', setup, tag: subjectTag(setup), name: m.name });
  }
  return out;
}

async function runOne(r: PrepareRequest): Promise<void> {
  stopAsked = false;
  set({ running: true, done: 0, total: 0, what: r.what, waiting: queue.length, note: r.again ? 'Clearing the saved ones…' : 'Finding the pictures…' });
  beginJob({ id: JOB, label: 'Preparing 3D data', detail: r.what, long: true, unit: 'maps', cancel: stopRebuild, cancelLabel: 'Stop' });
  let ok = true;
  try {
    if (r.again) {
      await api.derivedClear();
      // The copies in memory would otherwise be used without being saved again.
      forgetDepth();
      forgetSubjects();
    }
    const passes = await allPasses();
    if (!passes.length) {
      set({ note: r.again ? 'Cleared. No depth or outline model is installed, so nothing was worked out.' : 'No depth or outline model is installed, so there is nothing to work out.' });
      ok = false;
      return;
    }
    const pics = await picturesOf(r.filters);
    notePictures(pics);
    // For each model, the pictures that don't have its map saved yet.
    const work = await Promise.all(passes.map(async (p) => {
      const have = new Set(await api.derivedHave(p.kind, p.tag).catch(() => [] as number[]));
      return { p, todo: pics.filter((x) => !have.has(x.itemId)) };
    }));
    const total = work.reduce((n, w) => n + w.todo.length, 0);
    const already = pics.length * passes.length - total;
    set({ total, note: `${passes.length} ${passes.length === 1 ? 'model' : 'models'}, ${pics.length.toLocaleString()} ${pics.length === 1 ? 'picture' : 'pictures'}${already ? `, ${already.toLocaleString()} maps already saved` : ''}.` });
    updateJob(JOB, { total });
    let done = 0;
    for (const { p, todo } of work) {
      if (stopAsked) break;
      if (todo.length) updateJob(JOB, { detail: `${r.what} · ${p.name}` });
      for (const x of todo) {
        if (stopAsked) break;
        if (p.kind === 'depth') await depthOf(x.src, false, p.setup);
        else await subjectOf(x.src, false, p.setup);
        done += 1;
        set({ done });
        updateJob(JOB, { done });
      }
    }
    if (stopAsked) {
      ok = false;
      set({ note: `Stopped after ${done.toLocaleString()} of ${total.toLocaleString()} maps (${r.what}).` });
    } else if (!total) {
      set({ note: pics.length ? `Nothing to do: every picture in ${r.what} is already saved for every model.` : `No pictures in ${r.what}.` });
    } else {
      set({ note: `Done (${r.what}): ${done.toLocaleString()} ${done === 1 ? 'map' : 'maps'} worked out for ${passes.length} ${passes.length === 1 ? 'model' : 'models'}${already ? `, ${already.toLocaleString()} were already saved` : ''}.` });
    }
  } catch (e) {
    ok = false;
    set({ note: `Couldn't finish (${r.what}): ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    endJob(JOB, { failed: !ok, summary: `${state.done.toLocaleString()} maps prepared for 3D` });
    set({ running: false, what: null, waiting: queue.length });
  }
}

// Locking the vault stops it (nothing can be read or saved any more).
void onLocked(() => stopRebuild()).catch(() => {});
