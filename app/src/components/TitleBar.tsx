// Our own title bar (the window has no Windows frame): the app mark, the
// library tabs like a web browser's, empty space to drag the window
// (double-click maximises), and the minimise / maximise / close buttons.
// The OS window title always stays "Media Vault".

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { inTauri } from '../api';
import type { LibraryTabs, TabInfo } from '../tabs/useTabs';
import type { TabIconKind } from '../tabs/tabs';
import { ContextMenu, type MenuItem } from './Dialogs';
import {
  ChartIcon, ChevronIcon, ClockIcon, CloseIcon, FaceIcon, FolderIcon, HeartIcon, ImagesIcon, ImportIcon, PlayIcon, PlusIcon, SearchIcon,
  SparkleIcon, TrashIcon, TwinIcon,
} from './Icons';
import '../titlebar.css';

const ICONS: Record<TabIconKind, (p: { size?: number }) => React.ReactElement> = {
  folder: FolderIcon, folders: FolderIcon, person: FaceIcon, heart: HeartIcon, search: SearchIcon, smart: SparkleIcon, clock: ClockIcon,
  trash: TrashIcon, chart: ChartIcon, face: FaceIcon, twin: TwinIcon, play: PlayIcon, sparkle: SparkleIcon, images: ImagesIcon, recent: ImportIcon,
};

const modalOpen = () => !!document.querySelector('[aria-modal="true"]');

/** The window's maximised state (for the right caption icon). */
function useMaximized(): boolean {
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    const w = getCurrentWindow();
    let live = true;
    const check = () => w.isMaximized().then((m) => live && setMax(m)).catch(() => {});
    check();
    const off = w.onResized(check).catch(() => null);
    return () => {
      live = false;
      off.then((u) => u?.());
    };
  }, []);
  return max;
}

const win = (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) => {
  if (inTauri) fn(getCurrentWindow()).catch(() => {});
};

export function TitleBar({ tabs, onTab, onLock, closeOnly }: {
  /** Tabs to show (null on the start and unlock screens). */
  tabs: LibraryTabs | null;
  /** A tab was chosen (the app shows the library if it was elsewhere). */
  onTab?: () => void;
  /** With a vault open, the lock mark locks it (like Ctrl+Shift+L). */
  onLock?: () => void;
  /** The vault has no password: the mark closes it (back to the vault list) instead of locking it. */
  closeOnly?: boolean;
}) {
  const max = useMaximized();
  return (
    <div className="titlebar" data-tauri-drag-region>
      {/* lock from the title bar (begin) */}
      {onLock ? <LockMark onLock={onLock} closeOnly={closeOnly} /> : (
        <div className="wt-mark" data-tauri-drag-region="deep" title="Media Vault">
          <LockGlyph />
        </div>
      )}
      {/* lock from the title bar (end) */}
      {tabs && <TabStrip tabs={tabs} onTab={onTab} />}
      <div className="wt-drag" data-tauri-drag-region />
      <div className="wt-caption">
        <button type="button" className="wt-cap" aria-label="Minimise" title="Minimise" tabIndex={-1} onClick={() => win((w) => w.minimize())}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button type="button" className="wt-cap" aria-label={max ? 'Restore' : 'Maximise'} title={max ? 'Restore down' : 'Maximise'} tabIndex={-1}
          onClick={() => win((w) => w.toggleMaximize())}>
          {max ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="2.5" width="7" height="7" />
              <path d="M2.5 2.5V0.5h7v7h-2" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
          )}
        </button>
        <button type="button" className="wt-cap close" aria-label="Close" title="Close" tabIndex={-1} onClick={() => win((w) => w.close())}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </div>
  );
}

/** The app mark: a padlock whose shackle can move (it closes when you lock). */
function LockGlyph() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path className="wt-shackle" d="M8 10V7a4 4 0 0 1 8 0v3" />
      <rect x="4" y="10" width="16" height="11" rx="2" />
    </svg>
  );
}

/** With a vault open the mark is a button: it locks the vault, with the
 *  shackle snapping shut. Not a drag region, so clicks always land and a
 *  double-click doesn't maximise the window. */
function LockMark({ onLock, closeOnly }: { onLock: () => void; closeOnly?: boolean }) {
  const [snap, setSnap] = useState(0);
  useEffect(() => {
    if (!snap) return;
    const t = setTimeout(() => setSnap(0), 600);
    return () => clearTimeout(t);
  }, [snap]);
  return (
    <button type="button" className={`wt-mark wt-lock${snap ? ' snap' : ''}`} aria-label={closeOnly ? 'Close the vault' : 'Lock the vault'} title={closeOnly ? 'Close the vault, back to the vault list (Ctrl+Shift+L)' : 'Lock (Ctrl+Shift+L)'} tabIndex={-1}
      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={() => {
        setSnap(Date.now());
        onLock();
      }}>
      <LockGlyph />
    </button>
  );
}

function TabStrip({ tabs, onTab }: { tabs: LibraryTabs; onTab?: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; title?: string; items: MenuItem[] } | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const drag = useRef<{ id: number; x: number; moved: boolean } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Too many tabs to fit (at their smallest): scroll, with a list of all of them.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, [tabs.list.length]);
  // The active tab is always in view.
  useEffect(() => {
    scroller.current?.querySelector<HTMLElement>('.wt-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs.activeId, tabs.list.length]);

  const choose = (id: number) => {
    if (modalOpen()) return;
    tabs.activate(id);
    onTab?.();
  };
  // Closing a tab that isn't the one showing (say while the viewer is open)
  // leaves everything where it is; only losing the current tab switches.
  const close = (id: number) => {
    if (modalOpen()) return;
    const current = id === tabs.activeId;
    tabs.close(id);
    if (current) onTab?.();
  };
  const tabMenu = (e: React.MouseEvent, t: TabInfo) => {
    e.preventDefault();
    if (modalOpen()) return;
    const i = tabs.list.findIndex((x) => x.id === t.id);
    const run = (fn: () => void, switches = true) => () => {
      fn();
      if (switches) onTab?.();
    };
    const activeAt = tabs.list.findIndex((x) => x.active);
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: 'New tab', hint: 'Ctrl+T', onSelect: run(() => tabs.newTab()) },
      { label: 'Duplicate', onSelect: run(() => tabs.duplicate(t.id)) },
      { label: 'Close', hint: 'Ctrl+W', sepBefore: true, onSelect: run(() => tabs.close(t.id), t.active) },
      { label: 'Close other tabs', disabled: tabs.list.length < 2, onSelect: run(() => tabs.closeOthers(t.id), !t.active) },
      { label: 'Close tabs to the right', disabled: i === tabs.list.length - 1, onSelect: run(() => tabs.closeToRight(t.id), activeAt > i) },
      { label: 'Reopen closed tab', hint: 'Ctrl+Shift+T', sepBefore: true, disabled: !tabs.canReopen, onSelect: run(() => tabs.reopen()) },
    ] });
  };
  const listMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, title: 'Open tabs', items: tabs.list.map((t) => ({ label: t.title, checked: t.active, onSelect: () => choose(t.id) })) });
  };

  // Drag a tab sideways to put it somewhere else.
  const onPointerDown = (e: React.PointerEvent, t: TabInfo) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.wt-x')) return;
    choose(t.id);
    if (modalOpen()) return;
    drag.current = { id: t.id, x: e.clientX, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x) < 5) return;
    if (!d.moved) {
      d.moved = true;
      setDragId(d.id);
    }
    const el = scroller.current;
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>('.wt-tab')];
    const list = tabsRef.current.list;
    const from = list.findIndex((x) => x.id === d.id);
    let to = from;
    nodes.forEach((n, i) => {
      if (i === from) return;
      const r = n.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if (i < from && e.clientX < mid) to = Math.min(to, i);
      if (i > from && e.clientX > mid) to = Math.max(to, i);
    });
    if (to !== from) tabsRef.current.move(d.id, to);
    // Near the edges of a scrolling strip, keep scrolling.
    const sr = el.getBoundingClientRect();
    if (e.clientX < sr.left + 20) el.scrollLeft -= 12;
    else if (e.clientX > sr.right - 20) el.scrollLeft += 12;
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragId(null);
  };

  return (
    <>
      <div className="wt-tabs" ref={scroller} role="tablist" aria-label="Tabs" data-tauri-drag-region
        onWheel={(e) => {
          const el = scroller.current;
          if (el && overflow) el.scrollLeft += e.deltaY || e.deltaX;
        }}>
        {tabs.list.map((t) => {
          const Icon = ICONS[t.icon];
          return (
            <div key={t.id} role="tab" aria-selected={t.active} tabIndex={-1} title={t.path}
              className={`wt-tab${t.active ? ' on' : ''}${dragId === t.id ? ' dragging' : ''}`}
              onPointerDown={(e) => onPointerDown(e, t)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                close(t.id);
              }}
              onContextMenu={(e) => tabMenu(e, t)}>
              <span className="wt-icon"><Icon size={14} /></span>
              <span className="wt-title">{t.title}</span>
              <button type="button" className="wt-x" aria-label={`Close ${t.title}`} title="Close tab (Ctrl+W)"
                onClick={(e) => { e.stopPropagation(); close(t.id); }}><CloseIcon size={11} /></button>
            </div>
          );
        })}
      </div>
      {overflow && (
        <button type="button" className="wt-btn" aria-label="All tabs" title="All tabs" tabIndex={-1} onClick={listMenu}><ChevronIcon open /></button>
      )}
      <button type="button" className="wt-btn" aria-label="New tab" title="New tab (Ctrl+T) · middle-click a folder to open it in a new tab" tabIndex={-1}
        onClick={() => { if (!modalOpen()) { tabs.newTab(); onTab?.(); } }}>
        <PlusIcon size={15} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
