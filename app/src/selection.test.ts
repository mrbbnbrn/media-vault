import { describe, expect, it } from 'vitest';
import { bandPick, clickPick, folderPick, MemberStore, moveFrom, movePick, rangeOf, returnPick } from './selection';

const order = [10, 11, 12, 13, 14, 15];
const ids = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('selection', () => {
  it('ranges run either way and need both ends', () => {
    expect(rangeOf(order, 11, 13)).toEqual([11, 12, 13]);
    expect(rangeOf(order, 13, 11)).toEqual([11, 12, 13]);
    expect(rangeOf(order, 12, 12)).toEqual([12]);
    expect(rangeOf(order, 99, 12)).toBeNull();
  });

  it('a plain click selects just that one and moves anchor and cursor there', () => {
    const p = clickPick(order, new Set([10, 11, 12]), 10, 14, {});
    expect(ids(p.selected)).toEqual([14]);
    expect(p).toMatchObject({ anchor: 14, cursor: 14, additive: false });
  });

  it('Ctrl + click adds or removes one', () => {
    const add = clickPick(order, new Set([10]), 10, 13, { ctrl: true });
    expect(ids(add.selected)).toEqual([10, 13]);
    expect(add).toMatchObject({ anchor: 13, cursor: 13, additive: true });
    const remove = clickPick(order, new Set([10, 13]), 13, 10, { ctrl: true });
    expect(ids(remove.selected)).toEqual([13]);
  });

  it('Shift + click selects the range from the anchor; Ctrl + Shift adds it', () => {
    const p = clickPick(order, new Set([15]), 11, 13, { shift: true });
    expect(ids(p.selected)).toEqual([11, 12, 13]);
    expect(p).toMatchObject({ anchor: 11, cursor: 13, additive: true });
    const q = clickPick(order, new Set([15]), 11, 13, { shift: true, ctrl: true });
    expect(ids(q.selected)).toEqual([11, 12, 13, 15]);
  });

  it('Shift + click without an anchor (or a gone one) is a plain click', () => {
    expect(ids(clickPick(order, new Set(), null, 12, { shift: true }).selected)).toEqual([12]);
    expect(ids(clickPick(order, new Set(), 99, 12, { shift: true }).selected)).toEqual([12]);
  });

  it('arrow keys select the one moved to; Shift + arrows grow the range from the anchor', () => {
    const p = movePick(order, 10, 11, false);
    expect(ids(p.selected)).toEqual([11]);
    expect(p).toMatchObject({ anchor: 11, cursor: 11, additive: false });
    const q = movePick(order, 11, 14, true);
    expect(ids(q.selected)).toEqual([11, 12, 13, 14]);
    expect(q).toMatchObject({ anchor: 11, cursor: 14 });
    // Going back past the anchor flips the range.
    expect(ids(movePick(order, 12, 10, true).selected)).toEqual([10, 11, 12]);
  });

  it('arrow keys start at the cursor if it is selected, else at the first selected item', () => {
    expect(moveFrom(order, new Set([12, 14]), 14)).toBe(4);
    expect(moveFrom(order, new Set([14, 12]), 10)).toBe(2);
    expect(moveFrom(order, new Set(), 10)).toBe(-1);
  });

  it('back from the viewer: the item looked at becomes the selection, unless nothing changed', () => {
    expect(returnPick(new Set([12, 13]), 12, 12)).toBeNull();
    const moved = returnPick(new Set([12, 13]), 12, 15)!;
    expect(ids(moved.selected)).toEqual([15]);
    expect(moved).toMatchObject({ anchor: 15, cursor: 15 });
    // Opened with nothing selected (Enter on the cursor that was cleared): select it.
    expect(ids(returnPick(new Set(), 12, 12)!.selected)).toEqual([12]);
    expect(returnPick(new Set([1]), 12, null)).toBeNull();
  });

  it('rubber band: only what the box touches, plus the old selection with Ctrl / Shift', () => {
    expect(ids(bandPick(new Set([10]), [12, 13], false))).toEqual([12, 13]);
    expect(ids(bandPick(new Set([10]), [12, 13], true))).toEqual([10, 12, 13]);
  });

  it('folders follow the same rule', () => {
    const f = [1, 2, 3, 4];
    expect(ids(folderPick(f, new Set([1]), 1, 3, {}).selected)).toEqual([3]);
    expect(ids(folderPick(f, new Set([1]), 1, 3, { ctrl: true }).selected)).toEqual([1, 3]);
    expect(ids(folderPick(f, new Set([1]), 1, 3, { shift: true }).selected)).toEqual([1, 2, 3]);
    // No anchor yet: Shift + click starts from the folder clicked.
    expect(ids(folderPick(f, new Set(), null, 2, { shift: true }).selected)).toEqual([2]);
  });
});

describe('MemberStore', () => {
  it('tells only the ids whose membership changed', () => {
    const st = new MemberStore();
    const calls: number[] = [];
    const off = [1, 2, 3, 4].map((id) => st.subscribe(id, () => calls.push(id)));
    st.set(new Set([1, 2]));
    expect(calls.sort()).toEqual([1, 2]);
    calls.length = 0;
    st.set(new Set([2, 3]));
    expect(calls.sort()).toEqual([1, 3]);
    expect(st.has(2) && st.has(3) && !st.has(1)).toBe(true);
    calls.length = 0;
    // Ids nobody watches (off screen) cost nothing but are still answered.
    expect(st.set(new Set([2, 3, 99]))).toBe(0);
    expect(st.has(99)).toBe(true);
    off.forEach((f) => f());
    expect(st.set(new Set())).toBe(0);
    expect(calls).toEqual([]);
  });
});
