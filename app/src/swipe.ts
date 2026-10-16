// Going to the previous / next item with the mouse in the viewer: dragging
// sideways on the empty space around the picture (or anywhere in the wide edge
// zones at the far left and right), and a plain click in an edge zone. The
// small sums, kept apart so they can be tested (Player.tsx uses them).

export type Side = 'prev' | 'next';

/** Width of each edge zone: about 12% of the viewer, at least 80 px (never more than a third). */
export function edgeZoneWidth(stageW: number): number {
  return Math.min(stageW / 3, Math.max(80, stageW * 0.12));
}

/** Which edge zone x (from the stage's left) is in, if any. */
export function edgeZoneAt(x: number, stageW: number): Side | null {
  if (!(stageW > 0)) return null;
  const z = edgeZoneWidth(stageW);
  if (x <= z) return 'prev';
  if (x >= stageW - z) return 'next';
  return null;
}

/** Whether (x, y) is on the picture itself (its drawn box on the stage). */
export function onPicture(x: number, y: number, drawn: { left: number; top: number; width: number; height: number } | null): boolean {
  return !!drawn && x >= drawn.left && x <= drawn.left + drawn.width && y >= drawn.top && y <= drawn.top + drawn.height;
}

/** Movement (px) before a press counts as a drag rather than a click. */
export const DRAG_START = 8;

/** A drag has started, and it is a sideways one. */
export function isSideways(dx: number, dy: number): boolean {
  return Math.abs(dx) >= DRAG_START && Math.abs(dx) > Math.abs(dy) * 1.2;
}

/** How far the item follows the mouse: a bit (60%), and only a little past the last item. */
export function followPx(dx: number, canGo: boolean): number {
  const f = dx * 0.6;
  return canGo ? f : Math.sign(f) * Math.min(40, Math.abs(f) * 0.25);
}

/**
 * Where a drag ends up when the mouse is let go: a long enough drag (or a
 * quick flick) moves on — dragging to the left shows the next item, to the
 * right the previous one; a short drag springs back ("cancel").
 */
export function swipeEnd(dx: number, dy: number, ms: number, stageW: number): Side | 'back' {
  const far = Math.abs(dx) >= Math.max(60, stageW * 0.15);
  const flick = Math.abs(dx) >= 30 && Math.abs(dx) / Math.max(1, ms) > 0.6;
  if (Math.abs(dx) <= Math.abs(dy) || !(far || flick)) return 'back';
  return dx < 0 ? 'next' : 'prev';
}
