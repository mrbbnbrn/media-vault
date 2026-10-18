// Where did the time go: a quiet record of how long things take on this PC.
// Shown by the timing panel (Ctrl+Shift+T, components/PerfPanel.tsx).
//
// Recorded (in memory only, never saved, cleared on lock):
// - steps: unlocking, opening a folder, its first thumbnails, opening a picture;
// - slow presses: clicks and keys that took long before the screen answered
//   (the browser's Event Timing API: input delay + work + drawing);
// - freezes: moments the window couldn't draw for 100 ms or more, with the
//   code that ran (Long Animation Frames, or long tasks on older engines);
// - backend calls: count, average and slowest per command;
// - backend messages per second, by name.
// Every entry notes which background jobs were running at that moment.


export type PerfKind = 'step' | 'press' | 'freeze' | 'call';

export interface PerfEntry {
  kind: PerfKind;
  name: string;
  ms: number;
  /** When it ended (Date.now()). */
  at: number;
  detail?: string;
  /** Background jobs running then (their labels). */
  jobs: string[];
}

export interface CallStat {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

const MAX = 400;
let entries: PerfEntry[] = [];
const calls = new Map<string, CallStat>();
/** Backend messages: name → arrival times of the last 10 s. */
const events = new Map<string, number[]>();
let version = 0;
const subs = new Set<() => void>();
let notifyQueued = false;

function changed() {
  version++;
  if (notifyQueued || !subs.size) return;
  notifyQueued = true;
  // At most a few times a second: the panel must not slow down what it measures.
  setTimeout(() => {
    notifyQueued = false;
    subs.forEach((s) => s());
  }, 250);
}

export function onPerfChange(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
export const perfVersion = () => version;

// The running background jobs come from jobs.ts (set by App, so this module imports nothing).
let jobSource: () => string[] = () => [];
export function setPerfJobs(f: () => string[]) {
  jobSource = f;
}
function runningJobs(): string[] {
  try {
    return jobSource();
  } catch {
    return [];
  }
}

export function record(kind: PerfKind, name: string, ms: number, detail?: string) {
  entries.push({ kind, name, ms: Math.round(ms), at: Date.now(), detail, jobs: runningJobs() });
  if (entries.length > MAX) entries = entries.slice(-MAX);
  changed();
}

export const perfEntries = () => entries;
export const callStats = () => [...calls.values()];

/** Messages from the backend per second, by name, over the last 10 s. */
export function eventRates(): { name: string; perSec: number }[] {
  const now = performance.now();
  const out: { name: string; perSec: number }[] = [];
  for (const [name, ts] of events) {
    const recent = ts.filter((t) => now - t < 10_000);
    events.set(name, recent);
    if (recent.length) out.push({ name, perSec: recent.length / 10 });
  }
  return out.sort((a, b) => b.perSec - a.perSec);
}

export function clearPerf() {
  entries = [];
  calls.clear();
  events.clear();
  pending.clear();
  changed();
}

// ---- steps --------------------------------------------------------------------------------

const pending = new Map<string, { t: number; detail?: string }>();

/** A step begins (a new begin of the same name replaces an unfinished one). */
export function beginStep(name: string, detail?: string) {
  pending.set(name, { t: performance.now(), detail });
}

/** The step ended: recorded with its time. Nothing happens if it never began. */
export function endStep(name: string, detail?: string) {
  const p = pending.get(name);
  if (!p) return;
  pending.delete(name);
  record('step', name, performance.now() - p.t, detail ?? p.detail);
}

/** Forget a step that won't finish (e.g. the folder changed again first). */
export function dropStep(name: string) {
  pending.delete(name);
}

export const stepRunning = (name: string) => pending.has(name);

/**
 * When the images now on screen inside `root` have loaded (or after 10 s):
 * "first thumbnails" of a folder.
 */
export function whenImagesShown(root: HTMLElement | null, done: () => void) {
  if (!root) return done();
  // After the next frame, so the grid has drawn its tiles.
  requestAnimationFrame(() => {
    const view = root.getBoundingClientRect();
    const imgs = [...root.querySelectorAll('img')].filter((im) => {
      const r = im.getBoundingClientRect();
      return r.bottom > view.top && r.top < view.bottom && r.width > 0;
    });
    const waiting = imgs.filter((im) => !im.complete);
    if (!waiting.length) return done();
    let left = waiting.length;
    let finished = false;
    const one = () => {
      if (--left <= 0 && !finished) {
        finished = true;
        done();
      }
    };
    for (const im of waiting) {
      im.addEventListener('load', one, { once: true });
      im.addEventListener('error', one, { once: true });
    }
    setTimeout(() => {
      if (!finished) {
        finished = true;
        done();
      }
    }, 10_000);
  });
}

// ---- backend calls and messages (api.ts) ---------------------------------------------------

/** Called by api.ts around every backend call. */
export function noteCall(name: string, ms: number) {
  let s = calls.get(name);
  if (!s) calls.set(name, (s = { name, count: 0, totalMs: 0, maxMs: 0 }));
  s.count++;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
  if (ms >= 150) record('call', name, ms);
  else if (subs.size) changed();
}

/** Called by api.ts for every message from the backend. */
export function noteEvent(name: string) {
  let ts = events.get(name);
  if (!ts) events.set(name, (ts = []));
  ts.push(performance.now());
  if (ts.length > 2000) ts.splice(0, ts.length - 2000);
}

// ---- presses and freezes (browser performance observers) ---------------------------------

/** A short name for what was pressed. */
export function describeTarget(el: Element | null | undefined): string {
  if (!el || !(el instanceof Element)) return '';
  const h = el.closest('button, a, [role=menuitem], [role=option], [data-item], [data-card], input, select, textarea, .side-row, .tile') ?? el;
  const label = h.getAttribute('aria-label') || h.getAttribute('title') || (h as HTMLElement).innerText || '';
  const what = h.hasAttribute('data-item') ? 'item tile' : h.hasAttribute('data-card') ? 'folder card' : h.tagName.toLowerCase();
  const text = label.replace(/\s+/g, ' ').trim().slice(0, 40);
  return text ? `${what} “${text}”` : what;
}

let observing = false;

export function startPerfObservers() {
  if (observing || typeof PerformanceObserver === 'undefined') return;
  observing = true;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  // Presses: from the moment of the click / key to the screen showing the answer.
  if (supported.includes('event')) {
    try {
      const seen = new Set<number>();
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          const id = (e as PerformanceEventTiming & { interactionId?: number }).interactionId ?? 0;
          if (!id || e.duration < 80) continue;
          // One press = several events (pointerdown, pointerup, click): keep the longest once.
          if (seen.has(id)) continue;
          seen.add(id);
          if (seen.size > 500) seen.clear();
          const delay = Math.round(e.processingStart - e.startTime);
          const work = Math.round(e.processingEnd - e.processingStart);
          record('press', e.name, e.duration, `${describeTarget(e.target as Element)} · waited ${delay} ms, ran ${work} ms, drew ${Math.max(0, Math.round(e.duration - delay - work))} ms`);
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 80 } as PerformanceObserverInit);
    } catch {
      // Not available in this engine.
    }
  }
  // Freezes, with the code that ran.
  if (supported.includes('long-animation-frame')) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < 100) continue;
          type Script = { invoker?: string; sourceFunctionName?: string; sourceURL?: string; duration: number };
          const scripts = ((e as unknown as { scripts?: Script[] }).scripts ?? []).slice().sort((a, b) => b.duration - a.duration);
          const top = scripts.slice(0, 2).map((s) => {
            const file = (s.sourceURL ?? '').split('/').pop()?.split('?')[0] ?? '';
            return `${s.sourceFunctionName || s.invoker || 'script'}${file ? ` (${file})` : ''} ${Math.round(s.duration)} ms`;
          });
          record('freeze', 'Window busy', e.duration, top.join(' · ') || undefined);
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch {
      // Not available.
    }
  } else if (supported.includes('longtask')) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration >= 100) record('freeze', 'Window busy', e.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // Not available.
    }
  }
}

// ---- the report (copied to the clipboard from the panel) -----------------------------------

export function perfReport(): string {
  const lines: string[] = [];
  const when = (t: number) => new Date(t).toLocaleTimeString();
  lines.push(`Media Vault timing report — ${new Date().toLocaleString()}`);
  lines.push(`Screen ${screen.width}×${screen.height} @${devicePixelRatio}x, ${navigator.hardwareConcurrency} cores`);
  lines.push(`Drawing with: ${graphicsName()}`);
  const group = (k: PerfKind, title: string) => {
    const list = entries.filter((e) => e.kind === k);
    if (!list.length) return;
    lines.push('', `## ${title}`);
    for (const e of list.slice(-60)) {
      lines.push(`${when(e.at)}  ${String(e.ms).padStart(6)} ms  ${e.name}${e.detail ? ` — ${e.detail}` : ''}${e.jobs.length ? `  [running: ${e.jobs.join(', ')}]` : ''}`);
    }
  };
  group('step', 'Steps');
  group('press', 'Slow presses (≥ 80 ms)');
  group('freeze', 'Freezes (≥ 100 ms)');
  group('call', 'Slow backend calls (≥ 150 ms)');
  const cs = callStats().sort((a, b) => b.totalMs - a.totalMs).slice(0, 25);
  if (cs.length) {
    lines.push('', '## Backend calls (most total time first)');
    for (const c of cs) lines.push(`${c.name}: ${c.count}×, avg ${Math.round(c.totalMs / c.count)} ms, max ${Math.round(c.maxMs)} ms`);
  }
  const ev = eventRates();
  if (ev.length) {
    lines.push('', '## Backend messages per second (last 10 s)');
    for (const e of ev) lines.push(`${e.name}: ${e.perSec.toFixed(1)}/s`);
  }
  return lines.join('\n');
}

/** Which graphics the window draws with (a software fallback would make 3D slow). */
function graphicsName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return 'unknown';
  }
}

// ---- the 3D models' runs (the backend's log: gpuroom.rs) --------------------------------------------

export interface ModelRun {
  kind: string;
  model: string;
  device: 'gpu' | 'cpu';
  waitMs: number;
  loadMs: number;
  runMs: number;
  note: string;
  at: number;
  /** The app's use of the graphics card's memory after the run, and what Windows lets it use (MB). */
  cardUsedMb?: number | null;
  cardBudgetMb?: number | null;
}
const gb = (mb: number) => (mb / 1024).toFixed(1);
let modelLog: () => Promise<ModelRun[]> = async () => [];
/** Set by App (perf.ts imports nothing). */
export function setModelLogSource(f: () => Promise<ModelRun[]>) {
  modelLog = f;
}

/** The report with the 3D models' last runs added (on which device, waiting, loading, running). */
export async function fullReport(): Promise<string> {
  const base = perfReport();
  const runs = await modelLog().catch(() => [] as ModelRun[]);
  if (!runs.length) return base;
  const lines = ['', '## 3D model runs (device · waited · loaded · ran)'];
  for (const r of runs) {
    if (r.kind === 'window') {
      const card = r.cardUsedMb != null && r.cardBudgetMb ? ` · card memory ${gb(r.cardUsedMb)} of ${gb(r.cardBudgetMb)} GB` : '';
      lines.push(`${new Date(r.at).toLocaleTimeString()}  THE WINDOW FAILED: ${r.model}${card}${r.note ? ` · ${r.note}` : ''}`);
      continue;
    }
    const card = r.cardUsedMb != null && r.cardBudgetMb ? ` · card memory ${gb(r.cardUsedMb)} of ${gb(r.cardBudgetMb)} GB` : '';
    lines.push(`${new Date(r.at).toLocaleTimeString()}  ${r.kind} ${r.model} on ${r.device === 'gpu' ? 'graphics card' : 'PROCESSOR'} · waited ${Math.round(r.waitMs)} ms · loaded ${Math.round(r.loadMs)} ms · ran ${Math.round(r.runMs)} ms${card}${r.note ? ` · ${r.note}` : ''}`);
  }
  return base + '\n' + lines.join('\n');
}
