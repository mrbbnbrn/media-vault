// Calm view: changes that come from background work (new thumbnails, face
// scans, analysis, an import finishing) wait while you are using the window
// — moving the mouse, scrolling, pressing keys or a button, a menu open — and
// are applied together once you have paused for a moment. What you do
// yourself (opening, moving, favouriting…) is never held back.
//
// stableOrder() keeps things where they were when such a change arrives, so
// nothing jumps or reorders under the mouse.

import { useMemo, useRef } from 'react';

/** How long you must pause before held-back changes are applied. */
export const QUIET_MS = 1500;

let lastInput = -Infinity;
let pressed = 0;
const holds = new Set<string>();
const queued = new Map<string, () => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Watchers of busy ↔ calm (the backend's own loops are told: bgpace.ts).
const busySubs = new Set<() => void>();
let wasBusy = false;
let busyTimer: ReturnType<typeof setTimeout> | null = null;
function checkBusy() {
  const b = pressed > 0 || holds.size > 0 || now() - lastInput < QUIET_MS;
  if (b !== wasBusy) {
    wasBusy = b;
    busySubs.forEach((f) => f());
  }
  if (b && !busyTimer) {
    busyTimer = setTimeout(() => {
      busyTimer = null;
      checkBusy();
    }, Math.max(50, waitLeft()));
  }
}
/** Called when the user becomes busy or calm again. */
export function onBusyChange(cb: () => void): () => void {
  start();
  busySubs.add(cb);
  return () => busySubs.delete(cb);
}

function onInput() {
  lastInput = now();
  if (!wasBusy) checkBusy();
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const opts = { capture: true, passive: true } as const;
  for (const ev of ['pointermove', 'wheel', 'keydown', 'touchmove'] as const) window.addEventListener(ev, onInput, opts);
  // Scrolling (a scrollbar dragged, a list scrolled by keys) also counts.
  document.addEventListener('scroll', onInput, opts);
  window.addEventListener('pointerdown', () => {
    pressed++;
    onInput();
    checkBusy();
  }, opts);
  const release = () => {
    pressed = 0;
    onInput();
  };
  window.addEventListener('pointerup', release, opts);
  window.addEventListener('pointercancel', release, opts);
  window.addEventListener('blur', () => {
    pressed = 0;
  });
  // Leaving the window: whatever waits can come now (nobody is pointing at anything).
  document.addEventListener('pointerleave', () => {
    lastInput = -Infinity;
    schedule();
  });
}

/** Is the user doing something right now (so background changes should wait)? */
export function userBusy(): boolean {
  start();
  return pressed > 0 || holds.size > 0 || now() - lastInput < QUIET_MS;
}

/** How long until the window counts as calm (0 = now). */
function waitLeft(): number {
  if (pressed > 0 || holds.size > 0) return 400;
  return Math.max(0, QUIET_MS - (now() - lastInput));
}

function flush() {
  timer = null;
  if (userBusy()) return schedule();
  const run = [...queued.values()];
  queued.clear();
  for (const f of run) {
    try {
      f();
    } catch (e) {
      console.error(e);
    }
  }
}

function schedule() {
  if (timer || !queued.size) return;
  timer = setTimeout(flush, Math.max(16, waitLeft()));
}

/**
 * Run `fn` once the user has paused (at once when they already have). Calls
 * with the same `key` while waiting replace each other: the last one runs, once.
 */
export function calmly(key: string, fn: () => void): void {
  start();
  queued.set(key, fn);
  if (!userBusy()) {
    // Still let a burst of background messages gather (one go instead of many).
    if (!timer) timer = setTimeout(flush, 120);
    return;
  }
  schedule();
}

/** Forget something waiting (e.g. the view changed and loaded anyway). */
export function dropCalm(key: string): void {
  queued.delete(key);
}

/** Something on screen asks for stillness (an open menu): changes wait until released. */
export function holdCalm(key: string, on: boolean): void {
  start();
  if (on) {
    holds.add(key);
    checkBusy();
  } else {
    holds.delete(key);
    if (!holds.size) {
      lastInput = Math.max(lastInput, now() - QUIET_MS + 300);
      schedule();
      checkBusy();
    }
  }
}

/** Tests: start over. */
export function resetCalm() {
  wasBusy = false;
  if (busyTimer) clearTimeout(busyTimer);
  busyTimer = null;
  lastInput = -Infinity;
  pressed = 0;
  holds.clear();
  queued.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Tests: pretend there was input just now. */
export function noteInputForTest() {
  lastInput = now();
}

// ---- keeping things where they are --------------------------------------------------------------

/**
 * A fresh list, but with the things that were already shown kept in the order they
 * had (`prev`); new ones keep their place in the fresh list. Unchanged entries keep
 * their old object, so what draws them needn't redraw.
 */
export function stableOrder<T>(prev: readonly T[], next: readonly T[], key: (x: T) => string | number, same?: (a: T, b: T) => boolean): T[] {
  if (!prev.length) return next as T[];
  const fresh = new Map<string | number, T>();
  for (const n of next) fresh.set(key(n), n);
  // The kept ones, in their old order.
  const keptOld = prev.filter((p) => fresh.has(key(p)));
  const keptSet = new Set(keptOld.map(key));
  let k = 0;
  const out: T[] = [];
  for (const n of next) {
    if (!keptSet.has(key(n))) {
      out.push(n);
      continue;
    }
    // This place belongs to a kept one: the next one in the old order.
    const old = keptOld[k++];
    const f = fresh.get(key(old))!;
    out.push(same && same(old, f) ? old : f);
  }
  return out;
}

/** The fresh list, reusing the old objects that didn't change (same order as `next`). */
export function reuseSame<T>(prev: readonly T[], next: readonly T[], key: (x: T) => string | number, same: (a: T, b: T) => boolean): T[] {
  if (!prev.length) return next as T[];
  const before = new Map<string | number, T>();
  for (const p of prev) before.set(key(p), p);
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const o = before.get(key(n));
    const keep = o !== undefined && same(o, n);
    if (!keep || prev[i] !== o) changed = true;
    return keep ? o! : n;
  });
  return changed ? out : (prev as T[]);
}

/** Shallow equality of plain objects (arrays compared by their items). */
export function shallowSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i] || shallowSame(v, y[i]))) continue;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && shallowSame(x, y)) continue;
    return false;
  }
  return true;
}

/**
 * `list` as computed now, except after a background change (`bg` true): then the
 * things already shown stay in the order they had (stableOrder). `reset` (the view,
 * the sort) starts over from the fresh order.
 */
export function useStableList<T>(list: T[], key: (x: T) => string | number, bg: boolean, reset: string): T[] {
  const prev = useRef<{ reset: string; out: T[] } | null>(null);
  const out = useMemo(() => {
    const p = prev.current;
    return bg && p && p.reset === reset ? stableOrder(p.out, list, key) : list;
  }, [list, reset]); // eslint-disable-line react-hooks/exhaustive-deps
  prev.current = { reset, out };
  return out;
}
