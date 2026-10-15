// Folder banner sums (components/FolderBanner.tsx), kept apart so they can be tested.

import type { Item } from './api';

/** How far (px) the picture reaches past the banner top to bottom when it
 *  fills the banner's width and height: the room there is to move it. */
export function bannerSpan(natural: { w: number; h: number } | null, w: number, h: number): number {
  if (!natural || natural.w <= 0 || natural.h <= 0 || w <= 0 || h <= 0) return 0;
  const scale = Math.max(w / natural.w, h / natural.h);
  return Math.max(0, natural.h * scale - h);
}

/** The new focus after dragging `dy` px (down shows more of the top). */
export function dragFocus(from: number, dy: number, span: number): number {
  if (span < 1) return from;
  return Math.min(1, Math.max(0, from - dy / span));
}

const wideness = (it: Item) => {
  const r = it.width && it.height ? it.width / it.height : 1;
  return r >= 1.5 ? 0 : r >= 1.1 ? 1 : 2;
};

/** What can be a banner (pictures, GIFs, videos), wide ones first, otherwise in the order given. */
export function bannerRank(items: Item[]): Item[] {
  return items
    .filter((it) => it.kind === 'image' || it.kind === 'gif' || it.kind === 'video')
    .map((it, i) => ({ it, i, w: wideness(it) }))
    .sort((a, b) => a.w - b.w || a.i - b.i)
    .map((x) => x.it);
}
