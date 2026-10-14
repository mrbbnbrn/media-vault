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
  onSelect: (sel: Set<number>, anchor: number | null) => void;
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
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [view, setView] = useState({ top: 0, bottom: 1200 });
  const [ready, setReady] = useState<Set<number>>(new Set());
  const [drag, setDrag] = useState<{ x: number; y: number; n: number; over: string | null } | null>(null);
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
        props.onSelect(sel, props.anchor);
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
    props.onSelect(sel, item.id);
  };

  // Pointer-based dragging (works the same with files dropped from Windows enabled).
  const startDrag = (e: React.PointerEvent, item: Item) => {
    if (e.button !== 0 || !props.onDropOnFolder) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let over: HTMLElement | null = null;
    const ids = props.selected.has(item.id) ? [...props.selected] : [item.id];
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 7) return;
      active = true;
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-drop^="folder:"]') ?? null;
      if (el !== over) {
        over?.classList.remove('drop-over');
        el?.classList.add('drop-over');
        over = el;
      }
      setDrag({ x: ev.clientX, y: ev.clientY, n: ids.length, over: el?.dataset.drop ?? null });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      over?.classList.remove('drop-over');
      setDrag(null);
      if (active && over?.dataset.drop) props.onDropOnFolder?.(ids, over.dataset.drop);
      if (active) {
        // Don't treat the end of a drag as a click.
        const block = (ce: MouseEvent) => {
          ce.stopPropagation();
          ce.preventDefault();
        };
        window.addEventListener('click', block, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', block, { capture: true }), 50);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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
            className={`tile${sel ? ' sel' : ''}${it.kind === 'pdf' || it.kind === 'text' ? ' doc' : ''}`}
            style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            onClick={(e) => click(e, it, i)} onDoubleClick={() => props.onOpen(it)}
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
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>
          {drag.over ? `Move ${drag.n} item${drag.n > 1 ? 's' : ''} here` : `${drag.n} item${drag.n > 1 ? 's' : ''}`}
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
