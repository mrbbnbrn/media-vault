// Hold Alt and point at a tile: its picture grows in place, whole (nothing
// cropped) and about twice as big, kept inside the window. The thumbnail
// shows at once; the full-resolution picture (or the video, playing muted)
// fades in over it while Alt is held. Let go of Alt or leave the tile and it
// shrinks back.
//
// Alt on its own does nothing else here: its key events are kept from the
// window (so it doesn't wake up the window menu). Alt+F4 and Alt+Tab still
// work — only the Alt key itself is held back, never another key.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { mediaUrl, thumbUrl, type Item } from '../api';
import { enlargeBox, type Rect } from '../tilemaths';

interface Shown {
  item: Item;
  tile: Rect;
  box: Rect;
  /** Grown to `box` (false: drawn over the tile, about to grow or shrinking back). */
  open: boolean;
  closing: boolean;
}

const rectOf = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });
const same = (a: Rect, b: Rect) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

export function AltEnlarge(props: { root: React.RefObject<HTMLDivElement | null>; items: Item[] }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [ready, setReady] = useState<number | null>(null);
  const cur = useRef<Shown | null>(null);
  cur.current = shown;
  const state = useRef({ alt: false, x: -1, y: -1, buttons: 0 });
  const itemsRef = useRef(props.items);
  itemsRef.current = props.items;
  const byId = useRef<{ list: Item[]; map: Map<number, Item> } | null>(null);

  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    const find = (id: number) => {
      const list = itemsRef.current;
      if (byId.current?.list !== list) byId.current = { list, map: new Map(list.map((i) => [i.id, i])) };
      return byId.current.map.get(id);
    };
    const close = () => {
      const c = cur.current;
      if (!c || c.closing) return;
      setShown({ ...c, open: false, closing: true });
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => setShown((s) => (s?.closing ? null : s)), 190);
    };
    const update = () => {
      const st = state.current;
      const root = props.root.current;
      if (!st.alt || st.buttons || !root || st.x < 0 || document.querySelector('[aria-modal="true"]')) return close();
      const el = document.elementFromPoint(st.x, st.y) as HTMLElement | null;
      const tileEl = el?.closest<HTMLElement>('[data-item]');
      if (!tileEl || !root.contains(tileEl)) return close();
      const item = find(Number(tileEl.dataset.item));
      if (!item || item.thumb === 'failed') return close();
      const tile = rectOf(tileEl.getBoundingClientRect());
      const img = tileEl.querySelector('img');
      const nw = item.width || img?.naturalWidth || 0;
      const nh = item.height || img?.naturalHeight || 0;
      const box = enlargeBox(tile, nw, nh, window.innerWidth, window.innerHeight);
      const c = cur.current;
      if (closeTimer) clearTimeout(closeTimer);
      if (c && c.item.id === item.id && !c.closing) {
        if (!same(c.tile, tile) || !same(c.box, box)) setShown({ ...c, tile, box });
        return;
      }
      // A new tile: start over it, then grow (two frames so the start is drawn first).
      setShown({ item, tile, box, open: false, closing: false });
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => setShown((s) => (s && s.item.id === item.id && !s.closing ? { ...s, open: true } : s)));
      });
    };
    const onMove = (e: PointerEvent) => {
      const st = state.current;
      st.x = e.clientX;
      st.y = e.clientY;
      st.buttons = e.buttons;
      // The mouse event knows best (Alt may have been let go in another window).
      st.alt = e.altKey;
      update();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') {
        if (e.type === 'keydown' && state.current.alt && !e.altKey) {
          state.current.alt = false;
          update();
        }
        return;
      }
      // Only the Alt key itself: Alt+F4, Alt+Tab, Alt+← keep working.
      e.preventDefault();
      state.current.alt = e.type === 'keydown';
      update();
    };
    const off = () => {
      state.current.alt = false;
      close();
    };
    const onScroll = () => state.current.alt && update();
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', off);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      if (closeTimer) clearTimeout(closeTimer);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', off);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [props.root]);

  if (!shown) return null;
  const { item } = shown;
  const r = shown.open ? shown.box : shown.tile;
  const isReady = ready === item.id;
  const doc = item.kind === 'pdf' || item.kind === 'text';
  return createPortal(
    <div className={`alt-enlarge${shown.closing ? ' closing' : ''}`} style={{ left: r.left, top: r.top, width: r.width, height: r.height }} aria-hidden="true">
      <img src={thumbUrl(item.id)} alt="" draggable={false} style={doc ? { objectPosition: 'top' } : undefined} />
      {/* The full picture is only fetched while Alt is held over it. */}
      {(item.kind === 'image' || item.kind === 'gif') && (
        <img key={item.id} className={`full${isReady ? ' ready' : ''}`} src={mediaUrl(item.id)} alt="" draggable={false} decoding="async" onLoad={() => setReady(item.id)} />
      )}
      {item.kind === 'video' && (
        <video key={item.id} className={`full${isReady ? ' ready' : ''}`} src={mediaUrl(item.id)} muted loop autoPlay playsInline preload="auto" onPlaying={() => setReady(item.id)} />
      )}
    </div>,
    document.body,
  );
}
