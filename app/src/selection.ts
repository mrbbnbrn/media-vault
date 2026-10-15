// One rule for what is selected, whatever did it: a click, Ctrl / Shift +
// click, the arrow keys (+ Shift), the rubber band, Ctrl+A, Escape, and coming
// back from the viewer. The grid draws exactly this set (ring + tick) and
// nothing else; the keyboard cursor is always the last item picked, so it is
// never drawn on its own.

export interface Mods {
  ctrl?: boolean;
  shift?: boolean;
}

export interface Picked {
  selected: Set<number>;
  /** Where the next Shift + click / Shift + arrow range starts. */
  anchor: number | null;
  /** The item the arrow keys move from next. */
  cursor: number | null;
  /** Ctrl or Shift was held: other selected things (folders) stay selected. */
  additive: boolean;
}

/** The ids between two positions in `order` (inclusive), or null if either is missing. */
export function rangeOf(order: readonly number[], a: number, b: number): number[] | null {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return null;
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return order.slice(lo, hi + 1);
}

/**
 * A click on `id`. Plain: just that one. Ctrl: add or remove it. Shift: the
 * range from the anchor (Ctrl + Shift adds the range to what was selected).
 */
export function clickPick(order: readonly number[], selected: ReadonlySet<number>, anchor: number | null, id: number, m: Mods): Picked {
  if (m.shift && anchor != null) {
    const r = rangeOf(order, anchor, id);
    if (r) {
      const sel = new Set(m.ctrl ? selected : []);
      r.forEach((x) => sel.add(x));
      return { selected: sel, anchor, cursor: id, additive: true };
    }
  }
  if (m.ctrl) {
    const sel = new Set(selected);
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    return { selected: sel, anchor: id, cursor: id, additive: true };
  }
  return { selected: new Set([id]), anchor: id, cursor: id, additive: false };
}

/**
 * The arrow keys moved to `id`. Plain: just that one (and it becomes the
 * anchor). Shift: the range from the anchor to it.
 */
export function movePick(order: readonly number[], anchor: number | null, id: number, shift: boolean): Picked {
  if (shift && anchor != null) {
    const r = rangeOf(order, anchor, id);
    if (r) return { selected: new Set(r), anchor, cursor: id, additive: true };
  }
  return { selected: new Set([id]), anchor: id, cursor: id, additive: false };
}

/** Where the arrow keys start: the cursor if it is still selected, else the first selected item in order, else nothing. */
export function moveFrom(order: readonly number[], selected: ReadonlySet<number>, cursor: number | null): number {
  if (cursor != null && selected.has(cursor)) {
    const i = order.indexOf(cursor);
    if (i >= 0) return i;
  }
  if (!selected.size) return -1;
  return order.findIndex((x) => selected.has(x));
}

/**
 * Back from the viewer, which showed `last` (opened on `opened`). If you came
 * back to the item you opened and it is still selected, the selection stays as
 * it was; otherwise the item you were looking at becomes the selection.
 */
export function returnPick(selected: ReadonlySet<number>, opened: number | null, last: number | null): Picked | null {
  if (last == null) return null;
  if (last === opened && selected.has(last)) return null;
  return { selected: new Set([last]), anchor: last, cursor: last, additive: false };
}

/** Rubber band: what was selected before (when Ctrl / Shift was held) plus what the box touches. */
export function bandPick(before: ReadonlySet<number>, hit: Iterable<number>, additive: boolean): Set<number> {
  const sel = new Set(additive ? before : []);
  for (const x of hit) sel.add(x);
  return sel;
}

/** Folders: the same click rule, on the list they are shown in (sidebar order or card order). */
export function folderPick(order: readonly number[], selected: ReadonlySet<number>, anchor: number | null, id: number, m: Mods): { selected: Set<number>; anchor: number | null; additive: boolean } {
  const p = clickPick(order, selected, anchor ?? id, id, m);
  return { selected: p.selected, anchor: p.anchor, additive: p.additive };
}

/**
 * Which ids are in a set, for many small subscribers (one per grid tile).
 * Setting a new set tells only the ids whose membership changed, so a click
 * redraws the two tiles involved, not every tile on screen.
 */
export class MemberStore {
  private cur: ReadonlySet<number> = new Set();
  private subs = new Map<number, Set<() => void>>();

  has(id: number): boolean {
    return this.cur.has(id);
  }

  /** Replace the set; returns how many watched ids changed (for tests). */
  set(next: ReadonlySet<number>): number {
    const prev = this.cur;
    if (prev === next) return 0;
    this.cur = next;
    const changed: (() => void)[] = [];
    const note = (id: number) => {
      const s = this.subs.get(id);
      if (s) changed.push(...s);
    };
    for (const id of prev) if (!next.has(id)) note(id);
    for (const id of next) if (!prev.has(id)) note(id);
    for (const f of changed) f();
    return changed.length;
  }

  subscribe(id: number, f: () => void): () => void {
    let s = this.subs.get(id);
    if (!s) this.subs.set(id, (s = new Set()));
    s.add(f);
    return () => {
      s.delete(f);
      if (!s.size && this.subs.get(id) === s) this.subs.delete(id);
    };
  }
}
