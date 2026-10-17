// A thumbnail that loads again only when its own thumbnail changed (thumbver.ts),
// and a counter for the living folder card's cycle that only the hovered card
// listens to (the rest of the library doesn't redraw every 0.9 s).

import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { api, thumbUrl } from '../api';
import { useThumbVersion, verTag } from '../thumbver';

export function CoverImg(props: { id: number; small?: boolean; className?: string; style?: CSSProperties }) {
  const v = useThumbVersion(props.id);
  return <img className={props.className} style={props.style} src={thumbUrl(props.id, verTag(v), props.small)} alt="" draggable={false} />;
}

/** 0 when not hovered; then 1, 2, 3… every `ms` while hovered. */
export function useHoverCycle(hovered: boolean, ms = 900): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!hovered) return;
    const iv = setInterval(() => setN((c) => c + 1), ms);
    return () => clearInterval(iv);
  }, [hovered, ms]);
  return hovered ? n : 0;
}

// ---- the hovered folder card (only that card draws again, not the whole library) ----------------

let hovered: number | null = null;
const hoverSubs = new Set<() => void>();
export function setHoveredCard(id: number | null) {
  if (hovered === id) return;
  hovered = id;
  hoverSubs.forEach((f) => f());
}
/** Leave only if it is still this card (the pointer may already be on the next one). */
export function leaveCard(id: number) {
  if (hovered === id) setHoveredCard(null);
}
export function useCardHovered(id: number): boolean {
  return useSyncExternalStore(
    (cb) => {
      hoverSubs.add(cb);
      return () => hoverSubs.delete(cb);
    },
    () => hovered === id,
  );
}

/** A few pictures from inside a folder, asked for once it has been hovered a moment (kept). */
const sampleCache = new Map<number, number[]>();
export function useFolderSamples(id: number, hoveredNow: boolean): number[] | undefined {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!hoveredNow || sampleCache.has(id)) return;
    let live = true;
    const t = setTimeout(() => {
      api.folderSamples(id, 8).then((v) => {
        sampleCache.set(id, v);
        if (live) setN((n) => n + 1);
      }).catch(() => {});
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [id, hoveredNow]);
  return sampleCache.get(id);
}
/** The vault locked: forget them. */
export function clearFolderSamples() {
  sampleCache.clear();
}
