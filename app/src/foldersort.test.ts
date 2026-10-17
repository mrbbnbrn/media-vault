import { describe, expect, it } from 'vitest';
import { markOpened, placeIds, sortFolders, sortPinned, sortTree, type SortableFolder } from './foldersort';

const f = (id: number, name: string, parentId: number | null, extra: Partial<SortableFolder> = {}): SortableFolder => ({
  id, name, parentId, items: 0, createdAt: id * 100, bytes: 0, ...extra,
});

describe('folder sorting', () => {
  it('sorts names naturally and ignores case, Turkish letters included', () => {
    const list = [f(1, 'Ödev 10', null), f(2, 'ödev 2', null), f(3, 'Zeynep', null), f(4, 'ışık', null), f(5, 'apple', null), f(6, 'Banana', null)];
    expect(sortFolders(list, 'nameAsc').map((x) => x.name)).toEqual(['apple', 'Banana', 'ışık', 'ödev 2', 'Ödev 10', 'Zeynep']);
    expect(sortFolders(list, 'nameDesc').map((x) => x.name)).toEqual(['Zeynep', 'Ödev 10', 'ödev 2', 'ışık', 'Banana', 'apple']);
  });

  it('sorts by date, items, size and when opened', () => {
    const list = [f(1, 'a', null, { items: 5, bytes: 10 }), f(2, 'b', null, { items: 9, bytes: 5 }), f(3, 'c', null, { items: 5, bytes: 99 })];
    expect(sortFolders(list, 'newest').map((x) => x.id)).toEqual([3, 2, 1]);
    expect(sortFolders(list, 'oldest').map((x) => x.id)).toEqual([1, 2, 3]);
    expect(sortFolders(list, 'items').map((x) => x.id)).toEqual([2, 1, 3]);
    expect(sortFolders(list, 'size').map((x) => x.id)).toEqual([3, 1, 2]);
    // Never-opened folders go last, by name.
    expect(sortFolders(list, 'opened', { 3: 50, 2: 70 }).map((x) => x.id)).toEqual([2, 3, 1]);
  });

  it('keeps your own order as given', () => {
    const list = [f(3, 'c', null), f(1, 'a', null), f(2, 'b', null)];
    expect(sortFolders(list, 'own').map((x) => x.id)).toEqual([3, 1, 2]);
  });

  it('sorts every level of the tree the same way, keeping children under their parent', () => {
    // Own order (tree order): B, B/z, B/a, A, A/y, A/x
    const tree = [f(1, 'B', null), f(2, 'z', 1), f(3, 'a', 1), f(4, 'A', null), f(5, 'y', 4), f(6, 'x', 4)];
    expect(sortTree(tree, 'own').map((x) => x.name)).toEqual(['B', 'z', 'a', 'A', 'y', 'x']);
    expect(sortTree(tree, 'nameAsc').map((x) => x.name)).toEqual(['A', 'x', 'y', 'B', 'a', 'z']);
    // An orphan (parent gone) counts as top level.
    expect(sortTree([f(7, 'orphan', 99), ...tree], 'nameAsc').map((x) => x.name)).toEqual(['A', 'x', 'y', 'B', 'a', 'z', 'orphan']);
  });

  it('orders pinned folders by your pin order, or like the tree', () => {
    const pins = [f(1, 'b', null), f(2, 'a', 9), f(3, 'c', null)];
    expect(sortPinned(pins, 'own', [3, 1]).map((x) => x.id)).toEqual([3, 1, 2]);
    expect(sortPinned(pins, 'nameAsc', [3, 1]).map((x) => x.id)).toEqual([2, 1, 3]);
  });

  it('places dragged ids before or after a target', () => {
    expect(placeIds([1, 2, 3, 4], [4], 2, 'before')).toEqual([1, 4, 2, 3]);
    expect(placeIds([1, 2, 3, 4], [1, 2], 4, 'after')).toEqual([3, 4, 1, 2]);
    expect(placeIds([1, 2, 3], [9], 3, 'before')).toEqual([1, 2, 9, 3]);
    expect(placeIds([1, 2, 3], [2], 2, 'after')).toEqual([1, 2, 3]);
    expect(placeIds([1, 2], [3], 7, 'after')).toEqual([1, 2, 3]);
  });

  it('remembers when folders were opened and forgets very old ones', () => {
    const day = 86_400_000;
    const now = 1000 * day;
    const o = markOpened({ 1: now - 500 * day, 2: now - day }, 3, now);
    expect(o).toEqual({ 2: now - day, 3: now });
  });
});

describe('newest / oldest go by the pictures inside', () => {
  it('sorts by the newest and oldest picture, empty folders last', () => {
    const f = (id: number, newest: number, oldest: number, createdAt = 100) => ({ id, name: `f${id}`, parentId: null, items: newest ? 1 : 0, createdAt, newest, oldest });
    const list = [f(1, 500, 10), f(2, 900, 300), f(3, 0, 0, 999), f(4, 700, 5)];
    expect(sortFolders(list, 'newest').map((x) => x.id)).toEqual([2, 4, 1, 3]);
    expect(sortFolders(list, 'oldest').map((x) => x.id)).toEqual([4, 1, 2, 3]);
  });
});

describe('steady order', () => {
  it('keeps the numbers taken when the sort was chosen; new folders use their own', async () => {
    const { updateSnap, sortSteady, sortTree: tree } = await import('./foldersort');
    const a = { id: 1, name: 'A', parentId: null, items: 5 };
    const b = { id: 2, name: 'B', parentId: null, items: 3 };
    let snap = updateSnap(null, 'items', [a, b], {});
    // B grows past A in the background: the order stays.
    const b2 = { ...b, items: 50 };
    const c = { id: 3, name: 'C', parentId: null, items: 4 };
    snap = updateSnap(snap, 'items', [a, b2, c], {});
    const out = sortSteady([a, b2, c], snap, (l, o) => tree(l, 'items', o));
    expect(out.map((f) => f.id)).toEqual([1, 3, 2]);
    expect(out[2]).toBe(b2);
    // Choosing the sort again (a new key) takes the numbers anew.
    snap = updateSnap(snap, 'items#2', [a, b2, c], {});
    expect(sortSteady([a, b2, c], snap, (l, o) => tree(l, 'items', o)).map((f) => f.id)).toEqual([2, 1, 3]);
  });
});
