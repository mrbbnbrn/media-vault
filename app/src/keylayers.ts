// Keys only go to what is on top.
//
// Everything that opens over something else — a dialog, a menu, the viewer
// over the library, the museum, the river, a face tool — is a layer here,
// newest on top. Screens ask `keysAreMine(id)` (or `noLayerOpen()` for the
// library underneath everything) before acting on a key, so a key pressed in a
// dialog never also does something in the screen below it.
//
// Dialogs and menus ("modal" layers) are kept apart even from screens that
// don't ask: one listener that runs before every other one
// - offers the key to the layer itself (Esc closes it, by default);
// - lets keys typed inside the layer reach what they were typed into, and stops
//   them there, so nothing behind sees them;
// - swallows keys pressed outside it (e.g. the focus was on the page), except
//   the app's own global keys.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

export interface LayerOptions {
  /** For the timing panel and debugging. */
  name: string;
  /** The layer's element (keys typed inside it belong to it). */
  el?: () => HTMLElement | null;
  /** Dialogs and menus: kept apart from everything behind (see above). */
  modal?: boolean;
  /**
   * Gets every key first while on top; return true when it was handled (it then
   * stops there). Modal layers without one close on Esc via `onClose`.
   */
  onKey?: (e: KeyboardEvent) => boolean | void;
  onClose?: () => void;
  /**
   * "Back" (the mouse's back button, from App): leave this layer. Defaults to
   * `onClose`. Layers with their own steps back (the museum's close look) say so here.
   */
  onBack?: () => void;
}

interface Layer extends LayerOptions {
  id: number;
}

let nextId = 1;
const stack: Layer[] = [];
const subs = new Set<() => void>();

const changed = () => subs.forEach((f) => f());

/** Open a layer; returns how to close it (safe to call twice). */
export function pushLayer(o: LayerOptions): { id: number; pop: () => void; update: (o: Partial<LayerOptions>) => void } {
  const layer: Layer = { ...o, id: nextId++ };
  stack.push(layer);
  changed();
  return {
    id: layer.id,
    pop: () => {
      const i = stack.indexOf(layer);
      if (i >= 0) {
        stack.splice(i, 1);
        changed();
      }
    },
    update: (p) => Object.assign(layer, p),
  };
}

export const topLayer = (): Layer | undefined => stack[stack.length - 1];

/** Nothing is open over the screens (the library may use keys). */
export const noLayerOpen = () => stack.length === 0;

/** Layer `id` is on top: its keys are its own. */
export const keysAreMine = (id: number) => topLayer()?.id === id;

/** Some layer with this name is open. */
export const layerOpen = (name: string) => stack.some((l) => l.name === name);

/** For tests and the timing panel. */
export const layerNames = () => stack.map((l) => l.name);

/** The screen's own back / forward when no layer is open (the library sets them). */
let screenNav: { back: () => void; forward: () => void } | null = null;
export function setScreenNav(n: typeof screenNav) {
  screenNav = n;
}
/** Back or forward on the screen itself (no layer open): true when a screen took it. */
export function screenStep(dir: 'back' | 'forward'): boolean {
  if (!screenNav) return false;
  screenNav[dir]();
  return true;
}

/**
 * "Back" from the mouse button (App): the top layer's step back, or its close.
 * False when there is no layer (the screen's own back applies).
 */
export function backTopLayer(): boolean {
  const top = topLayer();
  if (!top) return false;
  (top.onBack ?? top.onClose)?.();
  return true;
}

export function onLayersChange(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Keys that work wherever you are (lock, save, timing panel, interface size). */
export function globalKey(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey && (e.code === 'KeyL' || e.code === 'KeyT')) return true;
  if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') return true;
  if (ctrl && ['+', '=', '-', '0', '*'].includes(e.key)) return true;
  if (e.key === 'F11' || e.key === 'Alt' || (e.altKey && e.key === 'F4')) return true;
  return false;
}

/** Tests: start over. */
export function resetLayers() {
  stack.length = 0;
  changed();
}

// ---- the guard (runs before every other key listener) --------------------------------------------

const OWNED = Symbol('mv-layer');
type Marked = KeyboardEvent & { [OWNED]?: number };

function capture(e: KeyboardEvent) {
  const top = topLayer();
  if (!top) return;
  if (e.type === 'keyup') {
    // Key releases only go where the press could go (nobody behind a dialog or menu).
    if (!top.modal) return;
    const el = top.el?.();
    if (el && e.target instanceof Node && el.contains(e.target)) (e as Marked)[OWNED] = top.id;
    else if (!globalKey(e)) e.stopImmediatePropagation();
    return;
  }
  // The layer itself first (also non-modal ones that asked for it).
  if (top.onKey) {
    if (top.onKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
  } else if (top.modal && e.key === 'Escape' && top.onClose) {
    e.preventDefault();
    e.stopImmediatePropagation();
    top.onClose();
    return;
  }
  if (!top.modal) return;
  const el = top.el?.();
  const target = e.target as Node | null;
  if (el && target && el.contains(target)) {
    // Typed inside the dialog or menu: it gets it, nothing behind does (see below).
    (e as Marked)[OWNED] = top.id;
    return;
  }
  if (globalKey(e)) return;
  // Outside the dialog (the page had the focus): nobody gets it.
  e.stopImmediatePropagation();
  if (e.key === 'Tab' && el) {
    // Tab brings the focus back into the dialog.
    e.preventDefault();
    el.querySelector<HTMLElement>('input, select, textarea, button, [tabindex]')?.focus();
  }
}

/** After the dialog's own handlers ran: keys typed in it go no further. */
function afterOwner(e: KeyboardEvent) {
  if ((e as Marked)[OWNED] != null) e.stopImmediatePropagation();
}

let installed = false;
/** Called once at start (main.tsx), before any other key listener exists. */
export function installKeyGuard() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  for (const t of ['keydown', 'keyup'] as const) {
    window.addEventListener(t, capture, true);
    // Bubbling: document comes after the page (and React's own handlers), before window.
    document.addEventListener(t, afterOwner);
  }
}

// ---- for components ----------------------------------------------------------------------------

export interface LayerHandle {
  /** The layer's id (0 while not active). */
  id: number;
  /** This layer is on top: keys are its own (read at the time of the key). */
  mine: () => boolean;
}

/**
 * Be a layer while `active` (mounted and shown). The options are read fresh on
 * every key, so handlers may change between renders. Key listeners of the layer
 * check `mine()` first: a layer opened over it (a dialog, the viewer) gets the keys.
 */
export function useLayer(active: boolean, o: LayerOptions): LayerHandle {
  const opts = useRef(o);
  opts.current = o;
  const idRef = useRef(0);
  const [id, setId] = useState(0);
  useEffect(() => {
    if (!active) return;
    const l = pushLayer({
      name: opts.current.name,
      modal: opts.current.modal,
      el: () => opts.current.el?.() ?? null,
      onKey: opts.current.onKey ? (e) => opts.current.onKey?.(e) : undefined,
      onClose: () => opts.current.onClose?.(),
      onBack: opts.current.onBack || opts.current.onClose ? () => (opts.current.onBack ?? opts.current.onClose)?.() : undefined,
    });
    idRef.current = l.id;
    setId(l.id);
    return () => {
      l.pop();
      idRef.current = 0;
      setId(0);
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = useRef(() => idRef.current !== 0 && keysAreMine(idRef.current)).current;
  return useMemo(() => ({ id, mine }), [id, mine]);
}

/** Re-render when layers open or close (e.g. to know whether the library may use keys). */
export function useNoLayerOpen(): boolean {
  return useSyncExternalStore(onLayersChange, noLayerOpen);
}
