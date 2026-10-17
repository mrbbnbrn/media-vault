// Long background jobs started from anywhere (check for damage, export):
// their progress and result live here so any screen can show them.

import { useSyncExternalStore } from 'react';
import { api, onEvent, type DamageReport, type ExportDone, type ExportProgress, type ShareDone, type ShareProgress, type ShareRequest } from './api';

export interface TaskState {
  check: { done: number; total: number } | null;
  checkResult: { report: DamageReport } | { error: string } | null;
  exporting: ExportProgress | null;
  exportStarting: boolean;
  exportDone: ExportDone | null;
  // share as encrypted .7z
  sharing: ShareProgress | null;
  shareStarting: boolean;
  shareDone: ShareDone | null;
  /** The share window is open and shows the progress itself (the corner card stays hidden). */
  shareWatched: boolean;
}

const idle: TaskState = {
  check: null, checkResult: null, exporting: null, exportStarting: false, exportDone: null,
  sharing: null, shareStarting: false, shareDone: null, shareWatched: false,
};
let state: TaskState = idle;
const subs = new Set<() => void>();
const set = (patch: Partial<TaskState>) => {
  state = { ...state, ...patch };
  subs.forEach((s) => s());
};

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onEvent<{ done: number; total: number }>('check-progress', (p) => set({ check: { done: p.done, total: p.total } }));
  onEvent<{ Ok?: DamageReport; Err?: string }>('check-done', (r) =>
    set({ check: null, checkResult: r.Ok ? { report: r.Ok } : { error: r.Err ?? 'The check stopped.' } }),
  );
  onEvent<ExportProgress>('export-progress', (p) => set({ exporting: p, exportStarting: false }));
  onEvent<ExportDone>('export-done', (d) => set({ exporting: null, exportStarting: false, exportDone: d }));
  onEvent<ShareProgress>('share-progress', (p) => set({ sharing: p, shareStarting: false }));
  onEvent<ShareDone>('share-done', (d) => set({ sharing: null, shareStarting: false, shareDone: d }));
}

export function useTasks(): TaskState {
  listen();
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}

export async function startCheck() {
  listen();
  set({ check: { done: 0, total: 0 }, checkResult: null });
  try {
    await api.checkDamage();
  } catch (e) {
    set({ check: null, checkResult: { error: String((e as Error)?.message ?? e) } });
  }
}

export async function startExport(req: Parameters<typeof api.exportStart>[0]) {
  listen();
  set({ exportStarting: true, exportDone: null });
  try {
    await api.exportStart(req);
  } catch (e) {
    set({ exportStarting: false });
    throw e;
  }
}

export async function startShare(req: ShareRequest) {
  listen();
  set({ shareStarting: true, shareDone: null, sharing: null });
  try {
    await api.share7zStart(req);
  } catch (e) {
    set({ shareStarting: false });
    throw e;
  }
}

export function dismissShare() {
  set({ shareDone: null });
}

export function watchShare(on: boolean) {
  set({ shareWatched: on });
}

export function dismissCheck() {
  set({ checkResult: null });
}

export function dismissExport() {
  set({ exportDone: null });
}

export function clearTasks() {
  set(idle);
}

/**
 * Only a part of the state: the component draws again only when that part
 * changes (not on every progress message), e.g. `useTaskPart((t) => !!t.exportDone)`.
 */
export function useTaskPart<T>(pick: (t: TaskState) => T): T {
  listen();
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => pick(state),
  );
}
