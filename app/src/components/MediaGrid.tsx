// Thumbnail grid that only draws the tiles on screen, so 10,000+ items scroll
// smoothly. Click to select (Ctrl/Shift for more), double-click to open, and
// drag a selection onto any folder to move it there.
//
// Layouts: equal tiles ("grid") or every item at its true shape ("shape"),
// optionally in groups with a header (the timeline's months).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mediaUrl, previewUrl, thumbUrl, type Item } from '../api';
import {
  clipFpsChanged, onPreviewMade, playClip, preferPreviews, setWantedVideos, stopClip, unwatchVideo, usePreviewMode, watchVideo,
} from '../previews';
import { layoutGrid, visibleRange, type Group, HEADER_H, GAP } from '../gridlayout';
import { startMoveDrag } from '../dragmove';
import { formatTime, onThumb } from '../media';
import { BrokenIcon, HeartIcon } from './Icons';

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
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState({ top: 0, bottom: 1200 });
  const [ready, setReady] = useState<Set<number>>(new Set());
  const mode = props.layout ?? 'grid';

  useEffect(() => onThumb((id) => setReady((r) => new Set(r).add(id))), []);
  const clipMode = usePreviewMode();
  const [made, setMade] = useState<Set<number>>(new Set());
  useEffect(() => onPreviewMade((id) => setMade((m) => new Set(m).add(id))), []);
  useEffect(() => clipFpsChanged(), [clipMode.fps]);

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
    [props.items, width, props.columns, mode, props.groups],
  );

  useEffect(() => {
    const sc = props.scroller.current;
    const el = ref.current;
    if (!sc || !el) return;
    const update = () => {
      const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const t = sc.scrollTop - top;
      setView({ top: t, bottom: t + sc.clientHeight });
    };
    update();
    sc.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      sc.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [props.scroller, layout]);

  // Bring an item into view (only scrolls if it isn't already visible).
  const bringIntoView = (i: number, centre = false) => {
    const sc = props.scroller.current;
    const el = ref.current;
    const b = layout.boxes[i];
    if (!sc || !el || !b) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const y0 = top + b.y;
    const y1 = y0 + b.h;
    if (y0 < sc.scrollTop + 8) sc.scrollTop = centre ? y0 - sc.clientHeight / 3 : y0 - 8;
    else if (y1 > sc.scrollTop + sc.clientHeight - 8) sc.scrollTop = centre ? y0 - sc.clientHeight / 3 : y1 - sc.clientHeight + 8;
  };
  const [flashId, setFlashId] = useState<number | null>(null);
  useEffect(() => {
    if (!props.reveal) return;
    const i = props.items.findIndex((x) => x.id === props.reveal!.id);
    if (i < 0) return;
    // After the scroll position has been restored.
    const t = setTimeout(() => {
      bringIntoView(i, true);
      setFlashId(props.reveal!.id);
      props.onCursor?.(props.reveal!.id);
      props.onSelect(new Set([props.reveal!.id]), props.reveal!.id, false);
    }, 200);
    const t2 = setTimeout(() => setFlashId(null), 2200);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [props.reveal?.n, props.items.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

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
      let cur = p.cursor != null && p.selected.has(p.cursor) ? p.items.findIndex((x) => x.id === p.cursor) : -1;
      if (cur < 0 && p.selected.size) cur = p.items.findIndex((x) => p.selected.has(x.id));
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
      p.onCursor?.(id);
      const a = e.shiftKey && p.anchor != null ? p.items.findIndex((x) => x.id === p.anchor) : -1;
      if (a >= 0) {
        const [lo, hi] = a < next ? [a, next] : [next, a];
        p.onSelect(new Set(p.items.slice(lo, hi + 1).map((x) => x.id)), p.anchor, true);
      } else {
        p.onSelect(new Set([id]), id, false);
      }
      bringIntoView(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [from, to] = visibleRange(layout.boxes, view.top - 600, view.bottom + 600);
  // Only tiles really on screen play; the rest just show their thumbnail.
  const onScreen = (i: number) => {
    const b = layout.boxes[i];
    return b.y + b.h > view.top && b.y < view.bottom;
  };
  const liveVideos: Item[] = [];
  for (let i = from; i < to; i++) {
    const it = props.items[i];
    if (it.kind === 'video' && onScreen(i) && live(it, props.preview, hover)) liveVideos.push(it);
  }
  const hasPreview = (it: Item) => it.preview || made.has(it.id);
  const wantKey = liveVideos.map((x) => x.id).join(',');
  useEffect(() => {
    setWantedVideos(liveVideos.length);
    if (clipMode.clips) preferPreviews(liveVideos.filter((x) => !hasPreview(x)).map((x) => x.id));
  }, [wantKey, clipMode.clips]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setWantedVideos(0), []);

  const click = (e: React.MouseEvent, item: Item, i: number) => {
    const sel = new Set(props.selected);
    if (e.shiftKey && props.anchor != null) {
      const a = props.items.findIndex((x) => x.id === props.anchor);
      if (a >= 0) {
        const [lo, hi] = a < i ? [a, i] : [i, a];
        if (!(e.ctrlKey || e.metaKey)) sel.clear();
        for (let k = lo; k <= hi; k++) sel.add(props.items[k].id);
        props.onSelect(sel, props.anchor, true);
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      if (sel.has(item.id)) sel.delete(item.id);
      else sel.add(item.id);
    } else {
      sel.clear();
      sel.add(item.id);
    }
    props.onSelect(sel, item.id, e.ctrlKey || e.metaKey);
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

  return (
    <div ref={ref} className={`mgrid${mode === 'shape' ? ' shape' : ''}`} style={{ height: layout.height }} role="grid" aria-label="Media">
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
        const asClip = playing && it.kind === 'video' && clipMode.clips;
        return (
          <button key={it.id} type="button" role="gridcell" aria-selected={sel} title={it.name}
            className={`tile${sel ? ' sel' : ''}${it.kind === 'pdf' || it.kind === 'text' ? ' doc' : ''}${flashId === it.id ? ' flash' : ''}`}
            style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            onClick={(e) => { click(e, it, i); props.onCursor?.(it.id); }} onDoubleClick={() => props.onOpen(it)}
            onKeyDown={(e) => e.key === 'Enter' && props.onOpen(it)} onPointerDown={(e) => startDrag(e, it)}
            onContextMenu={(e) => {
              e.preventDefault();
              props.onContext(e, it);
            }}
            onPointerEnter={() => setHover(it.id)} onPointerLeave={() => setHover((h) => (h === it.id ? null : h))}>
            {hasThumb && it.thumb !== 'failed' ? (
              <img src={`${thumbUrl(it.id)}?v=${ready.has(it.id) ? 1 : 0}`} alt="" loading="lazy" draggable={false} />
            ) : it.thumb === 'failed' ? (
              <span className="tile-msg"><BrokenIcon /> Can't play</span>
            ) : (
              <span className="tile-msg"><span className="spinner small" /></span>
            )}
            {playing && it.kind === 'video' && !asClip && (
              <video className="live" src={mediaUrl(it.id)} muted loop autoPlay playsInline preload="auto"
                ref={(v) => {
                  watchVideo(v);
                  return () => { if (v) unwatchVideo(v); };
                }} />
            )}
            {asClip && hasPreview(it) && <Clip id={it.id} w={b.w} h={b.h} aspect={it.width && it.height ? it.width / it.height : b.w / b.h} />}
            {playing && it.kind === 'gif' && <img className="live" src={mediaUrl(it.id)} alt="" draggable={false} />}
            {sel && <span className="tick" aria-hidden="true">✓</span>}
            {it.favourite && <span className="fav" aria-label="Favourite"><HeartIcon filled size={15} /></span>}
            {it.weight !== 1 && <span className="wt" title={`Weight ${it.weight}`}>×{it.weight}</span>}
            {it.kind === 'video' && <span className="badge">{formatTime(it.durationMs) || 'VIDEO'}</span>}
            {it.kind === 'gif' && <span className="badge">GIF</span>}
            {it.kind === 'pdf' && <span className="badge">PDF</span>}
            {it.kind === 'text' && <span className="badge">{it.ext.toUpperCase()}</span>}
          </button>
        );
      })}
      {pop && (
        <div className="whole-pop" style={{ left: pop.left, top: pop.top, width: pop.w, height: pop.h }} aria-hidden="true">
          {pop.item.kind === 'video' && clipMode.clips
            ? (hasPreview(pop.item) ? <Clip key={pop.item.id} id={pop.item.id} w={pop.w} h={pop.h} aspect={pop.w / pop.h} /> : <img src={thumbUrl(pop.item.id)} alt="" draggable={false} />)
            : pop.item.kind === 'video'
            ? <video key={pop.item.id} src={mediaUrl(pop.item.id)} muted loop autoPlay playsInline preload="auto" />
            : <img key={pop.item.id} src={mediaUrl(pop.item.id)} alt="" draggable={false} />}
        </div>
      )}
    </div>
  );
}

/** A preview clip: one picture holding 48 small frames, moved by a shared timer. */
function Clip(props: { id: number; w: number; h: number; aspect: number }) {
  // Cover the tile like the video would (centre, edges cropped).
  const w = Math.max(props.w, props.h * props.aspect);
  const h = w / props.aspect;
  return (
    <span className="live clip-frame" aria-hidden="true">
      <span className="clip" style={{ width: w, height: h, left: (props.w - w) / 2, top: (props.h - h) / 2, backgroundImage: `url("${previewUrl(props.id)}")` }}
        ref={(el) => {
          playClip(el);
          return () => { if (el) stopClip(el); };
        }} />
    </span>
  );
}
