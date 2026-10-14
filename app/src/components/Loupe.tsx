// Alt + hover over a tile: a round magnifier follows the mouse and shows that
// spot of the picture at full resolution (the thumbnail, scaled up, shows at
// once while the full picture loads). Alt + mouse wheel changes the
// magnification (1.5×–6×). Videos show their thumbnail magnified.
//
// Alt on its own does nothing else here: its key events are kept from the
// window (so it doesn't wake up the window menu). Alt+F4 and Alt+Tab still
// work — only the Alt key itself is held back, never another key.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { mediaUrl, thumbUrl, type Item } from '../api';
import { loupeSpot, loupeZoom, objectPosition, tileDraw, tilePoint } from '../tilemaths';

export const LOUPE_SIZE = 240;
let lastMag = 2.5;

interface Spot {
  item: Item;
  x: number;
  y: number;
  /** Cursor inside the tile, and the tile's drawn picture. */
  tx: number;
  ty: number;
  d: { dw: number; dh: number; ox: number; oy: number };
}

export function Loupe(props: { root: React.RefObject<HTMLDivElement | null>; items: Item[]; shape: boolean }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [mag, setMag] = useState(lastMag);
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const state = useRef({ alt: false, x: -1, y: -1, buttons: 0 });
  const itemsRef = useRef(props.items);
  itemsRef.current = props.items;
  const byId = useRef<{ list: Item[]; map: Map<number, Item> } | null>(null);
  const shapeRef = useRef(props.shape);
  shapeRef.current = props.shape;

  useEffect(() => {
    const find = (id: number) => {
      const list = itemsRef.current;
      if (byId.current?.list !== list) byId.current = { list, map: new Map(list.map((i) => [i.id, i])) };
      return byId.current.map.get(id);
    };
    const update = () => {
      const st = state.current;
      const root = props.root.current;
      if (!st.alt || st.buttons || !root || st.x < 0 || document.querySelector('[aria-modal="true"]')) return setSpot(null);
      const el = document.elementFromPoint(st.x, st.y) as HTMLElement | null;
      const tile = el?.closest<HTMLElement>('[data-item]');
      if (!tile || !root.contains(tile)) return setSpot(null);
      const item = find(Number(tile.dataset.item));
      if (!item || item.kind === 'pdf' || item.kind === 'text' || item.thumb === 'failed') return setSpot(null);
      const r = tile.getBoundingClientRect();
      const img = tile.querySelector('img');
      const { px, py } = objectPosition(img?.style.objectPosition);
      const nw = item.width || img?.naturalWidth || r.width;
      const nh = item.height || img?.naturalHeight || r.height;
      const d = tileDraw(nw, nh, r.width, r.height, 'cover', shapeRef.current ? 0.5 : px, shapeRef.current ? 0.5 : py);
      setSpot({ item, x: st.x, y: st.y, tx: st.x - r.left, ty: st.y - r.top, d });
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
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey || !state.current.alt) return;
      const root = props.root.current;
      const t = e.target as HTMLElement | null;
      if (!root || !t || !root.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
      setMag((m) => (lastMag = loupeZoom(m, e.deltaY)));
    };
    const off = () => {
      state.current.alt = false;
      setSpot(null);
    };
    const onScroll = () => state.current.alt && update();
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('blur', off);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', off);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [props.root]);

  // Full pictures are only fetched while the loupe shows them.
  useEffect(() => {
    if (!spot) setLoaded(new Set());
  }, [spot == null]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = useMemo(() => (spot ? loupeSpot(spot.x, spot.y, LOUPE_SIZE, window.innerWidth, window.innerHeight) : null), [spot]);
  if (!spot || !pos) return null;
  const { item, d } = spot;
  const { u, v } = tilePoint(spot.tx, spot.ty, d);
  const W = d.dw * mag;
  const H = d.dh * mag;
  // The magnified spot sits right under the cursor (also when the loupe is pushed in at the edges).
  const left = spot.x - pos.left - u * W;
  const top = spot.y - pos.top - v * H;
  const box = { left, top, width: W, height: H };
  const full = item.kind === 'image' || item.kind === 'gif';
  return createPortal(
    <div className="loupe" style={{ left: pos.left, top: pos.top, width: LOUPE_SIZE, height: LOUPE_SIZE }} aria-hidden="true">
      <img src={thumbUrl(item.id)} alt="" draggable={false} style={box} />
      {full && (
        <img key={item.id} src={mediaUrl(item.id)} alt="" draggable={false} decoding="async" style={{ ...box, opacity: loaded.has(item.id) ? 1 : 0 }}
          onLoad={() => setLoaded((s) => new Set(s).add(item.id))} />
      )}
      <span className="loupe-mag">{mag.toFixed(1).replace(/\.0$/, '')}×</span>
    </div>,
    document.body,
  );
}
