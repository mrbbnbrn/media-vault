// Colours of items for "Colour flow" (colour.ts): measured from a 16×16 copy
// of each thumbnail, decoded and read off the window's thread
// (picturecache.ts), a couple at a time. Kept in memory by item key, and the
// numbers (never the picture) in localStorage so the next time starts sorted.

import { measureColour, packColour, rainbowPos, unpackColour, type Colour } from './colour';
import { pixelsOffThread } from './picturecache';

const STORE = 'mv.colours.v1';
/** Most colours remembered on disk (each is ~30 bytes). */
const MAX_KEPT = 4000;
const AT_ONCE = 2;

const known = new Map<string, Colour>();
const failed = new Set<string>();
const listeners = new Set<() => void>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORE);
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(o)) {
      const c = unpackColour(v);
      if (c) known.set(k, c);
    }
  } catch {
    // nothing remembered
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // Only vault items (files on this PC have their path as key: not kept).
      const keys = [...known.keys()].filter((k) => /^v\d+$/.test(k)).slice(-MAX_KEPT);
      const o: Record<string, string> = {};
      for (const k of keys) o[k] = packColour(known.get(k)!);
      localStorage.setItem(STORE, JSON.stringify(o));
    } catch {
      // full or blocked: memory only
    }
  }, 1500);
}

let tellTimer: ReturnType<typeof setTimeout> | null = null;
function tell() {
  if (tellTimer) return;
  // Several colours in a row come as one change.
  tellTimer = setTimeout(() => {
    tellTimer = null;
    listeners.forEach((f) => f());
  }, 350);
}

/** The item's colour, when measured. */
export function colourOf(key: string): Colour | null {
  load();
  return known.get(key) ?? null;
}

/** The item's place on the rainbow (0 … 1), when measured. */
export function rainbowOf(key: string): number | null {
  const c = colourOf(key);
  return c ? rainbowPos(c) : null;
}

/** Called (a little later, once for a batch) when new colours are in. */
export function onColours(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export interface Measurable {
  key: string;
  kind: string;
  src: string;
  thumb: string | null;
}

/** What to read the colour from: the thumbnail; the picture itself only when asked (on screen). */
function sourceOf(i: Measurable, full: boolean): string | null {
  if (i.thumb) return i.thumb;
  if (full && (i.kind === 'image' || i.kind === 'gif')) return i.src;
  return null;
}

const queue: { item: Measurable; full: boolean }[] = [];
const queued = new Set<string>();
let running = 0;

/**
 * Measure these items' colours (those not known yet), `first` ones first.
 * Items on screen may be measured from the picture itself when they have no
 * thumbnail; the rest only from thumbnails.
 */
export function measureColours(onScreen: Measurable[], rest: Measurable[] = []) {
  load();
  const add = (i: Measurable, full: boolean, front: boolean) => {
    if (known.has(i.key) || failed.has(i.key) || queued.has(i.key) || !sourceOf(i, full)) return;
    queued.add(i.key);
    if (front) queue.unshift({ item: i, full });
    else queue.push({ item: i, full });
  };
  [...onScreen].reverse().forEach((i) => add(i, true, true));
  rest.slice(0, 600).forEach((i) => add(i, false, false));
  pump();
}

/** Forget what is waiting (the mode closed); what is known stays. */
export function stopMeasuring() {
  for (const q of queue) queued.delete(q.item.key);
  queue.length = 0;
}

function pump() {
  while (running < AT_ONCE && queue.length) {
    const { item, full } = queue.shift()!;
    const src = sourceOf(item, full);
    if (!src) {
      queued.delete(item.key);
      continue;
    }
    running++;
    pixelsOffThread(src, 16, 16)
      .then((px) => {
        const c = px ? measureColour(px.data) : null;
        if (c) {
          known.set(item.key, c);
          saveSoon();
          tell();
        } else failed.add(item.key);
      })
      .catch(() => failed.add(item.key))
      .finally(() => {
        running--;
        queued.delete(item.key);
        pump();
      });
  }
}
