// The library's folder panel (left sidebar): its width, dragged on its right
// edge (Library.tsx). Narrower than SNAP_BELOW turns it into the compact
// sidebar (icons and folder pictures only, `sidebarRail`); dragging the
// compact one wider than that opens it again at the width dragged to.
// Saved per PC in the look settings (`sidebarWidth`, config.rs cleans it).

/** The usual width (and what a double-click on the edge goes back to). */
export const SIDE_DEFAULT = 260;
export const SIDE_MIN = 180;
export const SIDE_MAX = 560;
/** Dragged narrower than this: the compact sidebar. */
export const SIDE_SNAP = 150;
/** The compact sidebar's own width (styles/sidebar-extras.css). */
export const SIDE_RAIL = 72;
/** Room always left for the grid beside the panel. */
const MAIN_ROOM = 420;

/** The widest the panel may be in a window this wide. */
export function sideMax(windowW: number): number {
  const w = Number.isFinite(windowW) && windowW > 0 ? windowW : 1600;
  return Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(w - MAIN_ROOM)));
}

/** A saved (or typed) width made safe: whole pixels in range; anything odd = the usual width. */
export function cleanSideWidth(v: unknown, windowW = Number.POSITIVE_INFINITY): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : SIDE_DEFAULT;
  const hi = windowW === Number.POSITIVE_INFINITY ? SIDE_MAX : sideMax(windowW);
  return Math.min(hi, Math.max(SIDE_MIN, n));
}

/** Where a drag of the edge lands: the compact sidebar, or open at a width. */
export function sideDrag(raw: number, windowW: number): { rail: true } | { rail: false; width: number } {
  if (!Number.isFinite(raw) || raw < SIDE_SNAP) return { rail: true };
  return { rail: false, width: cleanSideWidth(raw, windowW) };
}

/** Arrow keys on the edge: a step narrower or wider from what is shown now. */
export function sideStep(rail: boolean, width: number, dir: -1 | 1, windowW: number): { rail: true } | { rail: false; width: number } {
  if (rail) return dir > 0 ? { rail: false, width: SIDE_MIN } : { rail: true };
  const next = width + dir * 20;
  // (One step down from the narrowest open width: the compact sidebar.)
  if (dir < 0 && width <= SIDE_MIN) return { rail: true };
  return { rail: false, width: cleanSideWidth(Math.max(SIDE_MIN, next), windowW) };
}
