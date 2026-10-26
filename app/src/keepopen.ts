// Long jobs you started (import, export, sharing, encrypting, checking, storage
// work, preparing 3D data, copying out) keep the vault open: the idle auto-lock
// only counted the mouse and keyboard, so walking away from a big import locked
// the vault halfway and stopped it. While one runs, the app tells the backend
// it is in use. Locking by hand while one runs asks first (requestLock).

import { api } from './api';
import { jobList } from './jobs';

/** The jobs that keep the vault open (by their id in jobs.ts). Background analysis doesn't. */
const KEEPS_OPEN = /^(import-|export|share|check|storage|prepare-3d|encryption|copy)/;

/** What is running now that locking would stop (labels, for "Lock anyway?"). */
export function longWork(): string[] {
  return jobList()
    .filter((j) => !j.endedAt && KEEPS_OPEN.test(j.id))
    .map((j) => j.label);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Started once by App: every half minute, a running long job counts as using the vault. */
export function startKeepOpen() {
  if (timer) return;
  timer = setInterval(() => {
    if (longWork().length) api.reportActivity('input').catch(() => {});
  }, 30_000);
}

let ask: ((work: string[]) => void) | null = null;

/** Set by App: shows "Lock anyway?" with what would stop. */
export function setLockAsker(f: ((work: string[]) => void) | null) {
  ask = f;
}

/** The Lock buttons: lock at once, or ask first when a long job would stop. */
export function requestLock() {
  const work = longWork();
  if (work.length && ask) ask(work);
  else api.lock().catch(() => {});
}
