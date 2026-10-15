// Thumbnail grid that only draws the tiles on screen, so 10,000+ items scroll
// smoothly. Click to select (Ctrl/Shift for more), double-click to open, and
// drag a selection onto any folder to move it there.
//
// Layouts: equal tiles ("grid") or every item at its true shape ("shape"),
// optionally in groups with a header (the timeline's months).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { itemThumbUrl, mediaUrl, smallEnough, thumbUrl, type FaceBox, type Item } from '../api';
import { formatBytes } from '../theme';
// ---- video previews (VideoPreview.tsx, previewplan.ts) ----
import { preferPreviews, useMadePreviews } from '../previews';
import { chooseLayers, type Layer, type TileWant } from '../previewplan';
import { reportPlan, useRealBudget, VideoPreview } from './VideoPreview';
// ---- end video previews ----
import { layoutGrid, visibleRange, type Group, HEADER_H, GAP } from '../gridlayout';
import { startMoveDrag } from '../dragmove';
import { formatTime, onThumb } from '../media';
import { BrokenIcon, HeartIcon } from './Icons';
import { AltEnlarge } from './AltEnlarge';
import { Minimap, MINIMAP_RESERVE } from './Minimap';
import { wantsMinimap, watchedShare } from '../tilemaths';
import { resumeOf, useResumeChanges } from '../resumebus';
import { clickPick, moveFrom, movePick } from '../selection';
import { useGridReveal } from '../viewerflip';
import { lookAhead, ON_SCREEN, thumbQueue, tilePriority } from '../loadqueue';
import * as thumbCache from '../thumbcache';
import { sketchUrl } from '../sketch';

/** Should this tile play its video / GIF right now? (Always muted.) */
function live(it: Item, mode: 'all' | 'hover' | 'off', hover: number | null): boolean {
  if (mode === 'off' || it.thumb === 'failed' || (it.kind !== 'video' && it.kind !== 'gif')) return false;
  return mode === 'all' || hover === it.id;
}

export function MediaGrid(props: {
  items: Item[];
  /** Items per row. */
  columns: number;
  selected: Set<number>;
  /** additive: Ctrl or Shift was held, so other selected things (folders) stay selected. */
  onSelect: (sel: Set<number>, anchor: number | null, additive: boolean) => void;
  anchor: number | null;
  onOpen: (item: Item) => void;
  onDropOnFolder?: (ids: number[], target: string) => void;
  onContext: (e: React.MouseEvent, item: Item) => void;
  /** Videos and GIFs play (muted) in the grid: all on screen, only the hovered one, or none. */
  preview: 'all' | 'hover' | 'off';
  /** The hovered video/GIF shows uncropped (grid mode only). */
  wholeOnHover?: boolean;
  /** Videos: tiny clips first and the real video when the PC keeps up, or tiny clips only. */
  previewQuality?: 'auto' | 'tiny';
  layout?: 'grid' | 'shape';
  groups?: Group[];
  scroller: React.RefObject<HTMLElement | null>;
  /** The item the arrow keys move from (always the last one selected; not drawn separately). */
  cursor?: number | null;
  onCursor?: (id: number | null) => void;
  onQuickLook?: (item: Item) => void;
  /** Arrow keys etc. are on (off while a dialog or quick look is open). */
  keyboard?: boolean;
  /** Scroll this item into view and flash it. */
  reveal?: { id: number; n: number } | null;
  /** Name, size and length along the bottom of the hovered tile. */
  hoverInfo?: boolean;
  /** Faces per item (face boxes / face-aware cropping). */
  faces?: Map<number, FaceBox[]>;
  faceBoxes?: boolean;
  faceCrop?: boolean;
  /** Person folder id → name, for the tags on face boxes. */
  personName?: (id: number) => string | undefined;
  /** Cut (Ctrl+X) items show faded. */
  dimmed?: Set<number>;
  /** Also called when an item drag starts (drag out of the window to Explorer). */
  onDragStart?: (e: React.PointerEvent, ids: number[]) => void;
  /** Space between tiles (re-layout when it changes). */
  gap?: number;
  /** The overview strip beside the scrollbar (long grids only). */
  minimap?: boolean;
  /** What the scroll preview says at an item (month, first letters…); groups' labels win. */
  minimapLabel?: (it: Item) => string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  // dir: which way the scroll last went (+1 down, −1 up); ahead: how far past the view to draw tiles that way.
  const [view, setView] = useState({ top: 0, bottom: 1200, dir: 1, ahead: 600 });
  // Thumbnails made (again) while this grid shows: how many times, so a remade one (e.g. after a saved rotation) loads afresh.
  const [ready, setReady] = useState<Map<number, number>>(new Map());
  const mode = props.layout ?? 'grid';
  useResumeChanges();

  useEffect(() => onThumb((id) => setReady((r) => new Map(r).set(id, (r.get(id) ?? 0) + 1))), []);
  // ---- video previews ----
  const made = useMadePreviews();
  const realBudget = useRealBudget();
  /** Tiles playing the real video last time: they keep it (no swapping back and forth while scrolling). */
  const wasReal = useRef<Set<number>>(new Set());
  // ---- end video previews ----

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(
    () => layoutGrid(props.items, width, Math.max(40, (width + GAP) / Math.max(1, props.columns) - GAP - 0.01), mode, props.groups),
    [props.items, width, props.columns, mode, props.groups, props.gap],
  );

  useEffect(() => {
    const sc = props.scroller.current;
    const el = ref.current;
    if (!sc || !el) return;
    // Scroll speed (px per ms, smoothed): the faster it goes, the further ahead tiles are drawn and their thumbnails asked for.
    let lastT = 0;
    let lastY = sc.scrollTop;
    let speed = 0;
    let dir = 1;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      const now = performance.now();
      const y = sc.scrollTop;
      const dt = now - lastT;
      speed = lastT && dt > 0 && dt < 250 ? speed * 0.6 + ((y - lastY) / dt) * 0.4 : 0;
      if (Math.abs(speed) > 0.05) dir = speed > 0 ? 1 : -1;
      lastT = now;
      lastY = y;
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const t = sc.scrollTop - top;
      setView({ top: t, bottom: t + sc.clientHeight, dir, ahead: lookAhead(speed) });
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        speed = 0;
        setView((v) => (v.ahead === 600 ? v : { ...v, ahead: 600 }));
      }, 300);
    };
    update();
    sc.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      if (idle) clearTimeout(idle);
      sc.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [props.scroller, layout]);

  // Bring an item into view (only scrolls if it isn't already visible).
  // Always the latest layout: the key handler below keeps the first render's copy of this function.
  const layoutNow = useRef(layout);
  layoutNow.current = layout;
  const bringIntoView = (i: number, centre = false) => {
    const sc = props.scroller.current;
    const el = ref.current;
    const b = layoutNow.current.boxes[i];
    if (!sc || !el || !b) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const y0 = top + b.y;
    const y1 = y0 + b.h;
    if (y0 < sc.scrollTop + 8) sc.scrollTop = centre ? y0 - sc.clientHeight / 3 : y0 - 8;
    else if (y1 > sc.scrollTop + sc.clientHeight - 8) sc.scrollTop = centre ? y0 - sc.clientHeight / 3 : y1 - sc.clientHeight + 8;
  };
  useEffect(() => {
    if (!props.reveal) return;
    const i = props.items.findIndex((x) => x.id === props.reveal!.id);
    if (i < 0) return;
    // After the scroll position has been restored.
    // Selected (ring and tick), so nothing else needs to flash.
    const t = setTimeout(() => {
      bringIntoView(i, true);
      props.onSelect(new Set([props.reveal!.id]), props.reveal!.id, false);
      props.onCursor?.(props.reveal!.id);
    }, 200);
    return () => clearTimeout(t);
  }, [props.reveal?.n, props.items.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing the viewer: scroll the item's tile into view right away and say where it is (viewerflip.ts).
  useGridReveal((id) => {
    const i = props.items.findIndex((x) => x.id === id);
    const el = ref.current;
    const b = layout.boxes[i];
    if (i < 0 || !el || !b) return null;
    bringIntoView(i);
    const g = el.getBoundingClientRect();
    return { left: g.left + b.x, top: g.top + b.y, width: b.w, height: b.h };
  });

  // Keyboard: arrows move the selection (Shift extends it), Enter opens,
  // Space = quick look. What is highlighted is always what is selected.
  const keyState = useRef({ props, layout });
  keyState.current = { props, layout };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { props: p, layout: L } = keyState.current;
      if (!p.keyboard || !p.items.length) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [role=dialog]') || document.querySelector('[aria-modal="true"]')) return;
      const k = e.key;
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(k) || e.altKey) return;
      // Start from the last selected item; if the selection moved elsewhere, from a selected one.
      const order = p.items.map((x) => x.id);
      const cur = moveFrom(order, p.selected, p.cursor ?? null);
      if (k === 'Enter') {
        if (cur >= 0) {
          e.preventDefault();
          p.onOpen(p.items[cur]);
        }
        return;
      }
      if (k === ' ') {
        e.preventDefault();
        if (cur >= 0) p.onQuickLook?.(p.items[cur]);
        return;
      }
      e.preventDefault();
      let next = cur;
      if (cur < 0) next = 0;
      else if (k === 'ArrowLeft') next = Math.max(0, cur - 1);
      else if (k === 'ArrowRight') next = Math.min(p.items.length - 1, cur + 1);
      else {
        // Up / down: the nearest item in the row above / below.
        const b = L.boxes[cur];
        const cx = b.x + b.w / 2;
        let best = -1;
        let bestRow = k === 'ArrowUp' ? -Infinity : Infinity;
        let bestDx = Infinity;
        L.boxes.forEach((o, j) => {
          const below = o.y > b.y + 1;
          const above = o.y < b.y - 1;
          if ((k === 'ArrowDown' && !below) || (k === 'ArrowUp' && !above)) return;
          const dx = Math.abs(o.x + o.w / 2 - cx);
          const closerRow = k === 'ArrowDown' ? o.y < bestRow - 1 : o.y > bestRow + 1;
          const sameRow = Math.abs(o.y - bestRow) <= 1;
          if (closerRow || (sameRow && dx < bestDx)) {
            best = j;
            bestRow = o.y;
            bestDx = dx;
          }
        });
        if (best >= 0) next = best;
      }
      const id = p.items[next].id;
      const picked = movePick(order, p.anchor, id, e.shiftKey);
      p.onSelect(picked.selected, picked.anchor, picked.additive);
      p.onCursor?.(picked.cursor);
      bringIntoView(next);
      // Keyboard focus follows the selection, so no second outline stays behind
      // on the tile that was clicked before.
      requestAnimationFrame(() => {
        const el = ref.current?.querySelector<HTMLElement>(`[data-item="${id}"]`);
        if (el && el !== document.activeElement) el.focus({ preventScroll: true });
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [from, to] = visibleRange(layout.boxes, view.top - (view.dir < 0 ? view.ahead : 600), view.bottom + (view.dir > 0 ? view.ahead : 600));
  // Only tiles really on screen play; the rest just show their thumbnail.
  const onScreen = (i: number) => {
    const b = layout.boxes[i];
    return b.y + b.h > view.top && b.y < view.bottom;
  };
  // ---- video previews: what each playing video tile shows (previewplan.ts) ----
  const hasStrip = (it: Item) => it.preview || !!made.get(it.id)?.has('strip');
  const hasTiny = (it: Item) => !!it.tiny || !!made.get(it.id)?.has('tiny');
  const wants: TileWant[] = [];
  const mid = (view.top + view.bottom) / 2;
  for (let i = from; i < to; i++) {
    const it = props.items[i];
    if (it.kind !== 'video' || !onScreen(i) || !live(it, props.preview, hover)) continue;
    const b = layout.boxes[i];
    wants.push({ id: it.id, hasTiny: hasTiny(it), hasStrip: hasStrip(it), hovered: hover === it.id, rank: Math.abs(b.y + b.h / 2 - mid) - (wasReal.current.has(it.id) ? 100_000 : 0) });
  }
  const layers = chooseLayers(wants, realBudget, props.previewQuality ?? 'auto');
  const realCount = [...layers.values()].filter((l) => l === 'real').length;
  wasReal.current = new Set([...layers].filter(([, l]) => l === 'real').map(([id]) => id));
  const wantKey = wants.map((x) => `${x.id}${x.hasTiny ? 't' : ''}${x.hasStrip ? 's' : ''}`).join(',');
  useEffect(() => {
    reportPlan(wants.length, realCount);
    // Make the missing stand-ins of the videos on screen first.
    preferPreviews(wants.filter((x) => !x.hasTiny || !x.hasStrip).map((x) => x.id));
  }, [wantKey, realCount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => reportPlan(0, 0), []);
  const layerOf = (id: number): Layer => layers.get(id) ?? 'thumb';
  // ---- end video previews ----

  // One rule for clicks, arrow keys and everything else (selection.ts).
  const click = (e: React.MouseEvent, item: Item) => {
    const p = clickPick(props.items.map((x) => x.id), props.selected, props.anchor, item.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    props.onSelect(p.selected, p.anchor, p.additive);
    props.onCursor?.(p.cursor);
  };

  // Dragging the selection onto any folder moves it there.
  const startDrag = (e: React.PointerEvent, item: Item) => {
    if (!props.onDropOnFolder) return;
    const ids = props.selected.has(item.id) ? [...props.selected] : [item.id];
    const n = `${ids.length} item${ids.length > 1 ? 's' : ''}`;
    startMoveDrag(e, {
      label: (t) => (t ? `Move ${n} here` : n),
      canDrop: (t) => t !== 'folder:' + (item.folderId ?? 'top') || ids.length > 1,
      onDrop: (t) => props.onDropOnFolder?.(ids, t),
    });
    props.onDragStart?.(e, ids);
  };

  /** Where the picture sits inside a cropped tile: object-position (0–1) and its drawn size. */
  const placement = (it: Item, w: number, h: number) => {
    if (!it.width || !it.height) return null;
    const s0 = mode === 'shape' ? Math.min(w / it.width, h / it.height) : Math.max(w / it.width, h / it.height);
    const dw = it.width * s0;
    const dh = it.height * s0;
    let px = 0.5;
    let py = 0.5;
    const fs = props.faces?.get(it.id);
    if (props.faceCrop && mode !== 'shape' && fs?.length) {
      // Centre the biggest face (as far as the crop allows).
      const f = fs.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      const ox = Math.min(0, Math.max(w - dw, w / 2 - cx * dw));
      const oy = Math.min(0, Math.max(h - dh, h / 2 - cy * dh));
      px = dw > w ? ox / (w - dw) : 0.5;
      py = dh > h ? oy / (h - dh) : 0.5;
    }
    return { px, py, dw, dh, ox: (w - dw) * px, oy: (h - dh) * py };
  };

  // The hovered video/GIF uncropped: same scale as in its tile, the tile
  // just grows in the direction that was cut off. Kept inside the view.
  const hoverIdx = hover != null ? props.items.findIndex((x) => x.id === hover) : -1;
  const hovered = hoverIdx >= 0 ? props.items[hoverIdx] : null;
  let pop: { left: number; top: number; w: number; h: number; item: Item } | null = null;
  if (props.wholeOnHover && mode === 'grid' && hovered && live(hovered, props.preview, hover) && hovered.width && hovered.height) {
    const b = layout.boxes[hoverIdx];
    const s = Math.max(b.w / hovered.width, b.h / hovered.height);
    const w = hovered.width * s;
    const h = hovered.height * s;
    if (w > b.w + 2 || h > b.h + 2) {
      let left = b.x + (b.w - w) / 2;
      let top = b.y + (b.h - h) / 2;
      left = Math.max(0, Math.min(width - w, left));
      const vTop = Math.max(0, view.top + 4);
      top = Math.max(vTop, Math.min(view.bottom - 4 - h, top));
      pop = { left, top, w, h, item: hovered };
    }
  }

  const showMini = !!props.minimap && wantsMinimap(layout.height, view.bottom - view.top);
  const labelAt = (i: number) => {
    const gs = props.groups;
    if (gs?.length) {
      let label: string | null = null;
      for (const g of gs) if (g.start <= i) label = g.label;
      return label;
    }
    return props.items[i] ? props.minimapLabel?.(props.items[i]) ?? null : null;
  };

  return (
    <div ref={ref} className={`mgrid${mode === 'shape' ? ' shape' : ''}`} style={{ height: layout.height, width: showMini ? `calc(100% - ${MINIMAP_RESERVE}px)` : undefined }} role="grid" aria-label="Media">
      <AltEnlarge root={ref} items={props.items} />
      {showMini && <Minimap items={props.items} layout={layout} gridW={width} scroller={props.scroller} grid={ref} view={view} labelAt={labelAt} />}
      {layout.headers.filter((h) => h.y + HEADER_H >= view.top - 600 && h.y <= view.bottom + 600).map((h) => (
        <div key={h.y} className="group-head" style={{ top: h.y, height: HEADER_H }}>
          <b>{h.label}</b> <span className="faint">{h.count.toLocaleString()}</span>
        </div>
      ))}
      {props.items.slice(from, to).map((it, k) => {
        const i = from + k;
        const b = layout.boxes[i];
        const hasThumb = it.thumb === 'ok' || ready.has(it.id);
        const sel = props.selected.has(it.id);
        const playing = live(it, props.preview, hover) && pop?.item.id !== it.id && onScreen(i);
        const place = (props.faceBoxes || props.faceCrop) && props.faces?.has(it.id) ? placement(it, b.w, b.h) : null;
        const watched = watchedShare(it.kind, it.durationMs, resumeOf(it));
        // Its thumbnail's address (a new address is a new QueuedThumb).
        const turl = tileThumbUrl(it, b.w, b.h, ready.get(it.id));
        return (
          <button key={it.id} type="button" role="gridcell" aria-selected={sel} title={it.note ? `${it.name}\n${it.note}` : it.name} data-item={it.id}
            className={`tile${sel ? ' sel' : ''}${it.kind === 'pdf' || it.kind === 'text' ? ' doc' : ''}${props.dimmed?.has(it.id) ? ' cut' : ''}${props.hoverInfo ? ' hinfo' : ''}`}
            style={{ left: b.x, top: b.y, width: b.w, height: b.h, ...sketchStyle(it, place && props.faceCrop ? place : null) }}
            onClick={(e) => click(e, it)} onDoubleClick={() => props.onOpen(it)}
            onKeyDown={(e) => e.key === 'Enter' && props.onOpen(it)} onPointerDown={(e) => startDrag(e, it)}
            onContextMenu={(e) => {
              e.preventDefault();
              props.onContext(e, it);
            }}
            onPointerEnter={() => setHover(it.id)} onPointerLeave={() => setHover((h) => (h === it.id ? null : h))}>
            {hasThumb && it.thumb !== 'failed' ? (
              <QueuedThumb key={turl} url={turl} prio={tilePriority(b.y, b.y + b.h, view.top, view.bottom, view.dir)} flinging={view.ahead > 900}
                style={place && props.faceCrop ? { objectPosition: `${place.px * 100}% ${place.py * 100}%` } : undefined} />
            ) : it.thumb === 'failed' ? (
              <span className="tile-msg"><BrokenIcon /> Can't play</span>
            ) : (
              <span className="tile-msg"><span className="spinner small" /></span>
            )}
            {playing && it.kind === 'video' && (
              <VideoPreview id={it.id} layer={layerOf(it.id)} eager={hover === it.id} hasStrip={hasStrip(it)} hasTiny={hasTiny(it)} durationMs={it.durationMs}
                w={b.w} h={b.h} aspect={it.width && it.height ? it.width / it.height : b.w / b.h} fit={mode === 'shape' ? 'contain' : 'cover'} />
            )}
            {playing && it.kind === 'gif' && <img className="live" src={mediaUrl(it.id)} alt="" draggable={false} />}
            {props.faceBoxes && place && (it.kind === 'image' || it.kind === 'gif') && props.faces?.get(it.id)?.map((f) => {
              const known = f.person != null;
              const name = known ? props.personName?.(f.person!) : undefined;
              const small = b.w < 120;
              const left = place.ox + f.x * place.dw;
              const top = place.oy + f.y * place.dh;
              return (
                <span key={f.id} className={`tile-face${known ? '' : ' unknown'}${small ? ' small' : ''}`} aria-hidden="true"
                  style={{ left, top, width: f.w * place.dw, height: f.h * place.dh }}>
                  {(known ? name : !small) && <span className="tile-face-tag">{known ? name : '?'}</span>}
                </span>
              );
            })}
            {props.hoverInfo && (
              <span className="tile-info" aria-hidden="true">
                <span className="ellipsis">{it.name}</span>
                <span className="faint">{[it.width && it.height ? `${it.width}×${it.height}` : '', formatBytes(it.size)].filter(Boolean).join(' · ')}</span>
              </span>
            )}
            {it.linked && <span className="linked" title={it.copyOf != null ? 'A free copy (shares the original’s stored file)' : 'Has free copies'}>⧉</span>}
            {sel && <span className="tick" aria-hidden="true">✓</span>}
            {it.favourite && <span className="fav" aria-label="Favourite"><HeartIcon filled size={15} /></span>}
            {it.weight !== 1 && <span className="wt" title={`Weight ${it.weight}`}>×{it.weight}</span>}
            {it.kind === 'video' && <span className="badge">{formatTime(it.durationMs) || 'VIDEO'}</span>}
            {watched != null && <span className="tile-progress" title={`Watched ${Math.round(watched * 100)}%`}><span style={{ width: `${watched * 100}%` }} /></span>}
            {it.kind === 'gif' && <span className="badge">GIF</span>}
            {it.kind === 'pdf' && <span className="badge">PDF</span>}
            {it.kind === 'text' && <span className="badge">{it.ext.toUpperCase()}</span>}
          </button>
        );
      })}
      {pop && (
        <div className="whole-pop" style={{ left: pop.left, top: pop.top, width: pop.w, height: pop.h }} aria-hidden="true">
          {pop.item.kind === 'video'
            ? <>
                <img src={itemThumbUrl(pop.item)} alt="" draggable={false} />
                <VideoPreview key={pop.item.id} id={pop.item.id} layer="real" eager hasStrip={hasStrip(pop.item)} hasTiny={hasTiny(pop.item)} durationMs={pop.item.durationMs}
                  w={pop.w} h={pop.h} aspect={pop.w / pop.h} fit="contain" />
              </>
            : <img key={pop.item.id} src={mediaUrl(pop.item.id)} alt="" draggable={false} />}
        </div>
      )}
    </div>
  );
}

// ---- instant colour sketches and queued thumbnails (sketch.ts, loadqueue.ts) -------------

/** The tile's background until its thumbnail is in: the item's colour sketch, softly stretched. */
function sketchStyle(it: Item, place: { px: number; py: number } | null): React.CSSProperties | undefined {
  const url = it.thumb === 'ok' ? sketchUrl(it.sketch) : null;
  if (!url) return undefined;
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: 'cover',
    backgroundPosition: place ? `${place.px * 100}% ${place.py * 100}%` : 'center',
  };
}

/** Tiles off screen wait this long (ms, while the scroll stays put) before they ask for their thumbnail. */
const PREFETCH_WAIT_MS = 90;

/**
 * A tile's thumbnail address: the small (256 px) one when that is sharp
 * enough for the tile at this screen's pixel density, else the big one;
 * versioned by the stored thumbnail (and by `remade`, a count of remakes
 * seen while this grid shows), so a new thumbnail is a new address.
 */
function tileThumbUrl(it: Item, w: number, h: number, remade: number | undefined): string {
  const v = `${it.thumbV ?? ''}${remade ? `.${remade}` : ''}`;
  return thumbUrl(it.id, v, smallEnough(w, h, it.width, it.height));
}

/**
 * A grid thumbnail that waits for its turn (loadqueue.ts: on screen first,
 * then where the scroll is heading), then fades in over the sketch. Fetched
 * by hand (cancellable: a tile scrolled away stops its load, and a tile far
 * off screen gives its place to one on screen) and kept in memory
 * (thumbcache.ts), so it shows at once when it comes back.
 */
function QueuedThumb(props: { url: string; prio: number; flinging?: boolean; style?: React.CSSProperties }) {
  const { url, prio } = props;
  // Fetched before (this grid or another): straight away, no fade.
  const [first] = useState(() => thumbCache.peek(url));
  const [src, setSrc] = useState<string | null>(first);
  /** This tile counts as a user of the kept copy (so it isn't let go while shown). */
  const held = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    if (src) return;
    const ask = () => thumbQueue.want(url, prio, (signal) => {
      thumbCache.load(url, signal, prio < ON_SCREEN ? 'high' : 'low').then(
        (blobUrl) => {
          thumbQueue.done(url);
          if (!alive.current) {
            thumbCache.release(url);
            return;
          }
          held.current = true;
          setSrc(blobUrl);
        },
        () => {
          // Cancelled: it is asked for again when its turn comes back (or the tile is gone).
          if (signal.aborted) return;
          thumbQueue.done(url);
          // Couldn't fetch it by hand: let the picture load it itself.
          if (alive.current) setSrc(url);
        },
      );
    });
    // On screen, or already in line (a new priority): now. Other tiles join the
    // line only once the scroll lets them stay a moment (while flinging, tiles
    // on screen too), so a fling doesn't start, and then cancel, loads for
    // every row it flies past.
    if ((prio < ON_SCREEN && !props.flinging) || thumbQueue.has(url)) {
      ask();
      return;
    }
    const t = setTimeout(ask, PREFETCH_WAIT_MS);
    return () => clearTimeout(t);
  }, [url, prio, src, props.flinging]);
  // (A new address is a new component: the caller keys it by address.)
  useEffect(() => {
    alive.current = true;
    if (src && !held.current) {
      // Shown from memory: hold on to it (or, if it was let go meanwhile, load it again).
      if (thumbCache.take(url)) held.current = true;
      else setSrc(null);
    }
    return () => {
      alive.current = false;
      thumbQueue.drop(url);
      if (held.current) thumbCache.release(url);
      held.current = false;
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!src) return null;
  return (
    <img className={first ? 'thumb in' : 'thumb'} src={src} alt="" draggable={false} style={props.style} decoding="async"
      fetchPriority={prio < ON_SCREEN ? 'high' : 'low'}
      ref={(el) => {
        if (el?.complete && el.naturalWidth > 0) el.classList.add('in');
      }}
      onLoad={(e) => e.currentTarget.classList.add('in')} />
  );
}

