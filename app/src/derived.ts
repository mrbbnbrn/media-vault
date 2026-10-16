// Saved depth maps and outlines (pictures only, never GIFs or videos): once
// a depth map or a subject outline has been worked out for a picture in the
// vault it is saved there (encrypted, like everything else), so it never has
// to be worked out again; before working one out, the saved one is tried.
// Each is saved for one model (and size), so maps from different models
// never mix. Settings → Faces & smart search shows how many there are, and
// can clear them or work them all out again (prepare.ts).
//
// Which pictures can be saved: those the viewer was given as vault items
// (their address is mediaUrl(id)); depth.ts and subject.ts ask here.

import { api, mapBytes, mediaUrl, onLocked, parseDepth, type DepthMap, type DerivedKind } from './api';

const ids = new Map<string, number>();

/** These are the items being shown: the still pictures among them (vault items) can have saved maps. */
export function notePictures(items: { kind: string; src: string; itemId?: number | null }[]) {
  for (const it of items) if (it.kind === 'image' && it.itemId != null && it.src === mediaUrl(it.itemId)) ids.set(it.src, it.itemId);
}

/** The vault item a picture's address belongs to (null: not a still picture in the vault, so nothing is saved). */
export function savedId(src: string): number | null {
  return ids.get(src) ?? null;
}

void onLocked(() => ids.clear()).catch(() => {});

const subs = new Set<() => void>();
/** Something was saved (Settings refreshes its count). */
export function onSavedChange(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** The saved map of this picture for this model (null when none is saved, or it can't be read). */
export async function loadSaved(kind: DerivedKind, model: string, id: number): Promise<DepthMap | null> {
  try {
    const b = await api.derivedGet(id, kind, model);
    return b ? parseDepth(b) : null;
  } catch {
    return null;
  }
}

/** Saves a map just worked out (in the background; a failure only means it's worked out again next time). */
export function putSaved(kind: DerivedKind, model: string, id: number, m: DepthMap) {
  void api.derivedPut(id, kind, model, mapBytes(m)).then(() => subs.forEach((f) => f())).catch((e) => console.warn(`Couldn't save the ${kind} map:`, e));
}

/**
 * Works out a map with `compute`, trying the saved one first and saving a new
 * one (for still pictures in the vault; anything else is just worked out).
 */
export async function savedOr(kind: DerivedKind, model: string, src: string, compute: () => Promise<DepthMap | null>): Promise<DepthMap | null> {
  const id = savedId(src);
  if (id == null) return compute();
  const got = await loadSaved(kind, model, id);
  if (got) return got;
  const m = await compute();
  if (m) putSaved(kind, model, id, m);
  return m;
}
