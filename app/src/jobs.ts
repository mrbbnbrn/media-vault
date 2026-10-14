// One place for everything that runs in the background: imports, exports,
// shares, conversions, copies, the damage check, face scanning, smart-search
// analysis, thumbnails, preview clips and picture fingerprints. Each reports
// here; the activity ring in the sidebar shows them, the Windows taskbar
// button shows the long ones, and a notification says when a long one
// finished while the window was in the background (counts only, never names:
// notifications show on the lock screen).

import { useSyncExternalStore } from 'react';
import {
  api, inTauri, onEvent,
  type AnimationDone, type ConvertDone, type DamageReport, type ExportDone, type ExportProgress, type ImportProgress,
  type ImportReport, type ShareDone, type StorageDone, type StorageProgress, type VideoToolProgress,
} from './api';

export interface Job {
  id: string;
  /** Short, shown in the popover ("Importing", "Scanning faces"). */
  label: string;
  /** Extra detail for the popover only (never in notifications). */
  detail?: string;
  done: number;
  /** 0 = unknown (the bar runs back and forth). */
  total: number;
  /** "items", "files"… for "1,240 of 5,000 items". */
  unit: string;
  /** Overall progress 0…1 when it isn't done/total (e.g. by bytes). */
  fraction?: number;
  startedAt: number;
  /** Counts for the taskbar and notifications (imports, exports, scans…). */
  long: boolean;
  /** Housekeeping (thumbnails, clips…): only shown once it has run a moment. */
  quiet?: boolean;
  cancel?: () => void;
  cancelLabel?: string;
  /** Finished: kept a few seconds so the ring can fade out. */
  endedAt?: number;
  failed?: boolean;
}

// ---- the store -------------------------------------------------------------------------

let jobs: Job[] = [];
const subs = new Set<() => void>();
const emit = () => {
  jobs = [...jobs];
  subs.forEach((s) => s());
  taskbar();
};

export function useJobs(): Job[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => jobs,
  );
}

export const jobList = () => jobs;

/** Start (or restart) a job. */
export function beginJob(j: Omit<Job, 'startedAt' | 'done' | 'total' | 'unit'> & Partial<Pick<Job, 'done' | 'total' | 'unit'>>) {
  const old = jobs.find((x) => x.id === j.id);
  const fresh: Job = { done: 0, total: 0, unit: 'items', ...j, startedAt: old && !old.endedAt ? old.startedAt : Date.now() };
  jobs = [...jobs.filter((x) => x.id !== j.id), fresh];
  emit();
}

/** Progress of a running job (starts it with `init` if it isn't there yet). */
export function updateJob(id: string, p: Partial<Pick<Job, 'done' | 'total' | 'fraction' | 'detail' | 'label'>>, init?: Omit<Job, 'id' | 'startedAt' | 'done' | 'total' | 'unit'> & { unit?: string }) {
  const j = jobs.find((x) => x.id === id && !x.endedAt);
  if (!j) {
    if (init) beginJob({ id, ...init, ...p });
    return;
  }
  Object.assign(j, p);
  emit();
}

const FADE_MS = 4000;
let sweep: ReturnType<typeof setTimeout> | null = null;

/** The job finished (or failed). `summary` goes into the notification: counts only. */
export function endJob(id: string, r: { failed?: boolean; summary?: string } = {}) {
  const j = jobs.find((x) => x.id === id && !x.endedAt);
  if (!j) return;
  j.endedAt = Date.now();
  j.failed = !!r.failed;
  if (!j.failed) {
    if (j.total) j.done = Math.max(j.done, j.total);
    j.fraction = 1;
  }
  j.cancel = undefined;
  emit();
  if (r.failed) flashError();
  if (j.long && r.summary && j.endedAt - j.startedAt >= NOTIFY_AFTER_MS) notify(r.summary);
  if (sweep) clearTimeout(sweep);
  sweep = setTimeout(() => {
    sweep = null;
    const now = Date.now();
    jobs = jobs.filter((x) => !x.endedAt || now - x.endedAt < FADE_MS - 50);
    emit();
  }, FADE_MS);
}

/** Forget everything (the vault was locked). */
export function clearJobs() {
  jobs = [];
  emit();
}

// ---- maths for the ring and the popover (exported for tests) ------------------------------

/** 0…1, or null when it can't be told. */
export function jobFraction(j: Job): number | null {
  if (j.endedAt && !j.failed) return 1;
  if (j.fraction != null) return Math.max(0, Math.min(1, j.fraction));
  return j.total > 0 ? Math.max(0, Math.min(1, j.done / j.total)) : null;
}

/** Overall progress of several jobs (unknown ones count as half way). */
export function overall(list: Job[]): number {
  if (!list.length) return 0;
  return list.reduce((s, j) => s + (jobFraction(j) ?? 0.5), 0) / list.length;
}

/** Seconds left, once it has run long enough to say. */
export function secondsLeft(j: Job, now: number): number | null {
  const f = jobFraction(j);
  const ran = (now - j.startedAt) / 1000;
  if (f == null || f <= 0.02 || f >= 1 || ran < 4) return null;
  return (ran / f) * (1 - f);
}

export function formatLeft(s: number | null): string {
  if (s == null) return '';
  if (s < 50) return 'less than a minute left';
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} min left`;
  const h = Math.floor(m / 60);
  return `about ${h} h ${m % 60 ? `${m % 60} min ` : ''}left`;
}

export function countText(j: Job): string {
  if (j.total > 0) return `${j.done.toLocaleString()} of ${j.total.toLocaleString()}${j.unit ? ` ${j.unit}` : ''}`;
  return j.done > 0 ? `${j.done.toLocaleString()} ${j.unit} so far` : '';
}

/** Which jobs the ring shows now (quiet ones only after they've run a moment). */
export function visibleJobs(list: Job[], now: number): Job[] {
  return list.filter((j) => {
    const from = j.quiet && j.total < 25 ? j.startedAt + 1500 : j.startedAt;
    return now >= from && (j.endedAt ?? now) >= from;
  });
}

const many = (n: number, one: string, more = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : more}`;

// ---- taskbar and notifications ------------------------------------------------------------

let notifyOn = true;
const NOTIFY_AFTER_MS = 20_000;

/** From Settings: "Notify me when long jobs finish". */
export function setNotifyWhenDone(on: boolean) {
  notifyOn = on;
}

async function notify(body: string) {
  if (!inTauri || !notifyOn || document.hasFocus()) return;
  try {
    const n = await import('@tauri-apps/plugin-notification');
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === 'granted';
    if (ok) n.sendNotification({ title: 'Media Vault', body });
  } catch {
    // No notifications on this system: nothing to do.
  }
}

let errorUntil = 0;
let shown = '';
function flashError() {
  errorUntil = Date.now() + 5000;
  setTimeout(taskbar, 5100);
}

/** The taskbar button: overall progress of the long jobs, red for a moment after a failure. */
function taskbar() {
  if (!inTauri) return;
  const live = jobs.filter((j) => j.long && !j.endedAt);
  const err = Date.now() < errorUntil;
  let state: { status: 'none' | 'normal' | 'indeterminate' | 'error'; progress?: number };
  if (live.length) {
    const unknown = live.every((j) => jobFraction(j) == null);
    state = unknown ? { status: 'indeterminate' } : { status: err ? 'error' : 'normal', progress: Math.round(overall(live) * 100) };
  } else {
    state = err ? { status: 'error', progress: 100 } : { status: 'none' };
  }
  const key = `${state.status}:${state.progress ?? ''}`;
  if (key === shown) return;
  shown = key;
  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow, ProgressBarStatus }) => {
      const status = {
        none: ProgressBarStatus.None, normal: ProgressBarStatus.Normal, indeterminate: ProgressBarStatus.Indeterminate, error: ProgressBarStatus.Error,
      }[state.status];
      return getCurrentWindow().setProgressBar({ status, progress: state.progress });
    })
    .catch(() => {});
}

// ---- jobs the backend runs (events) ----------------------------------------------------------

let listening = false;

/** Listen to the backend's progress events (once; the ring calls this). */
export function listenForJobs() {
  if (listening) return;
  listening = true;

  onEvent<ImportProgress>('import-progress', (p) =>
    updateJob(`import-${p.job}`, { done: p.done, total: p.total, detail: p.source || undefined }, {
      label: 'Importing', unit: 'files', long: true, cancel: () => api.cancelImport(p.job).catch(() => {}),
    }),
  );
  onEvent<ImportReport>('import-done', (r) =>
    endJob(`import-${r.job}`, {
      summary: r.cancelled ? `Import stopped: ${many(r.imported, 'item')} added` : `Import finished: ${many(r.imported, 'item')}`,
      failed: !r.cancelled && r.imported === 0 && r.failed.length > 0,
    }),
  );

  onEvent<{ done: number; total: number }>('check-progress', (p) =>
    updateJob('check', { done: p.done, total: p.total }, { label: 'Checking for damage', long: true, cancel: () => api.cancelTask('check').catch(() => {}), cancelLabel: 'Stop' }),
  );
  onEvent<{ Ok?: DamageReport; Err?: string }>('check-done', (r) => {
    const n = r.Ok?.damaged.length ?? 0;
    endJob('check', {
      failed: !r.Ok || n > 0,
      summary: !r.Ok ? 'The damage check stopped' : n ? `Damage check finished: ${many(n, 'damaged item')} found` : 'Damage check finished: no damage found',
    });
  });

  const byBytes = (p: ExportProgress) => ({ done: p.done, total: p.total, fraction: p.totalBytes ? p.bytes / p.totalBytes : undefined });
  onEvent<ExportProgress>('export-progress', (p) =>
    updateJob('export', byBytes(p), { label: 'Exporting', unit: 'files', long: true, cancel: () => api.cancelTask('export').catch(() => {}), cancelLabel: 'Stop' }),
  );
  onEvent<ExportDone>('export-done', (d) =>
    endJob('export', {
      failed: !!d.error,
      summary: d.error ? 'Export failed' : d.cancelled ? `Export stopped: ${many(d.exported, 'file')} written` : `Export finished: ${many(d.exported, 'file')}`,
    }),
  );

  onEvent<ExportProgress>('share-progress', (p) =>
    updateJob('share', byBytes(p), { label: 'Making encrypted archive', unit: 'files', long: true, cancel: () => api.cancelTask('share').catch(() => {}), cancelLabel: 'Stop' }),
  );
  onEvent<ShareDone>('share-done', (d) =>
    endJob('share', {
      failed: !!d.error,
      summary: d.error ? 'The encrypted archive was not made' : d.cancelled ? 'Encrypted archive cancelled' : `Encrypted archive ready: ${many(d.files, 'file')}`,
    }),
  );

  const tool = (task: 'convert' | 'animation', label: string) => {
    onEvent<VideoToolProgress>(`${task}-progress`, (p) =>
      updateJob(task, { done: p.done, total: p.total, fraction: p.fraction }, {
        label, long: true, cancel: () => api.cancelTask(task).catch(() => {}), cancelLabel: 'Stop',
      }),
    );
  };
  tool('convert', 'Converting');
  tool('animation', 'Making an animation');
  onEvent<ConvertDone>('convert-done', (d) =>
    endJob('convert', {
      failed: !!d.error,
      summary: d.error ? 'Conversion failed' : d.cancelled ? 'Conversion stopped' : `Conversion finished: ${many(d.converted, 'item')}`,
    }),
  );
  onEvent<AnimationDone>('animation-done', (d) =>
    endJob('animation', { failed: !!d.error, summary: d.error ? 'The animation was not made' : d.cancelled ? 'Animation cancelled' : 'Your animation is ready' }),
  );

  const storageLabel = (t: string) => (t === 'convert' ? 'Packing files' : t === 'reclaim' ? 'Reclaiming space' : 'Freeing space');
  onEvent<StorageProgress>('storage-progress', (p) => updateJob('storage', { done: p.done, total: p.total }, { label: storageLabel(p.task), long: true }));
  onEvent<StorageDone>('storage-done', (d) => endJob('storage', { failed: !d.ok, summary: d.ok ? `${storageLabel(d.task)}: done` : `${storageLabel(d.task)} stopped` }));

  // Real copies (Ctrl+C / Ctrl+V) report [done, total] and end when they're equal.
  let copyIdle: ReturnType<typeof setTimeout> | null = null;
  onEvent<[number, number]>('copy-progress', ([done, total]) => {
    updateJob('copy', { done, total }, { label: 'Copying', long: true });
    if (copyIdle) clearTimeout(copyIdle);
    if (done >= total) endJob('copy', { summary: `Copy finished: ${many(total, 'item')}` });
    else copyIdle = setTimeout(() => endJob('copy'), 120_000); // never stuck if the last tick was missed
  });
}

// ---- background loops (thumbnails, clips, faces, smart search, fingerprints) ----------------

export interface LoopJob {
  /** The loop found work: (re)counts what is left. */
  batch(): void;
  /** One item done. */
  step(): void;
  /** Nothing left (or the loop stopped). */
  idle(): void;
}

/**
 * Report a background loop. `left` counts what is still to do (a cheap
 * library query); the bar shows this session's work against that.
 */
export function loopJob(id: string, opts: { label: string; left: () => Promise<number>; long?: boolean; quiet?: boolean; cancel?: () => void; cancelLabel?: string; unit?: string; summary?: (n: number) => string }): LoopJob {
  let done = 0;
  let active = false;
  let counting = false;
  return {
    batch() {
      if (counting) return;
      counting = true;
      opts
        .left()
        .then((n) => {
          counting = false;
          if (n <= 0) return;
          if (!active) {
            active = true;
            done = 0;
            beginJob({ id, label: opts.label, long: !!opts.long, quiet: opts.quiet ?? !opts.long, cancel: opts.cancel, cancelLabel: opts.cancelLabel, unit: opts.unit ?? 'items', total: n });
          } else {
            updateJob(id, { total: done + n, done });
          }
        })
        .catch(() => (counting = false));
    },
    step() {
      if (!active) return;
      done += 1;
      const j = jobs.find((x) => x.id === id && !x.endedAt);
      updateJob(id, { done, total: Math.max(j?.total ?? 0, done) });
    },
    idle() {
      if (!active) return;
      active = false;
      endJob(id, { summary: opts.summary?.(done) });
    },
  };
}

// ---- browser preview: a few made-up jobs (open the preview with ?jobs) ----------------------

export function demoJobs() {
  const now = Date.now();
  const add = (j: Job) => (jobs = [...jobs, j]);
  add({ id: 'import-1', label: 'Importing', detail: 'Holiday 2024', done: 1240, total: 5000, unit: 'files', startedAt: now - 95_000, long: true, cancel: () => endJob('import-1') });
  add({ id: 'faces', label: 'Scanning faces', done: 312, total: 1980, unit: 'items', startedAt: now - 240_000, long: true, cancel: () => endJob('faces'), cancelLabel: 'Pause' });
  add({ id: 'thumbs', label: 'Making thumbnails', done: 86, total: 0, unit: 'made', startedAt: now - 20_000, long: false, quiet: true });
  emit();
  let k = 0;
  setInterval(() => {
    k += 1;
    for (const j of jobs) {
      if (j.endedAt) continue;
      if (j.id === 'import-1') j.done = Math.min(j.total, j.done + 37);
      if (j.id === 'faces') j.done = Math.min(j.total, j.done + 3);
      if (j.id === 'thumbs') j.done += 2;
    }
    if (k % 30 === 0) beginJob({ id: 'thumbs', label: 'Making thumbnails', unit: 'made', long: false, done: 1 });
    emit();
  }, 1000);
}
