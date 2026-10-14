import { describe, expect, it } from 'vitest';
import {
  activate, activeTab, closeOthers, closeTab, closeToRight, cycle, duplicateTab, goBack, goForward, initialTabs, jumpTo, moveTab, navigate, openTab,
  reopenClosed, replaceView, restoreTabs, serializeTabs, tabLook, type FolderName, type TabsState,
} from './tabs';
import type { LibView } from '../screens/Library';

const f = (id: number): LibView => ({ kind: 'folder', id });
const views = (s: TabsState) => s.tabs.map((t) => (t.view.kind === 'folder' ? t.view.id : t.view.kind));
const act = (s: TabsState) => {
  const v = activeTab(s).view;
  return v.kind === 'folder' ? v.id : v.kind;
};

describe('navigation per tab', () => {
  it('keeps its own back and forward', () => {
    let s = initialTabs();
    s = navigate(s, f(1));
    s = navigate(s, f(2));
    s = navigate(s, f(2)); // same view: nothing new
    expect(activeTab(s).back.length).toBe(2);
    s = openTab(s, f(9));
    expect(activeTab(s).back).toEqual([]);
    expect(goBack(s)).toBeNull();
    s = activate(s, s.tabs[0].id);
    s = goBack(s)!;
    expect(act(s)).toBe(1);
    s = goForward(s)!;
    expect(act(s)).toBe(2);
    expect(goForward(s)).toBeNull();
    s = goBack(s)!;
    s = navigate(s, f(3));
    expect(activeTab(s).fwd).toEqual([]); // a new step clears forward
    s = replaceView(s, f(4));
    expect(act(s)).toBe(4);
    expect(activeTab(s).back.length).toBe(2);
  });
});

describe('opening and closing', () => {
  it('background tabs line up after the opener, in order', () => {
    let s = openTab(initialTabs(), f(5)); // [home, 5*]
    s = activate(s, s.tabs[0].id); // [home*, 5]
    s = openTab(s, f(1), { background: true });
    s = openTab(s, f(2), { background: true });
    expect(views(s)).toEqual(['folders', 1, 2, 5]);
    expect(act(s)).toBe('folders');
    // Switching tabs ends the run: the next one goes right after the active tab.
    s = activate(s, s.tabs[3].id);
    s = activate(s, s.tabs[0].id);
    s = openTab(s, f(3), { background: true });
    expect(views(s)).toEqual(['folders', 3, 1, 2, 5]);
  });

  it('Ctrl+T opens at the end and switches to it', () => {
    let s = openTab(initialTabs(), f(1));
    s = openTab(s, { kind: 'folders' });
    expect(views(s)).toEqual(['folders', 1, 'folders']);
    expect(s.active).toBe(s.tabs[2].id);
  });

  it('closing the active tab moves to the right, or left at the end', () => {
    let s = initialTabs();
    s = openTab(s, f(1));
    s = openTab(s, f(2));
    s = activate(s, s.tabs[1].id);
    s = closeTab(s, s.active);
    expect(act(s)).toBe(2);
    s = closeTab(s, s.active);
    expect(act(s)).toBe('folders');
    // closing a background tab keeps the active one
    s = openTab(s, f(7), { background: true });
    s = closeTab(s, s.tabs[1].id);
    expect(act(s)).toBe('folders');
  });

  it('closing the last tab leaves one top-level tab', () => {
    let s = navigate(initialTabs(), f(1));
    s = closeTab(s, s.active);
    expect(s.tabs.length).toBe(1);
    expect(activeTab(s).view).toEqual({ kind: 'folders' });
    expect(activeTab(s).back).toEqual([]);
    // and it can be reopened
    s = reopenClosed(s);
    expect(views(s)).toEqual([1, 'folders']);
    expect(activeTab(s).back.length).toBe(1);
  });

  it('reopens closed tabs where they were, newest first, with their history', () => {
    let s = initialTabs();
    s = openTab(s, f(1));
    s = navigate(s, f(11));
    s = openTab(s, f(2));
    s = closeTab(s, s.tabs[1].id); // 11 (was at index 1)
    s = closeTab(s, s.tabs[1].id); // 2
    expect(views(s)).toEqual(['folders']);
    s = reopenClosed(s);
    expect(views(s)).toEqual(['folders', 2]);
    s = reopenClosed(s);
    expect(views(s)).toEqual(['folders', 11, 2]);
    expect(act(s)).toBe(11);
    expect(activeTab(s).back).toEqual([f(1)]);
    expect(reopenClosed(s)).toBe(s);
    expect(new Set(s.tabs.map((t) => t.id)).size).toBe(3); // ids stay unique
  });

  it('close others / to the right', () => {
    let s = initialTabs();
    for (const id of [1, 2, 3]) s = openTab(s, f(id));
    const keep = s.tabs[1].id;
    expect(views(closeToRight(s, keep))).toEqual(['folders', 1]);
    expect(act(closeToRight(s, keep))).toBe(1); // active (3) was closed
    const o = closeOthers(s, keep);
    expect(views(o)).toEqual([1]);
    expect(o.active).toBe(keep);
    expect(reopenClosed(o).tabs.length).toBe(2);
  });

  it('duplicates with history, right after the original', () => {
    let s = navigate(initialTabs(), f(1));
    s = openTab(s, f(2));
    s = duplicateTab(s, s.tabs[0].id);
    expect(views(s)).toEqual([1, 1, 2]);
    expect(activeTab(s).back).toEqual([{ kind: 'folders' }]);
    expect(activeTab(s).view).not.toBe(s.tabs[0].view);
  });
});

describe('switching and order', () => {
  const four = () => {
    let s = initialTabs();
    for (const id of [1, 2, 3]) s = openTab(s, f(id));
    return s;
  };
  it('cycles both ways, wrapping', () => {
    let s = four();
    s = cycle(s, 1);
    expect(act(s)).toBe('folders');
    s = cycle(s, -1);
    expect(act(s)).toBe(3);
    expect(cycle(initialTabs(), 1)).toEqual(initialTabs());
  });
  it('jumps with Ctrl+1…8 and Ctrl+9 for the last', () => {
    const s = four();
    expect(act(jumpTo(s, 1))).toBe('folders');
    expect(act(jumpTo(s, 2))).toBe(1);
    expect(act(jumpTo(s, 9))).toBe(3);
    expect(jumpTo(s, 7)).toBe(s);
  });
  it('reorders by dragging', () => {
    const s = four();
    expect(views(moveTab(s, s.tabs[0].id, 2))).toEqual([1, 2, 'folders', 3]);
    expect(views(moveTab(s, s.tabs[3].id, 0))).toEqual([3, 'folders', 1, 2]);
    expect(views(moveTab(s, s.tabs[3].id, 99))).toEqual(['folders', 1, 2, 3]);
    expect(moveTab(s, s.tabs[3].id, 99).active).toBe(s.active);
  });
});

describe('saving and restoring', () => {
  it('round-trips tabs, history and the active tab', () => {
    let s = navigate(initialTabs(), f(1));
    s = openTab(s, { kind: 'search', tags: ['beach'], names: [], people: [4] });
    s = openTab(s, { kind: 'similar', id: 8, name: 'x.jpg' });
    s = activate(s, s.tabs[1].id);
    const r = restoreTabs(serializeTabs(s))!;
    expect(r.tabs.map((t) => t.view)).toEqual(s.tabs.map((t) => t.view));
    expect(r.tabs[0].back).toEqual([{ kind: 'folders' }]);
    expect(activeTab(r).view.kind).toBe('search');
    expect(r.closed).toEqual([]);
    expect(new Set(r.tabs.map((t) => t.id)).size).toBe(3);
    expect(r.nextId).toBeGreaterThan(Math.max(...r.tabs.map((t) => t.id)));
  });

  it('drops anything broken and keeps the right active tab', () => {
    expect(restoreTabs(null)).toBeNull();
    expect(restoreTabs('nope')).toBeNull();
    expect(restoreTabs('{"v":2,"tabs":[]}')).toBeNull();
    expect(restoreTabs('{"v":1,"active":0,"tabs":[{"view":{"kind":"bogus"}}]}')).toBeNull();
    const raw = JSON.stringify({
      v: 1, active: 2, tabs: [
        { view: { kind: 'folder', id: 'x' } },
        { view: { kind: 'favourites' }, back: [{ kind: 'folder', id: 3 }, { kind: 'zzz' }, 5] },
        { view: { kind: 'folder', id: 7 } },
      ],
    });
    const r = restoreTabs(raw)!;
    expect(r.tabs.map((t) => t.view)).toEqual([{ kind: 'favourites' }, { kind: 'folder', id: 7 }]);
    expect(r.tabs[0].back).toEqual([{ kind: 'folder', id: 3 }]);
    expect(activeTab(r).view).toEqual({ kind: 'folder', id: 7 });
    const big = JSON.stringify({ v: 1, active: 50, tabs: [{ view: { kind: 'all' } }] });
    expect(activeTab(restoreTabs(big)!).view).toEqual({ kind: 'all' });
  });
});

describe('tab names', () => {
  const folders = new Map<number, FolderName>([
    [1, { id: 1, name: 'Trips', parentId: null }],
    [2, { id: 2, name: 'Rome', parentId: 1 }],
    [3, { id: 3, name: 'Anna', parentId: null, person: true }],
  ]);
  it('names folders with their path and picks an icon', () => {
    expect(tabLook(f(2), folders)).toEqual({ title: 'Rome', icon: 'folder', path: 'All folders › Trips › Rome' });
    expect(tabLook(f(3), folders).icon).toBe('person');
    expect(tabLook(f(99), folders).title).toBe('Folder');
    expect(tabLook({ kind: 'favourites' }, folders).icon).toBe('heart');
    expect(tabLook({ kind: 'search', tags: ['sea'], names: ['img'], people: [3] }, folders).title).toBe('Anna + #sea + “img”');
    expect(tabLook({ kind: 'timeline', person: 3 }, folders).title).toBe('Anna · timeline');
  });
});
