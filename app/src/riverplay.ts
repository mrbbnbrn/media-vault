// Which drifting river cards play what, and the faces river's choices.
// Pure rules, so they can be tested; the drawing is components/river/engine.ts.
//
// Videos in the two nearest depths play their tiny silent clip, and the real
// video while the PC keeps up (the same budget rule as the grid previews,
// previewplan.ts); further depths show the flip-book (frames from the frame
// strip, cheap). The hovered or held card plays the real video. Only so many
// cards get a player at once, so a crowded river stays light.

import { chooseLayers, type Layer, type TileWant } from './previewplan';

export interface RiverCardWant {
  key: number;
  kind: 'image' | 'gif' | 'video' | 'face';
  layer: number;
  hasTiny: boolean;
  hasStrip: boolean;
  /** Under the mouse or held. */
  hovered: boolean;
  /** Frozen in place (frozen cards sit in the front row). */
  frozen: boolean;
  /** Some of it is on screen (cards wait just outside before they float in). */
  onScreen: boolean;
  /** Distance from the middle of the screen (px): nearer the middle gets a player first. */
  away: number;
}

/** Most cards with a video player at once (tiny clip or real video). */
export const MAX_RIVER_PLAYERS = 12;

/** Is this card in one of the two nearest depths (or as good as: frozen, hovered)? */
export const nearDepth = (c: Pick<RiverCardWant, 'layer' | 'frozen' | 'hovered'>, nearest: number) => c.hovered || c.frozen || c.layer >= nearest - 1;

/**
 * What every video card shows: 'real' or 'tiny' (a player), 'flip' (the
 * flip-book) or 'thumb' (just the picture). Pictures, GIFs and faces are left out.
 */
export function riverPreviews(cards: RiverCardWant[], nearest: number, budget: number, maxPlayers = MAX_RIVER_PLAYERS): Map<number, Layer> {
  const out = new Map<number, Layer>();
  const flipOrThumb = (c: RiverCardWant): Layer => (c.hasStrip ? 'flip' : 'thumb');
  const near: RiverCardWant[] = [];
  for (const c of cards) {
    if (c.kind !== 'video') continue;
    if (c.hovered || (c.onScreen && nearDepth(c, nearest))) near.push(c);
    else out.set(c.key, flipOrThumb(c));
  }
  // The hovered card first, then nearer depths, then nearer the middle.
  near.sort((a, b) => Number(b.hovered) - Number(a.hovered) || Number(b.frozen) - Number(a.frozen) || b.layer - a.layer || a.away - b.away);
  const playing = near.slice(0, Math.max(0, maxPlayers));
  for (const c of near.slice(playing.length)) out.set(c.key, flipOrThumb(c));
  const tiles: TileWant[] = playing.map((c, i) => ({ id: c.key, hasTiny: c.hasTiny, hasStrip: c.hasStrip, hovered: c.hovered, rank: i }));
  for (const [key, l] of chooseLayers(tiles, budget, 'auto')) out.set(key, l);
  return out;
}

// ---- the faces river ---------------------------------------------------------------------------

export type RiverMode = 'pictures' | 'faces';

export interface RiverFace {
  id: number;
  media: number;
  person: number;
  x: number;
  y: number;
  w: number;
  h: number;
  frameMs: number;
  /** The face's height in the original picture (px), when the picture's size is known. */
  px: number | null;
  /** The picture's width / height, when known. */
  aspect: number | null;
}

/** The "Smallest face" slider's range (px tall in the original picture). */
export const FACE_MIN_MAX = 600;

/** Faces at least `min` px tall (faces of unknown size always count: nothing to judge them by). */
export function bigEnough(faces: RiverFace[], min: number): RiverFace[] {
  if (min <= 0) return faces;
  return faces.filter((f) => f.px == null || f.px >= min);
}

/** "312 of 1,040 faces". */
export function faceCountText(shown: number, total: number): string {
  const n = (v: number) => v.toLocaleString('en-US');
  if (shown === total) return `${n(total)} ${total === 1 ? 'face' : 'faces'}`;
  return `${n(shown)} of ${n(total)} faces`;
}

/** The people picker's label: "Everyone", one name, or "Ann + 2". */
export function peopleText(chosen: number[], names: Map<number, string>): string {
  const known = chosen.filter((id) => names.has(id));
  if (!known.length) return 'Everyone';
  const first = names.get(known[0])!;
  return known.length === 1 ? first : `${first} + ${known.length - 1}`;
}
