// Long background jobs started from anywhere (check for damage, export):
// their progress and result live here so any screen can show them.

import { useSyncExternalStore } from 'react';
import { api, onEvent, type DamageReport, type ExportDone, type ExportProgress } from './api';

export interface TaskState {
  check: { done: number; total: number } | null;
  checkResult: { report: DamageReport } | { error: string } | null;
  exporting: ExportProgress | null;
  exportStarting: boolean;
  exportDone: ExportDone | null;
}

let state: TaskState = { check: null, checkResult: null, exporting: null, exportStarting: false, exportDone: null };
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

export function dismissCheck() {
  set({ checkResult: null });
}

export function dismissExport() {
  set({ exportDone: null });
}

export function clearTasks() {
  set({ check: null, checkResult: null, exporting: null, exportStarting: false, exportDone: null });
}
