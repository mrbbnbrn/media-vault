// Quick look: a big preview over the grid without leaving it.
// Space or Esc closes, ←/→ go to the neighbours, Enter opens the viewer,
// F favourites, Delete moves it to the trash (like in the library), Ctrl+Z undoes.
// Still pictures come from the viewer's decoded pictures (picturecache.ts): the
// neighbours are decoded ahead, so ←/→ show at once, and Enter opens the full
// viewer without waiting either.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mediaUrl, thumbUrl, type Item } from '../api';
import { useViewerPrefs } from '../prefs';
import { cachedPicture, holdPicture, loadPicture, preloadPictures, viewerOpened, type Picture } from '../picturecache';
import { peekUndo } from '../undo';
import { ArrowIcon, CloseIcon, FolderIcon, HeartIcon, PlayIcon } from './Icons';
import { globalKey, useLayer } from '../keylayers';

/** How many neighbours on each side are made ready ahead. */
const AHEAD = 2;

export function QuickLook(props: {
  items: Item[];
  id: number;
  onClose: () => void;
  onMove: (id: number) => void;
  onOpen: (item: Item) => void;
  onShowFolder?: (item: Item) => void;
  /** F: favourite on / off. */
  onFavourite?: (item: Item) => void;
  /** Delete: to the trash, the same way as in the library (`next`: what to show instead). */
  onDelete?: (item: Item, next: Item | null) => void;
  /** Ctrl+Z: the library's undo. */
  onUndo?: () => void;
}) {
  const i = Math.max(0, props.items.findIndex((x) => x.id === props.id));
  const it = props.items[i];
  const prefs = useViewerPrefs();
  const video = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const state = useRef({ props, i, setNote });
  state.current = { props, i, setNote };

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2200);
    return () => clearTimeout(t);
  }, [note]);

  // A layer (keylayers.ts): the grid underneath gets no keys (Ctrl ones neither); back closes it.
  const layer = useLayer(true, { name: 'quick look', onBack: () => state.current.props.onClose() });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!layer.mine()) return;
      const { props: p, i: at, setNote: say } = state.current;
      const k = e.key;
      const cur = p.items[at];
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      if (k === ' ' || k === 'Escape' || k === 'Backspace') p.onClose();
      else if (k === 'ArrowRight' && at < p.items.length - 1) p.onMove(p.items[at + 1].id);
      else if (k === 'ArrowLeft' && at > 0) p.onMove(p.items[at - 1].id);
      else if (k === 'Enter') p.onOpen(cur);
      else if ((k === 'f' || k === 'F') && plain && cur && p.onFavourite) {
        p.onFavourite(cur);
        say(cur.favourite ? 'Removed from favourites · Ctrl+Z undoes it' : 'Added to favourites · Ctrl+Z undoes it');
      } else if (k === 'Delete' && plain && !e.shiftKey && cur && p.onDelete) {
        p.onDelete(cur, p.items[at + 1] ?? p.items[at - 1] ?? null);
        say('Moved to the trash · Ctrl+Z undoes it');
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k.toLowerCase() === 'z' && p.onUndo) {
        const top = peekUndo();
        p.onUndo();
        say(top ? `Undone: ${top.label}` : 'Nothing to undo');
      } else {
        // Everything else stays inside quick look (the grid underneath doesn't react), except the app's own keys.
        if (!globalKey(e)) e.stopImmediatePropagation();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    const v = video.current;
    if (v) {
      v.muted = prefs.muted;
      v.volume = Math.max(0, Math.min(1, prefs.soundVolume));
    }
  }, [it?.id, prefs.muted, prefs.soundVolume]);

  // ---- the neighbours, ready ahead ----
  // Decoded pictures are kept a little while after quick look closes (picturecache.ts), so
  // Enter (the full viewer) shows them at once too.
  useEffect(() => viewerOpened(), []);
  useEffect(() => {
    if (!it) return;
    const t = setTimeout(() => {
      const near: Item[] = [];
      for (let d = 1; d <= AHEAD; d++) {
        const a = props.items[i + d];
        const b = props.items[i - d];
        if (a) near.push(a);
        if (b) near.push(b);
      }
      // Still pictures only (GIFs play as they are).
      const pics = near.filter((x) => x.kind === 'image');
      preloadPictures(pics.map((x) => ({ src: mediaUrl(x.id), kind: x.kind, size: sizeOf(x) })));
    }, 60);
    return () => clearTimeout(t);
  }, [it?.id, props.items]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!it) return null;
  return (
    <div className="qlook" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="qlook-stage" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
        {it.kind === 'video' ? (
          <video key={it.id} ref={video} src={mediaUrl(it.id)} autoPlay loop controls playsInline />
        ) : it.kind === 'image' ? (
          <QuickPicture key={it.id} item={it} />
        ) : it.kind === 'gif' ? (
          <img key={it.id} src={mediaUrl(it.id)} alt={it.name} draggable={false} />
        ) : (
          <img key={it.id} src={thumbUrl(it.id)} alt={it.name} draggable={false} />
        )}
        {note && <div className="qlook-note" role="status">{note}</div>}
      </div>
      <div className="qlook-bar">
        <button type="button" className="btn btn-icon btn-sm" aria-label="Previous" disabled={i === 0} onClick={() => props.onMove(props.items[i - 1].id)}><ArrowIcon /></button>
        <span className="ellipsis"><b>{it.name}</b> <span className="faint">{i + 1} of {props.items.length}</span></span>
        <button type="button" className="btn btn-icon btn-sm" aria-label="Next" disabled={i >= props.items.length - 1} onClick={() => props.onMove(props.items[i + 1].id)}><ArrowIcon dir="right" /></button>
        <span style={{ flex: 1 }} />
        {props.onFavourite && (
          <button type="button" className={`btn btn-icon btn-sm${it.favourite ? ' accent' : ''}`} aria-pressed={it.favourite}
            aria-label={it.favourite ? 'Remove from favourites (F)' : 'Add to favourites (F)'} title={it.favourite ? 'Remove from favourites (F)' : 'Add to favourites (F)'}
            onClick={() => {
              props.onFavourite?.(it);
              setNote(it.favourite ? 'Removed from favourites · Ctrl+Z undoes it' : 'Added to favourites · Ctrl+Z undoes it');
            }}><HeartIcon filled={it.favourite} size={14} /></button>
        )}
        {props.onShowFolder && (
          <button type="button" className="btn btn-sm" onClick={() => props.onShowFolder?.(it)}><FolderIcon size={14} /> Show in folder</button>
        )}
        <button type="button" className="btn btn-sm btn-primary" title="Enter" onClick={() => props.onOpen(it)}><PlayIcon size={13} /> Open</button>
        <button type="button" className="btn btn-icon btn-sm" aria-label="Close (Space or Esc)" title="Close (Space or Esc)" onClick={props.onClose}><CloseIcon size={13} /></button>
      </div>
    </div>
  );
}

const sizeOf = (x: Item) => (x.width && x.height ? { w: x.width, h: x.height } : null);

/** A still picture, drawn from the decoded pictures (the thumbnail shows until it is ready). */
function QuickPicture({ item }: { item: Item }) {
  const src = mediaUrl(item.id);
  const [pic, setPic] = useState<Picture | null>(() => {
    const c = cachedPicture(src);
    return c && !('gif' in c) ? c : null;
  });
  const [failed, setFailed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let live = true;
    // Kept while it is on screen.
    const release = holdPicture(src);
    loadPicture(src, 'image', sizeOf(item)).then(
      (v) => live && ('gif' in v ? setFailed(true) : setPic(v)),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      release();
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !pic) return;
    c.width = pic.bmp.width;
    c.height = pic.bmp.height;
    c.getContext('2d')?.drawImage(pic.bmp, 0, 0);
  }, [pic]);
  // Couldn't be decoded here: the browser tries it as an ordinary picture.
  if (failed) return <img src={src} alt={item.name} draggable={false} />;
  if (!pic) return <img src={thumbUrl(item.id)} alt={item.name} draggable={false} className="qlook-wait" />;
  return <canvas ref={canvas} role="img" aria-label={item.name} />;
}
